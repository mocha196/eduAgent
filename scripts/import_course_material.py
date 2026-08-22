r"""
Import pre-parsed MinerU content_list.json files as a course material.

Mirrors the worker pipeline (UPLOADED->PARSING->PARSED->INDEXING->READY) without re-running MinerU.

Usage (run from project root):
  python scripts/import_course_material.py
    --pdf "E:/path/to/book_part1.pdf"
    --content-list "output/parsed/part1_content_list.json"
    --content-list "output/parsed/part2_content_list.json"
    --course "计算机网络"
    --username teacher --password "111111Aa"

Options:
  --text-only     Only embed text (skip images/tables).  Default: False
  --dry-run       Show plan and exit without doing anything
  --material-id   Reuse a specific UUID (for retrying a partially-run import)
  --server        API base URL (default: http://localhost:3000)
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: load .env files and extend sys.path before any rag_mvp imports
# ---------------------------------------------------------------------------
_ROOT = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(_ROOT / "src"))

try:
    from dotenv import load_dotenv
    load_dotenv(_ROOT / ".env")
    load_dotenv(_ROOT / "edu-platform" / ".env", override=False)
except ImportError:
    pass  # dotenv not installed — rely on OS env

import psycopg
import requests
from loguru import logger


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _api_login(server: str, username: str, password: str) -> str:
    resp = requests.post(
        f"{server}/api/v1/login",
        json={"username": username, "password": password},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("token") or data.get("accessToken") or data.get("access_token")
    if not token:
        raise RuntimeError(f"Login response has no token field: {list(data.keys())}")
    logger.info("Logged in as {}", username)
    return str(token)


def _api_get_courses(server: str, token: str) -> list[dict]:
    resp = requests.get(
        f"{server}/api/v1/courses",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, list):
        return data
    return data.get("courses") or data.get("data") or []


def _find_course_id(server: str, token: str, course_name: str) -> str:
    courses = _api_get_courses(server, token)
    for c in courses:
        name = c.get("name") or c.get("title") or ""
        if name == course_name:
            cid = c.get("id") or c.get("courseId")
            logger.info("Found course '{}' -> {}", course_name, cid)
            return str(cid)
    names = [c.get("name") or c.get("title") for c in courses]
    raise RuntimeError(f"Course '{course_name}' not found. Available: {names}")


# ---------------------------------------------------------------------------
# MinIO / S3 helpers
# ---------------------------------------------------------------------------

def _s3_client():
    import boto3
    from botocore.config import Config as BotocoreConfig

    endpoint = os.environ["MINIO_ENDPOINT"].strip()
    if not endpoint.startswith("http"):
        use_ssl = os.environ.get("MINIO_USE_SSL", "false").lower() == "true"
        endpoint = ("https://" if use_ssl else "http://") + endpoint
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["MINIO_ACCESS_KEY"].strip(),
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"].strip(),
        region_name=os.environ.get("MINIO_REGION", "us-east-1").strip(),
        config=BotocoreConfig(proxies={}),  # skip system proxy (e.g. Clash)
    )


def _bucket() -> str:
    return os.environ["MINIO_BUCKET"].strip()


def _upload_pdf_to_minio(pdf_path: Path, course_id: str, material_id: str) -> str:
    """Upload PDF + preview copy; return the minio_path key."""
    client = _s3_client()
    bucket = _bucket()
    safe_name = pdf_path.name.replace(" ", "_")
    material_key = f"materials/{course_id}/{material_id}/{safe_name}"
    preview_key = f"materials/{course_id}/{material_id}/preview.pdf"

    logger.info("Uploading PDF -> {}", material_key)
    client.upload_file(str(pdf_path), bucket, material_key)
    logger.info("Uploading preview PDF -> {}", preview_key)
    client.upload_file(str(pdf_path), bucket, preview_key)
    return material_key


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _db_connect() -> psycopg.Connection:
    url = os.environ["DATABASE_URL"].replace("?schema=public", "")
    return psycopg.connect(url)


def _create_material_record(
    conn: psycopg.Connection,
    material_id: str,
    course_id: str,
    original_filename: str,
    file_size: int,
    minio_path: str,
) -> None:
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO materials
                  (id, course_id, original_filename, file_type, file_size,
                   minio_path, status, preview_pdf_status,
                   created_at, updated_at, is_deleted)
                VALUES
                  (%s::uuid, %s::uuid, %s, 'pdf', %s, %s,
                   'UPLOADED', 'READY',
                   NOW(), NOW(), false)
                """,
                (material_id, course_id, original_filename, file_size, minio_path),
            )
    logger.info("Created materials record {}", material_id)


# ---------------------------------------------------------------------------
# Stage content_list files into expected scan directory
# ---------------------------------------------------------------------------

def _stage_content_lists(material_id: str, content_list_paths: list[Path], output_dir: Path) -> Path:
    """Copy content_list files into output_dir/{material_id}/part_NNNN/ sub-dirs."""
    dest_base = output_dir / material_id
    dest_base.mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(content_list_paths, start=1):
        part_dir = dest_base / f"part_{i:04d}"
        part_dir.mkdir(parents=True, exist_ok=True)
        dest = part_dir / f"{material_id}_part{i:04d}_content_list.json"
        shutil.copy2(src, dest)
        logger.info("Staged part {} -> {}", i, dest)
    return dest_base


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import pre-parsed MinerU content_list.json files as a course material",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--pdf", required=True, help="Path to the PDF (used for preview in UI)")
    parser.add_argument(
        "--content-list", action="append", dest="content_lists", required=True,
        metavar="FILE",
        help="Path to a *_content_list.json file (repeat for each part)",
    )
    parser.add_argument("--course", required=True, help="Exact course name (e.g. 计算机网络)")
    parser.add_argument("--course-id", default=None, help="Skip course lookup; supply UUID directly")
    parser.add_argument("--username", default="teacher")
    parser.add_argument("--password", default="111111Aa")
    parser.add_argument("--server", default="http://localhost:3000")
    parser.add_argument("--text-only", action="store_true", default=False)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--material-id", default=None,
        help="Reuse a specific UUID. Use together with --resume to retry a failed import.",
    )
    parser.add_argument(
        "--resume", action="store_true", default=False,
        help=(
            "Resume a previously-started import: skip MinIO upload and DB record creation, "
            "reset status to INDEXING, then re-run ingest. Must be paired with --material-id."
        ),
    )
    args = parser.parse_args()

    if args.resume and not args.material_id:
        logger.error("--resume requires --material-id <UUID>")
        sys.exit(1)

    pdf_path = Path(args.pdf).resolve()
    if not pdf_path.exists():
        logger.error("PDF not found: {}", pdf_path)
        sys.exit(1)

    content_list_paths = [Path(p).resolve() for p in args.content_lists]
    missing = [p for p in content_list_paths if not p.exists()]
    if missing:
        logger.error("content_list files not found: {}", missing)
        sys.exit(1)

    # Auth + course discovery
    token = _api_login(args.server, args.username, args.password)
    if args.course_id:
        course_id = args.course_id
        logger.info("Using supplied course_id: {}", course_id)
    else:
        course_id = _find_course_id(args.server, token, args.course)

    material_id = args.material_id or str(uuid.uuid4())
    original_filename = pdf_path.name
    file_size = pdf_path.stat().st_size

    logger.info("=" * 60)
    logger.info("material_id      = {}  <-- save this for --resume if needed", material_id)
    logger.info("course_id        = {}", course_id)
    logger.info("resume           = {}", args.resume)
    logger.info("PDF              = {}", pdf_path.name)
    logger.info("content_lists    = {} file(s)", len(content_list_paths))
    logger.info("text_only        = {}", args.text_only)
    logger.info("=" * 60)

    if args.dry_run:
        logger.info("--dry-run: stopping here (no changes made)")
        return

    # Delayed imports so --dry-run works without full rag_mvp initialisation
    from rag_mvp.config import settings
    from rag_mvp.engine import ingest_parsed_material_into_course_sync
    from rag_mvp.material_processor import (
        _record_chunk_page_mappings,
        _upload_material_images_to_minio,
        update_material_status,
    )

    # We use pre-parsed content-list files, so no document parser is needed.

    conn = _db_connect()
    dest_base = settings.output_dir / material_id

    try:
        if args.resume:
            # ----------------------------------------------------------------
            # RESUME MODE: skip MinIO/DB creation, just reset status + re-stage
            # ----------------------------------------------------------------
            logger.info("Resume mode: resetting material {} to INDEXING ...", material_id)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE materials SET status = 'INDEXING', updated_at = NOW() "
                    "WHERE id = %s::uuid AND is_deleted = false",
                    [material_id],
                )
                if (cur.rowcount or 0) == 0:
                    raise RuntimeError(
                        f"Material {material_id} not found in DB. "
                        "Run without --resume to create it first."
                    )
            conn.commit()
        else:
            # ----------------------------------------------------------------
            # NORMAL MODE: upload PDF, create DB record, upload images
            # ----------------------------------------------------------------
            minio_path = _upload_pdf_to_minio(pdf_path, course_id, material_id)
            _create_material_record(conn, material_id, course_id, original_filename, file_size, minio_path)

            # Stage all content_list files so _upload_material_images_to_minio can scan them
            dest_base.mkdir(parents=True, exist_ok=True)
            _stage_content_lists(material_id, content_list_paths, settings.output_dir)
            dummy_local = dest_base / f"{material_id}.pdf"

            try:
                _upload_material_images_to_minio(material_id, dummy_local, conn)
            except Exception as exc:
                logger.warning("Image upload to MinIO (non-fatal): {}", exc)

            with conn.transaction():
                update_material_status(conn, material_id, "PARSING", expect_status_in=("UPLOADED",))
            with conn.transaction():
                update_material_status(conn, material_id, "PARSED", expect_status_in=("PARSING",))
            with conn.transaction():
                update_material_status(conn, material_id, "INDEXING", expect_status_in=("PARSED",))

            # Clear staged dirs; we'll re-stage one-by-one for per-part ingest below
            shutil.rmtree(dest_base, ignore_errors=True)
            dest_base.mkdir(parents=True, exist_ok=True)

        # ------------------------------------------------------------------
        # INGEST: stage ALL parts first, then call ingest once so the engine
        # sees all JSON files in a single scan and can process them together.
        # A single replace operation makes re-running idempotent.
        # ------------------------------------------------------------------
        dummy_local = dest_base / f"{material_id}.pdf"
        n_parts = len(content_list_paths)

        # Stage every part before the single ingest call
        for i, cl_path in enumerate(content_list_paths, start=1):
            part_dir = dest_base / f"part_{i:04d}"
            part_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cl_path, part_dir / f"{material_id}_part{i:04d}_content_list.json")
            logger.info("Staged [{}/{}]: {}", i, n_parts, cl_path.name)

        logger.info("Ingesting {} part(s) as one batch ...", n_parts)
        total_n = ingest_parsed_material_into_course_sync(
            course_id,
            material_id,
            dummy_local,
            original_filename=original_filename,
            text_only=args.text_only,
        )
        logger.success("Done: {} chunks total", total_n)

        # Re-stage all content_lists so chunk-page mappings cover every part
        shutil.rmtree(dest_base, ignore_errors=True)
        dest_base.mkdir(parents=True, exist_ok=True)
        _stage_content_lists(material_id, content_list_paths, settings.output_dir)

        try:
            _record_chunk_page_mappings(material_id, course_id, conn)
        except Exception as exc:
            logger.warning("chunk_page_mappings (non-fatal): {}", exc)

        with conn.transaction():
            ok = update_material_status(
                conn, material_id, "READY",
                indexed_chunk_count=total_n,
                expect_status_in=("INDEXING",),
            )
        if not ok:
            logger.warning("Status update to READY was a no-op (material may have been modified externally)")

        logger.success(
            "Done! material {} is READY ({} chunks total) in course '{}'",
            material_id, total_n, args.course,
        )

    except Exception:
        logger.exception("Import failed  (material_id={})", material_id)
        logger.error(
            "To retry the ingest step without re-uploading, run:\n"
            "  .venv\\Scripts\\python.exe scripts\\import_course_material.py "
            "--material-id {} --resume [same other args]",
            material_id,
        )
        shutil.rmtree(dest_base, ignore_errors=True)
        sys.exit(1)
    finally:
        conn.close()

    # Cleanup temp parse dir (mirrors worker behaviour)
    shutil.rmtree(dest_base, ignore_errors=True)


if __name__ == "__main__":
    main()
