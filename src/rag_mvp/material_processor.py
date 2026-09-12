"""Course material pipeline: MinIO → document parsing → PostgreSQL vector index.

If PostgreSQL reports ``another operation is in progress`` during indexing, try
lowering ``MAX_PARALLEL_INSERT`` or ``EMBEDDING_MAX_ASYNC`` in ``rag_mvp`` settings.

When ``edu-rag-worker`` has started the persistent async loop (``worker_async_loop``),
parse and ingest run on that loop.
Otherwise parse uses ``engine.parse_file`` (``asyncio.run``) and ingest uses sync wrappers.
PARSED / INDEXING commits remain on the main thread between parse and ingest.

After a successful PARSED commit, parse output under ``output_dir / material_id`` is kept if
indexing fails, so ``index_only`` Redis tasks can re-ingest on the same worker machine.
If that cache is missing (another worker, cleared disk), ``process_index_only`` falls back
to the same MinIO download → parse → ingest path as the initial job.

``edu-rag-worker`` ACKs stream messages after both success and failure (DB status may be
``FAILED``); retries use ``index_only`` or a new enqueue, not an unacked PEL retry.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import boto3
import psycopg
import redis
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError
from psycopg import sql

try:
    import requests as _requests
except ImportError:  # pragma: no cover
    _requests = None  # type: ignore[assignment]
from loguru import logger

from rag_mvp.config import settings
from rag_mvp.document_parser import parse_document
from rag_mvp.engine import (
    _invalidate_course_rag_cache_for,
    _invalidate_personal_rag_cache,
    delete_material_course_async,
    delete_material_course_sync,
    delete_material_personal_async,
    delete_material_personal_sync,
    ingest_parsed_material_into_course_async,
    ingest_parsed_material_into_course_sync,
    ingest_parsed_material_into_personal_async,
    ingest_parsed_material_into_personal_sync,
    ingest_text_into_course_async,
    ingest_text_into_course_sync,
    ingest_text_into_personal_async,
    ingest_text_into_personal_sync,
    parse_file,
)
from rag_mvp.parsed_document import has_parsed_document, load_parsed_document
from rag_mvp.worker_async_loop import is_worker_async_loop_started, run_worker_coroutine

try:
    import requests as _requests
except ImportError:  # pragma: no cover
    _requests = None  # type: ignore[assignment]


def _notify_nextjs(payload: dict) -> None:
    """Best-effort POST to the Next.js internal notification webhook."""
    if _requests is None:
        logger.warning("requests not installed; skipping internal notification")
        return
    base = os.environ.get("NEXTJS_INTERNAL_URL", "http://localhost:3000").rstrip("/")
    key = os.environ.get("INTERNAL_API_KEY", "")
    try:
        resp = _requests.post(
            f"{base}/api/v1/internal/notifications",
            json=payload,
            headers={"x-internal-key": key},
            timeout=5,
        )
        if not resp.ok:
            logger.warning("Internal notification HTTP {}: {}", resp.status_code, resp.text[:200])
    except Exception as exc:
        logger.warning("Internal notification failed (non-fatal): {}", exc)


def _s3_client():
    endpoint = os.environ["MINIO_ENDPOINT"].strip()
    if not endpoint.startswith("http"):
        use_ssl = os.environ.get("MINIO_USE_SSL", "true").lower() == "true"
        endpoint = ("https://" if use_ssl else "http://") + endpoint
    # Bypass any system HTTP proxy (e.g. Clash on 7890) for local MinIO connections.
    session = boto3.Session()
    return session.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["MINIO_ACCESS_KEY"].strip(),
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"].strip(),
        region_name=os.environ.get("MINIO_REGION", "us-east-1").strip(),
        config=BotocoreConfig(proxies={}),  # disable system proxy (e.g. Clash) for local MinIO
    )


def _bucket() -> str:
    return os.environ["MINIO_BUCKET"].strip()


async def _parse_material_file_async(local_file: Path) -> None:
    """Parse only, using the configured document parser provider."""
    logger.info("Parsing file: {}", local_file.name)
    await parse_document(local_file)


async def _ingest_parsed_material_worker_async(
    course_id: str,
    material_id: str,
    local_file: Path,
    original_filename: str | None,
    text_only: bool,
) -> int:
    """Ingest + same cache invalidation as ``ingest_parsed_material_into_course_sync``."""
    try:
        return await ingest_parsed_material_into_course_async(
            course_id,
            material_id,
            local_file,
            original_filename=original_filename,
            text_only=text_only,
        )
    finally:
        _invalidate_course_rag_cache_for(course_id)


async def _delete_material_course_worker_async(course_id: str, material_id: str) -> None:
    """Delete + same cache invalidation as ``delete_material_course_sync``."""
    try:
        await delete_material_course_async(course_id, material_id)
    finally:
        _invalidate_course_rag_cache_for(course_id)


def _parse_file_dispatch(local_file: Path) -> None:
    if is_worker_async_loop_started():
        run_worker_coroutine(_parse_material_file_async(local_file), timeout=None)
    else:
        parse_file(local_file)


def _ingest_parsed_dispatch(
    course_id: str,
    material_id: str,
    local_file: Path,
    original_filename: str | None,
    text_only: bool,
) -> int:
    if is_worker_async_loop_started():
        return run_worker_coroutine(
            _ingest_parsed_material_worker_async(
                course_id,
                material_id,
                local_file,
                original_filename,
                text_only,
            ),
            timeout=None,
        )
    return ingest_parsed_material_into_course_sync(
        course_id,
        material_id,
        local_file,
        original_filename=original_filename,
        text_only=text_only,
    )


def _ingest_text_dispatch(
    course_id: str,
    material_id: str,
    text: str,
    original_filename: str | None,
) -> int:
    async def _ingest_text_worker_async() -> int:
        return await ingest_text_into_course_async(
            course_id,
            material_id,
            text,
            original_filename=original_filename,
        )

    if is_worker_async_loop_started():
        return run_worker_coroutine(_ingest_text_worker_async(), timeout=None)
    return ingest_text_into_course_sync(
        course_id,
        material_id,
        text,
        original_filename=original_filename,
    )


def _delete_material_rag_dispatch(course_id: str, material_id: str) -> None:
    if is_worker_async_loop_started():
        run_worker_coroutine(
            _delete_material_course_worker_async(course_id, material_id),
            timeout=None,
        )
    else:
        delete_material_course_sync(course_id, material_id)


def download_object_to_path(minio_path: str, dest: Path) -> None:
    client = _s3_client()
    dest.parent.mkdir(parents=True, exist_ok=True)
    client.download_file(_bucket(), minio_path, str(dest))


def _material_stale_seconds() -> int:
    return int(os.environ.get("RAG_MATERIAL_STALE_SEC", "1800"))


def _rag_task_stream_name() -> str:
    return os.environ.get("RAG_TASK_STREAM_NAME", "edu:rag:tasks:stream").strip()


# ---------------------------------------------------------------------------
# Cancel-signal helpers (Option C: Redis key set by Next.js cancel API)
# ---------------------------------------------------------------------------

def _cancel_redis_key(material_id: str) -> str:
    """Key used by Next.js cancelMaterialProcessing() to interrupt the worker."""
    return f"edu:rag:cancel:{material_id}"


class MaterialCancelledError(Exception):
    """Raised when a cancel signal is detected during processing."""


def _is_cancel_requested(r: redis.Redis, material_id: str) -> bool:
    """Return True if the Next.js cancel API has set the interrupt key."""
    try:
        return bool(r.exists(_cancel_redis_key(material_id)))
    except Exception:
        # If Redis is unreachable we conservatively continue processing.
        return False


def _raise_if_cancelled(r: redis.Redis, material_id: str, checkpoint: str) -> None:
    """Raise MaterialCancelledError if a cancel signal is present."""
    if _is_cancel_requested(r, material_id):
        logger.info(
            "Cancel signal detected for material {} at checkpoint: {}",
            material_id,
            checkpoint,
        )
        raise MaterialCancelledError(f"Cancelled at {checkpoint}")


def _enqueue_parse_and_index_task(material_id: str, *, text_only: bool) -> None:
    """Chain Phase 2 after Office preview PDF is ready (same Redis Stream as Next.js)."""
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL is not set; cannot enqueue parse_and_index")
    r = redis.from_url(redis_url, decode_responses=True)
    r.xadd(
        _rag_task_stream_name(),
        {
            "task_id": str(uuid4()),
            "material_id": material_id,
            "operation": "parse_and_index",
            "created_at": datetime.now(UTC).isoformat(),
            "text_only": "true" if text_only else "false",
        },
    )


def _enqueue_convert_preview_task(material_id: str, *, text_only: bool) -> None:
    """Re-queue Phase 1 (e.g. compat for in-flight ``parse_and_index`` before Phase D)."""
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL is not set; cannot enqueue convert_preview")
    r = redis.from_url(redis_url, decode_responses=True)
    r.xadd(
        _rag_task_stream_name(),
        {
            "task_id": str(uuid4()),
            "material_id": material_id,
            "operation": "convert_preview",
            "created_at": datetime.now(UTC).isoformat(),
            "text_only": "true" if text_only else "false",
        },
    )


def _maybe_enqueue_convert_preview_for_stuck_office(
    conn: psycopg.Connection, material_id: str, *, text_only: bool
) -> None:
    """If ``parse_and_index`` cannot claim because Phase D blocks office+PENDING, re-queue Phase 1."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT LOWER(file_type::text), status::text, preview_pdf_status::text, minio_path::text
            FROM materials WHERE id = %s::uuid AND is_deleted = false
            """,
            (material_id,),
        )
        row = cur.fetchone()
    if not row:
        return
    ft, st, prev, minio_path = row[0], row[1], row[2], row[3]
    if ft not in _OFFICE_FT_LOWER or st != "UPLOADED" or prev != "PENDING":
        return

    preview_key = _preview_pdf_minio_key(minio_path)
    try:
        if _object_exists(preview_key):
            logger.warning(
                "parse_and_index: material {} preview object exists while status is office+PENDING; reconcile READY and enqueue parse",
                material_id,
            )
            with conn.transaction():
                update_material_preview_pdf_status(conn, material_id, "READY")
            _enqueue_parse_and_index_task(
                material_id,
                text_only=text_only,
            )
            return
    except Exception:
        logger.exception(
            "parse_and_index: preview existence check failed for material {}",
            material_id,
        )

    logger.warning(
        "parse_and_index: material {} is office+PENDING; enqueue convert_preview (compat)",
        material_id,
    )
    _enqueue_convert_preview_task(material_id, text_only=text_only)


_OFFICE_SUFFIXES = frozenset({".ppt", ".pptx", ".doc", ".docx"})
_OFFICE_FT_LOWER = frozenset({"ppt", "pptx", "doc", "docx"})


def _convert_to_pdf(local_file: Path, out_dir: Path) -> Path:
    """Convert PPT/PPTX/DOC/DOCX to PDF via LibreOffice (required by MinerU). Returns PDF path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "soffice",
            "--headless",
            "--convert-to", "pdf",
            "--outdir", str(out_dir),
            str(local_file),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"LibreOffice conversion failed (exit {result.returncode}): {result.stderr[:500]}"
        )
    pdf_path = out_dir / (local_file.stem + ".pdf")
    if not pdf_path.exists():
        raise RuntimeError(
            f"LibreOffice ran successfully but PDF not found at {pdf_path}. "
            f"stdout: {result.stdout[:300]}"
        )
    return pdf_path


def _upload_object(
    local_path: Path,
    minio_path: str,
    *,
    content_type: str | None = None,
) -> None:
    """Upload a local file to MinIO at the given object key."""
    client = _s3_client()
    kwargs: dict[str, Any] = {}
    if content_type:
        kwargs["ExtraArgs"] = {"ContentType": content_type}
    client.upload_file(str(local_path), _bucket(), minio_path, **kwargs)


def _object_exists(minio_path: str) -> bool:
    """Check whether an object exists in MinIO/S3 bucket."""
    client = _s3_client()
    try:
        client.head_object(Bucket=_bucket(), Key=minio_path)
        return True
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0) or 0)
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return False
        raise


def _upload_preview_pdf_with_verify(
    pdf_file: Path,
    preview_key: str,
    *,
    max_attempts: int = 3,
) -> None:
    """Upload preview PDF and verify readability before committing READY state."""
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            _upload_object(pdf_file, preview_key, content_type="application/pdf")
            if _object_exists(preview_key):
                return
            raise RuntimeError(
                f"Preview PDF uploaded but not visible in storage: {preview_key}",
            )
        except Exception as exc:
            last_error = exc if isinstance(exc, Exception) else Exception(str(exc))
            if attempt < max_attempts:
                logger.warning(
                    "Preview upload verify failed (attempt {}/{}): material preview_key={} err={}",
                    attempt,
                    max_attempts,
                    preview_key,
                    exc,
                )
                time.sleep(0.2 * attempt)
                continue
            break
    raise RuntimeError(
        f"Preview PDF upload verify failed after {max_attempts} attempts: {preview_key}",
    ) from last_error


def _preview_pdf_minio_key(minio_path: str) -> str:
    """Stable key for browser preview PDF (Office originals keep ``minio_path``).

    Always use POSIX/forward-slash separators so keys match across platforms.
    ``Path()`` on Windows would produce backslashes, creating a different MinIO key
    than what Node.js expects (which always uses forward slashes).
    """
    import posixpath
    normalised = minio_path.replace("\\", "/")
    return posixpath.join(posixpath.dirname(normalised), "preview.pdf")


def update_material_preview_pdf_status(
    conn: psycopg.Connection,
    material_id: str,
    status: str,
    status_message: str | None = None,
) -> None:
    """``status``: NA | PENDING | READY | FAILED (Prisma enum)."""
    with conn.cursor() as cur:
        if status_message is None:
            cur.execute(
                """
                UPDATE materials
                SET preview_pdf_status = %s::"MaterialPreviewPdfStatus",
                    updated_at = NOW()
                WHERE id = %s::uuid AND is_deleted = false
                """,
                (status, material_id),
            )
            return
        cur.execute(
            """
            UPDATE materials
            SET preview_pdf_status = %s::"MaterialPreviewPdfStatus",
                status_message = %s,
                updated_at = NOW()
            WHERE id = %s::uuid AND is_deleted = false
            """,
            (status, status_message, material_id),
        )


def update_material_status(
    conn: psycopg.Connection,
    material_id: str,
    status: str,
    status_message: str | None = None,
    indexed_chunk_count: int | None = None,
    *,
    expect_status_in: tuple[str, ...] | None = None,
) -> bool:
    """Return True if a row was updated (for idempotency)."""
    set_clauses: list[sql.Composable] = [sql.SQL("status = %s"), sql.SQL("updated_at = NOW()")]
    args: list[Any] = [status]
    if status_message is not None:
        set_clauses.append(sql.SQL("status_message = %s"))
        args.append(status_message)
    if indexed_chunk_count is not None:
        set_clauses.append(sql.SQL("indexed_chunk_count = %s"))
        args.append(indexed_chunk_count)
    args.append(material_id)
    where_clauses: list[sql.Composable] = [
        sql.SQL("id = %s::uuid"),
        sql.SQL("is_deleted = false"),
    ]
    if expect_status_in:
        placeholders = sql.SQL(", ").join([sql.SQL("%s")] * len(expect_status_in))
        where_clauses.append(sql.SQL("status IN ({})").format(placeholders))
        args.extend(expect_status_in)
    query = sql.SQL("UPDATE materials SET {} WHERE {}").format(
        sql.SQL(", ").join(set_clauses),
        sql.SQL(" AND ").join(where_clauses),
    )
    with conn.cursor() as cur:
        cur.execute(query, args)
        return (cur.rowcount or 0) > 0


def _parse_output_has_artifact(material_id: str) -> bool:
    """Return whether canonical or legacy parse artifacts are available."""
    return has_parsed_document(settings.output_dir / material_id)


def _claim_material_for_index_retry(
    conn: psycopg.Connection, material_id: str
) -> dict[str, Any] | None:
    """Atomically move FAILED material to INDEXING for index-only retry."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE materials m
                SET status = 'INDEXING', updated_at = NOW(), status_message = NULL
                FROM (
                    SELECT id FROM materials
                    WHERE id = %s::uuid AND is_deleted = false AND status = 'FAILED'
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.course_id::text, m.original_filename,
                          m.minio_path::text, m.file_type::text
                """,
            (material_id,),
        )
        row = cur.fetchone()
        if row:
            return {
                "course_id": row[0],
                "original_filename": row[1],
                "minio_path": row[2],
                "file_type": row[3],
            }
    return None


def _claim_material_for_preview_repair(
    conn: psycopg.Connection,
    material_id: str,
) -> dict[str, Any] | None:
    """Claim Office material with preview PENDING and return source object metadata."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE materials m
                SET updated_at = NOW(), status_message = NULL
                FROM (
                    SELECT id FROM materials
                    WHERE id = %s::uuid
                      AND is_deleted = false
                      AND preview_pdf_status = 'PENDING'
                      AND file_type IN ('ppt', 'pptx', 'doc', 'docx')
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.minio_path::text
                """,
            (material_id,),
        )
        row = cur.fetchone()
        if row:
            return {
                "minio_path": row[0],
            }
    return None


def _try_claim_convert_preview_row(
    conn: psycopg.Connection, material_id: str
) -> tuple[str, str | None] | None:
    """Lock UPLOADED + office + PENDING for Phase-1 conversion (SKIP LOCKED)."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE materials m
                SET updated_at = NOW()
                FROM (
                    SELECT id FROM materials
                    WHERE id = %s::uuid AND is_deleted = false
                      AND status = 'UPLOADED'
                      AND LOWER(file_type) IN ('ppt', 'pptx', 'doc', 'docx')
                      AND preview_pdf_status = 'PENDING'
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.minio_path::text, m.original_filename
                """,
            (material_id,),
        )
        row = cur.fetchone()
        if row:
            return (str(row[0]), row[1])
    return None


def _claim_material_for_parse(
    conn: psycopg.Connection, material_id: str
) -> dict[str, Any] | None:
    """Atomically move material to PARSING when eligible; return row dict or None if skip."""
    stale = _material_stale_seconds()
    ex: tuple[Any, ...] | None = None
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE materials m
                SET status = 'PARSING', updated_at = NOW()
                FROM (
                    SELECT id FROM materials
                    WHERE id = %s::uuid AND is_deleted = false
                      AND NOT (
                        LOWER(file_type) IN ('ppt', 'pptx', 'doc', 'docx')
                        AND preview_pdf_status = 'PENDING'
                      )
                      AND (
                        status = 'UPLOADED'
                        OR (
                          status IN ('PARSING', 'INDEXING', 'PARSED')
                          AND updated_at < NOW() - (%s * INTERVAL '1 second')
                        )
                      )
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.course_id::text, m.minio_path, m.file_type, m.original_filename
                """,
            (material_id, stale),
        )
        row = cur.fetchone()
        if row:
            return {
                "course_id": row[0],
                "minio_path": row[1],
                "file_type": row[2],
                "original_filename": row[3],
            }
        cur.execute(
            """
                SELECT course_id::text, minio_path, file_type, status::text, is_deleted
                FROM materials WHERE id = %s::uuid
                """,
            (material_id,),
        )
        ex = cur.fetchone()
    if ex is None:
        logger.error("Material {} not found", material_id)
        return None
    if ex[4]:
        logger.warning("Material {} is deleted; skipping parse", material_id)
        return None
    status = ex[3]
    if status == "READY":
        logger.info("Material {} already READY (idempotent)", material_id)
        return None
    logger.info(
        "Material {} not claimable (status={}, not stale enough)",
        material_id,
        status,
    )
    return None


def _upload_material_images_to_minio(
    material_id: str,
    local_file: Path,
    conn: psycopg.Connection,
) -> None:
    """Upload images exposed by the parser contract and record them in MinIO.

    This always runs regardless of text_only flag — images are stored for traceability
    even when multimodal embedding is disabled.
    """
    stem = local_file.stem
    scan_dir = settings.output_dir / stem
    if not scan_dir.exists():
        return

    client = _s3_client()
    bucket = _bucket()
    endpoint = os.environ.get("MINIO_ENDPOINT", "").strip()
    if not endpoint.startswith("http"):
        use_ssl = os.environ.get("MINIO_USE_SSL", "true").lower() == "true"
        endpoint = ("https://" if use_ssl else "http://") + endpoint

    uploaded: list[tuple[int, str]] = []  # (page_idx, minio_url)

    try:
        document = load_parsed_document(scan_dir)
    except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Cannot load parsed images for material {}: {}", material_id, exc)
        return

    for block in document.blocks:
        if block.kind != "image":
            continue
        asset = block.resolved_asset(scan_dir)
        if not asset:
            continue
        page_idx = block.page_idx or 0

        if asset.startswith(("http://", "https://")):
            import io as _io
            import urllib.request as _urlreq

            try:
                with _urlreq.urlopen(asset, timeout=30) as resp:
                    img_bytes = resp.read()
            except Exception as exc:
                logger.warning(
                    "Failed to download parsed image {} for material {}: {}",
                    asset,
                    material_id,
                    exc,
                )
                continue
            sha = hashlib.sha1(img_bytes).hexdigest()[:12]
            url_suffix = (
                "." + asset.rsplit(".", 1)[-1].split("?")[0] if "." in asset else ".jpg"
            )
            suffix = url_suffix.lower() or ".jpg"
            minio_key = f"edu-images/{material_id}/p{page_idx:04d}_{sha}{suffix}"
            try:
                client.upload_fileobj(_io.BytesIO(img_bytes), bucket, minio_key)
            except Exception as exc:
                logger.warning(
                    "Failed to upload parsed image {} for material {}: {}",
                    asset,
                    material_id,
                    exc,
                )
                continue
        else:
            img_abs = Path(asset)
            if not img_abs.exists():
                continue
            sha = hashlib.sha1(img_abs.read_bytes()).hexdigest()[:12]
            suffix = img_abs.suffix.lower() or ".jpg"
            minio_key = f"edu-images/{material_id}/p{page_idx:04d}_{sha}{suffix}"
            try:
                client.upload_file(str(img_abs), bucket, minio_key)
            except Exception as exc:
                logger.warning(
                    "Failed to upload image {} for material {}: {}",
                    img_abs.name,
                    material_id,
                    exc,
                )
                continue

        url = f"{endpoint}/{bucket}/{minio_key}"
        uploaded.append((page_idx, url))

    if not uploaded:
        logger.debug("No images found to upload for material {}", material_id)
        return

    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            """
                INSERT INTO material_images (id, material_id, page_idx, minio_url, created_at)
                VALUES (gen_random_uuid(), %s::uuid, %s, %s, NOW())
                ON CONFLICT DO NOTHING
                """,
            [(material_id, pg, url) for pg, url in uploaded],
        )
    logger.info("Uploaded {} images to MinIO for material {}", len(uploaded), material_id)


def _record_chunk_page_mappings(
    material_id: str,
    course_id: str,
    conn: psycopg.Connection,
) -> None:
    """Copy vector chunk page metadata into the platform citation table."""
    from rag_mvp.vector_store import course_workspace, document_id, document_page_mappings

    mappings = [
        (material_id, chunk_id, page_idx)
        for chunk_id, page_idx in document_page_mappings(
            course_workspace(course_id), document_id(material_id)
        )
    ]

    if not mappings:
        logger.debug("No visual chunk-page mappings found for material {}", material_id)
        return

    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            """
                INSERT INTO chunk_page_mappings (id, material_id, chunk_id, page_idx)
                VALUES (gen_random_uuid(), %s::uuid, %s, %s)
                ON CONFLICT (material_id, chunk_id) DO UPDATE SET page_idx = EXCLUDED.page_idx
                """,
            mappings,
        )
    logger.info("Recorded {} chunk-page mappings for material {}", len(mappings), material_id)


# ---------------------------------------------------------------------------
# Document summary — Map-Reduce (non-video materials)
# ---------------------------------------------------------------------------

def _extract_text_from_parsed_document(material_id: str) -> str:
    """Extract summary text through the provider-neutral parser contract."""
    scan_dir = settings.output_dir / material_id
    if not scan_dir.exists():
        return ""
    try:
        return load_parsed_document(scan_dir).extracted_text()
    except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("Cannot extract parsed text for material {}: {}", material_id, exc)
        return ""


async def _generate_document_summary_async(
    full_text: str,
    filename: str | None,
) -> str:
    """Map-Reduce summarisation.

    Map  : split into ~document_summary_chunk_tokens-token chunks → concurrent LLM calls.
    Reduce : combine chunk summaries → final summary via refine_model.
    Two-level : when chunk count > document_summary_two_level_threshold, reduce in groups first.
    """
    import asyncio

    from rag_mvp.llm import llm_chat_model_func

    cfg = settings
    if not full_text.strip():
        return ""

    # ---- token-aware chunking -------------------------------------------
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")

        def _tok_count(t: str) -> int:
            return len(enc.encode(t, disallowed_special=()))

        def _split_to_chunks(t: str, max_tok: int) -> list[str]:
            toks = enc.encode(t, disallowed_special=())
            return [enc.decode(toks[i: i + max_tok]) for i in range(0, len(toks), max_tok)]

    except ImportError:
        _chars_per_tok = 3

        def _tok_count(t: str) -> int:  # type: ignore[misc]
            return len(t) // _chars_per_tok

        def _split_to_chunks(t: str, max_tok: int) -> list[str]:  # type: ignore[misc]
            size = max_tok * _chars_per_tok
            return [t[i: i + size] for i in range(0, len(t), size)]

    chunks = _split_to_chunks(full_text, cfg.document_summary_chunk_tokens)
    if len(chunks) > cfg.document_summary_max_chunks:
        logger.warning(
            "Document summary: {} chunks exceeds max {}; truncating.",
            len(chunks),
            cfg.document_summary_max_chunks,
        )
        chunks = chunks[: cfg.document_summary_max_chunks]

    if not chunks:
        return ""

    name_hint = f' of "{filename}"' if filename else ""

    # ---- map phase -------------------------------------------------------
    sem = asyncio.Semaphore(max(1, cfg.llm_max_async))

    async def _map_one(idx: int, chunk: str) -> str:
        prompt = (
            f"The following is section {idx + 1} of a document{name_hint}. "
            "Summarise this section in 3-5 sentences. "
            "Write in the same language as the source text. "
            "Focus on key concepts, main points, and important conclusions.\n\n"
            f"{chunk}"
        )
        async with sem:
            try:
                return await llm_chat_model_func(
                    prompt,
                    system_prompt=(
                        "You are a helpful assistant that summarises document sections concisely."
                    ),
                    history_messages=[],
                    max_tokens=512,
                    temperature=0.0,
                )
            except Exception as exc:
                logger.warning("Document summary map[{}] failed: {}", idx, exc)
                return ""

    map_summaries = await asyncio.gather(*[_map_one(i, c) for i, c in enumerate(chunks)])
    map_summaries = [s for s in map_summaries if s.strip()]
    if not map_summaries:
        return ""

    # ---- reduce phase ----------------------------------------------------
    async def _reduce(summaries: list[str], *, is_final: bool) -> str:
        combined = "\n\n---\n\n".join(
            f"[Part {i + 1}]\n{s}" for i, s in enumerate(summaries)
        )
        if is_final:
            prompt = (
                f"The following are section summaries of a document{name_hint}. "
                "Write a comprehensive, well-structured final summary of the whole document "
                "in the same language as the summaries. "
                "Cover the main topics, key points, structure, and conclusions."
                f"\n\n{combined}"
            )
        else:
            prompt = (
                f"The following are summaries of consecutive sections of a document{name_hint}. "
                "Merge them into one coherent paragraph in the same language."
                f"\n\n{combined}"
            )
        try:
            return await llm_chat_model_func(
                prompt,
                system_prompt="You are a helpful assistant that synthesises document summaries.",
                history_messages=[],
                max_tokens=1024,
                temperature=0.0,
            )
        except Exception as exc:
            logger.warning("Document summary reduce failed: {}", exc)
            return "\n\n".join(summaries)  # fallback: plain concat

    two_lvl_thresh = cfg.document_summary_two_level_threshold
    if len(map_summaries) <= two_lvl_thresh:
        final = await _reduce(map_summaries, is_final=True)
    else:
        group_size = 10
        groups = [
            map_summaries[i: i + group_size]
            for i in range(0, len(map_summaries), group_size)
        ]
        mid = await asyncio.gather(*[_reduce(g, is_final=False) for g in groups])
        mid = [s for s in mid if s.strip()]
        final = await _reduce(mid or map_summaries, is_final=True)

    return final.strip()


def _generate_and_save_document_summary(
    conn: psycopg.Connection,
    material_id: str,
    table: str,
    original_filename: str | None,
) -> None:
    """Extract parsed text → async Map-Reduce → persist document_summary to DB.

    Must be called while the parser artifact directory exists (between PARSED and READY
    status transitions). Non-fatal: any failure is logged but does not abort indexing.
    """
    if table not in {"materials", "personal_materials"}:
        raise ValueError(f"Invalid table: {table}")
    try:
        full_text = _extract_text_from_parsed_document(material_id)
        if not full_text.strip():
            logger.info("Document summary: no text extracted for material {}", material_id)
            return

        logger.info(
            "Generating document summary for {} ({} chars) …",
            material_id,
            len(full_text),
        )

        if is_worker_async_loop_started():
            summary: str = run_worker_coroutine(
                _generate_document_summary_async(full_text, original_filename),
                timeout=600,
            )
        else:
            import asyncio as _asyncio
            summary = _asyncio.run(
                _generate_document_summary_async(full_text, original_filename)
            )

        if not summary:
            logger.info("Document summary: empty result for material {}", material_id)
            return

        with conn.transaction(), conn.cursor() as cur:
            cur.execute(
                sql.SQL(
                    "UPDATE {table} SET document_summary = %s, updated_at = NOW() "
                    "WHERE id = %s::uuid AND is_deleted = false"
                ).format(table=sql.Identifier(table)),
                (summary, material_id),
            )
        logger.info(
            "Document summary saved for material {} ({} chars)", material_id, len(summary)
        )
    except Exception as exc:
        logger.warning(
            "Document summary generation failed for {} (non-fatal): {}", material_id, exc
        )


def _run_material_download_parse_and_ingest(
    conn: psycopg.Connection,
    material_id: str,
    course_id: str,
    minio_path: str,
    file_type: str,
    original_filename: str | None,
    text_only: bool,
    r: redis.Redis | None = None,
) -> None:
    """MinIO → parse → vector index. Row must already be ``PARSING``."""
    work_parent = Path(tempfile.mkdtemp(prefix="edu_mat_"))
    suffix = Path(minio_path).suffix or ".bin"
    local_file = work_parent / f"{material_id}{suffix}"
    parsed_committed = False

    try:
        download_object_to_path(minio_path, local_file)
        ft = file_type.lower()
        if ft == "image":
            raise ValueError("Image indexing is not supported for course materials in this phase")

        # Checkpoint 1: before any CPU-heavy work starts.
        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-parse")

        preview_key = _preview_pdf_minio_key(minio_path)
        # Convert Office → PDF for MinerU and upload ``preview.pdf`` (or reuse existing preview).
        if local_file.suffix.lower() in _OFFICE_SUFFIXES:
            if _object_exists(preview_key):
                logger.info(
                    "Reusing existing preview PDF for material {} ({})",
                    material_id,
                    preview_key,
                )
                pdf_file = work_parent / f"{material_id}.pdf"
                download_object_to_path(preview_key, pdf_file)
                # Reconcile stale DB state: preview object exists, so preview is READY.
                with conn.transaction():
                    update_material_preview_pdf_status(conn, material_id, "READY")
                local_file = pdf_file
                ft = "pdf"
            else:
                logger.info(
                    "Converting {} to PDF via LibreOffice (material {})",
                    local_file.suffix,
                    material_id,
                )
                try:
                    pdf_file = _convert_to_pdf(local_file, work_parent / "pdf_out")
                    _upload_preview_pdf_with_verify(pdf_file, preview_key)
                    with conn.transaction():
                        update_material_preview_pdf_status(conn, material_id, "READY")
                except Exception:
                    with conn.transaction():
                        update_material_preview_pdf_status(conn, material_id, "FAILED")
                    raise
                local_file = pdf_file
                ft = "pdf"
                logger.info("Conversion done → {} (preview at {})", pdf_file.name, preview_key)

        # Same parse stack as CLI `rag parse` (engine.parse_file), or worker persistent loop.
        _parse_file_dispatch(local_file)

        # Checkpoint 2: after parsing, before embedding starts (most expensive part).
        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-ingest")

        # Upload extracted images to MinIO (always — regardless of text_only flag)
        try:
            _upload_material_images_to_minio(material_id, local_file, conn)
        except Exception as img_exc:
            logger.warning("Image upload failed for material {} (non-fatal): {}", material_id, img_exc)

        with conn.transaction():
            update_material_status(
                conn, material_id, "PARSED", None, expect_status_in=("PARSING",)
            )
        parsed_committed = True

        # Generate the summary while parser artifacts still exist.
        if settings.document_summary_enabled:
            _generate_and_save_document_summary(
                conn, material_id, "materials", original_filename
            )

        with conn.transaction():
            update_material_status(
                conn, material_id, "INDEXING", None, expect_status_in=("PARSED",)
            )

        n = _ingest_parsed_dispatch(
            course_id,
            material_id,
            local_file,
            str(original_filename) if original_filename else None,
            text_only,
        )

        # Record chunk→page_idx mappings (best-effort; used for per-page image filtering).
        try:
            _record_chunk_page_mappings(material_id, course_id, conn)
        except Exception as cpm_exc:
            logger.warning("chunk_page_mappings recording failed for {} (non-fatal): {}", material_id, cpm_exc)

        with conn.transaction():
            ok = update_material_status(
                conn,
                material_id,
                "READY",
                None,
                indexed_chunk_count=n,
                expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Material {material_id} lost INDEXING state before READY commit",
                )
        # Remove parser cache for this stem to limit disk growth (re-parse on re-ingest).
        stem_dir = settings.output_dir / material_id
        if stem_dir.exists():
            shutil.rmtree(stem_dir, ignore_errors=True)

        logger.success("Indexed material {} ({} vector chunks)", material_id, n)
        _notify_nextjs({"type": "MATERIAL_READY", "material_id": material_id, "course_id": course_id})
    except MaterialCancelledError:
        # Cancelled cleanly — material is already soft-deleted by the API.
        logger.info("Material {} processing cancelled; skipping ingest", material_id)
        shutil.rmtree(settings.output_dir / material_id, ignore_errors=True)
    except Exception as exc:
        logger.exception("Material processing failed")
        if not parsed_committed:
            shutil.rmtree(settings.output_dir / material_id, ignore_errors=True)
        with conn.transaction():
            update_material_status(
                conn,
                material_id,
                "FAILED",
                str(exc)[:2000],
            )
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def process_convert_preview(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
) -> None:
    """Phase 1 for Office uploads: LibreOffice → ``preview.pdf`` → READY; then ``parse_and_index``."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT LOWER(file_type::text), status::text, preview_pdf_status::text, minio_path::text
            FROM materials WHERE id = %s::uuid AND is_deleted = false
            """,
            (material_id,),
        )
        row = cur.fetchone()
    if not row:
        logger.error("convert_preview: material {} not found", material_id)
        return
    ft_lower, status, preview_st, minio_path = row[0], row[1], row[2], row[3]

    if ft_lower not in _OFFICE_FT_LOWER:
        logger.info(
            "convert_preview: material {} is not office ({}); enqueue parse_and_index only",
            material_id,
            ft_lower,
        )
        try:
            _enqueue_parse_and_index_task(material_id, text_only=text_only)
        except Exception:
            logger.exception(
                "convert_preview: parse_and_index enqueue failed for non-office material {}",
                material_id,
            )
            raise
        return

    preview_key = _preview_pdf_minio_key(minio_path)

    if status == "UPLOADED" and preview_st == "PENDING":
        try:
            if _object_exists(preview_key):
                logger.warning(
                    "convert_preview: material {} preview object already exists while DB is PENDING; reconcile READY and enqueue parse",
                    material_id,
                )
                with conn.transaction():
                    update_material_preview_pdf_status(conn, material_id, "READY")
                _enqueue_parse_and_index_task(
                    material_id,
                    text_only=text_only,
                )
                return
        except Exception:
            logger.exception(
                "convert_preview: preview existence check failed for material {}",
                material_id,
            )

    if status == "UPLOADED" and preview_st == "READY":
        if _object_exists(preview_key):
            logger.info(
                "convert_preview: material {} already READY; chain parse_and_index",
                material_id,
            )
            try:
                _enqueue_parse_and_index_task(material_id, text_only=text_only)
            except Exception:
                logger.exception(
                    "convert_preview: chain parse_and_index enqueue failed for material {}",
                    material_id,
                )
                raise
            return
        with conn.transaction():
            update_material_preview_pdf_status(
                conn,
                material_id,
                "PENDING",
                "PREVIEW_OBJECT_MISSING_REBUILD",
            )
        preview_st = "PENDING"

    if status != "UPLOADED":
        logger.info(
            "convert_preview: skip material {} (status={}, preview={})",
            material_id,
            status,
            preview_st,
        )
        return

    if preview_st != "PENDING":
        logger.info(
            "convert_preview: skip material {} (preview_pdf_status={})",
            material_id,
            preview_st,
        )
        return

    claimed = _try_claim_convert_preview_row(conn, material_id)
    if not claimed:
        logger.info(
            "convert_preview: material {} not claimed (locked or other worker)",
            material_id,
        )
        return
    minio_path_claimed, _original_filename = claimed
    work_parent = Path(tempfile.mkdtemp(prefix="edu_cvprev_"))
    suffix = Path(minio_path_claimed).suffix or ".bin"
    local_file = work_parent / f"{material_id}{suffix}"
    try:
        download_object_to_path(minio_path_claimed, local_file)
        pdf_file = _convert_to_pdf(local_file, work_parent / "pdf_out")
        _upload_preview_pdf_with_verify(pdf_file, preview_key)
        with conn.transaction():
            update_material_preview_pdf_status(conn, material_id, "READY")
        try:
            _enqueue_parse_and_index_task(material_id, text_only=text_only)
        except Exception:
            logger.exception(
                "convert_preview: chain parse_and_index enqueue failed for material {}",
                material_id,
            )
            raise
        logger.success(
            "convert_preview: material {} preview ready; parse_and_index queued",
            material_id,
        )
    except Exception as exc:
        logger.exception("convert_preview failed for material {}", material_id)
        msg = str(exc)[:2000]
        with conn.transaction():
            update_material_preview_pdf_status(
                conn,
                material_id,
                "FAILED",
                f"CONVERT_PREVIEW: {msg[:1800]}",
            )
            update_material_status(conn, material_id, "FAILED", msg)
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def process_parse_and_index(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
    r: redis.Redis | None = None,
) -> None:
    """DB is source of truth; parse with the configured provider and write the index."""
    # Checkpoint 0: before claiming the row — skip entirely if already cancelled.
    if r is not None and _is_cancel_requested(r, material_id):
        logger.info("process_parse_and_index: cancel signal detected before claim for material {}", material_id)
        return

    claimed = _claim_material_for_parse(conn, material_id)
    if not claimed:
        _maybe_enqueue_convert_preview_for_stuck_office(
            conn, material_id, text_only=text_only
        )
        return

    _run_material_download_parse_and_ingest(
        conn,
        material_id,
        claimed["course_id"],
        claimed["minio_path"],
        claimed["file_type"],
        claimed.get("original_filename"),
        text_only,
        r=r,
    )


def process_index_only(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
) -> None:
    """Re-ingest from local parse cache, or full MinIO→parse→ingest if cache is missing."""
    claimed = _claim_material_for_index_retry(conn, material_id)
    if not claimed:
        logger.info("index_only: material {} not claimed (not FAILED or locked)", material_id)
        return

    course_id = claimed["course_id"]
    original_filename = claimed.get("original_filename")
    minio_path = claimed["minio_path"]
    file_type = claimed["file_type"]

    if not _parse_output_has_artifact(material_id):
        logger.info(
            "index_only: full reparse fallback for material {} (no local parse artifact)",
            material_id,
        )
        with conn.transaction():
            ok = update_material_status(
                conn,
                material_id,
                "PARSING",
                None,
                expect_status_in=("INDEXING",),
            )
        if not ok:
            logger.error(
                "index_only: could not move material {} from INDEXING to PARSING for fallback",
                material_id,
            )
            with conn.transaction():
                update_material_status(
                    conn,
                    material_id,
                    "FAILED",
                    "RETRY_STATE_LOST",
                    expect_status_in=("INDEXING",),
                )
            return
        _run_material_download_parse_and_ingest(
            conn,
            material_id,
            course_id,
            minio_path,
            file_type,
            str(original_filename) if original_filename else None,
            text_only,
        )
        return

    source_placeholder = Path(f"{material_id}.pdf")
    try:
        _delete_material_rag_dispatch(course_id, material_id)
        n = _ingest_parsed_dispatch(
            course_id,
            material_id,
            source_placeholder,
            str(original_filename) if original_filename else None,
            text_only,
        )
        with conn.transaction():
            ok = update_material_status(
                conn,
                material_id,
                "READY",
                None,
                indexed_chunk_count=n,
                expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Material {material_id} lost INDEXING state before READY commit (index_only)",
                )
        stem_dir = settings.output_dir / material_id
        if stem_dir.exists():
            shutil.rmtree(stem_dir, ignore_errors=True)
        logger.success("Re-indexed material {} ({} chunks)", material_id, n)
    except Exception as exc:
        logger.exception("index_only failed for material {}", material_id)
        with conn.transaction():
            update_material_status(
                conn,
                material_id,
                "FAILED",
                str(exc)[:2000],
                expect_status_in=("INDEXING",),
            )


def process_delete_material(conn: psycopg.Connection, material_id: str) -> None:
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                SELECT course_id::text, is_deleted
                FROM materials WHERE id = %s::uuid
                """,
            (material_id,),
        )
        row = cur.fetchone()
        if not row:
            logger.error("delete_material: material {} not found", material_id)
            return
        course_id, is_deleted = row[0], row[1]
        if not is_deleted:
            raise RuntimeError(
                f"delete_material: material {material_id} expected is_deleted=true",
            )
    _delete_material_rag_dispatch(course_id, material_id)
    logger.info("Deleted vector document for material {} (course {})", material_id, course_id)


def process_repair_preview(conn: psycopg.Connection, material_id: str) -> None:
    """Repair Office ``preview.pdf`` without touching parse/index state."""
    claimed = _claim_material_for_preview_repair(conn, material_id)
    if not claimed:
        logger.info(
            "repair_preview: material {} not claimable (not PENDING office preview or locked)",
            material_id,
        )
        return

    work_parent = Path(tempfile.mkdtemp(prefix="edu_prev_"))
    minio_path = claimed["minio_path"]
    suffix = Path(minio_path).suffix or ".bin"
    local_file = work_parent / f"{material_id}{suffix}"
    try:
        download_object_to_path(minio_path, local_file)
        pdf_file = _convert_to_pdf(local_file, work_parent / "pdf_out")
        preview_key = _preview_pdf_minio_key(minio_path)
        _upload_preview_pdf_with_verify(pdf_file, preview_key)
        with conn.transaction():
            update_material_preview_pdf_status(conn, material_id, "READY")
        logger.success("repair_preview: material {} preview ready ({})", material_id, preview_key)
    except Exception as exc:
        logger.exception("repair_preview failed for material {}", material_id)
        with conn.transaction():
            update_material_preview_pdf_status(
                conn,
                material_id,
                "FAILED",
                f"PREVIEW_REPAIR_FAILED: {str(exc)[:1800]}",
            )
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def _save_media_transcript(
    conn: psycopg.Connection,
    table: str,
    material_id: str,
    transcript: str,
    summary: str,
) -> None:
    """Persist raw transcript and LLM summary to the given materials table."""
    if table not in {"materials", "personal_materials"}:
        raise ValueError(f"Unsupported table name for transcript persistence: {table}")
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL(
                """
            UPDATE {table}
            SET transcript_text = %s, video_summary = %s, updated_at = NOW()
            WHERE id = %s::uuid AND is_deleted = false
            """
            ).format(table=sql.Identifier(table)),
            (transcript, summary, material_id),
        )


def process_transcribe_and_index(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
    r: redis.Redis | None = None,
) -> None:
    """Transcribe a video/audio file with Whisper, build a structured summary, then vector-index it.

    Pipeline:
      1. Claim material row → PARSING (reuses ``_claim_material_for_parse``).
      2. Download media from MinIO to a temp directory.
      3. Whisper transcription via ``transcribe_media_to_txt_file``.
      4. LLM structured time-segment summary via ``build_structured_summary_from_transcript_text``.
         Falls back to raw transcript text if no timestamps are detected.
      5. Commit PARSED → INDEXING.
      6. Ingest the summary (or raw transcript) text into the course vector workspace.
      7. Commit READY with chunk count.

    Requires:
      - ffmpeg on PATH (or FFMPEG_PATH env)
      - ``uv sync --extra video`` (faster-whisper)
      - LLM credentials for structured summary
    """
    from rag_mvp.video_transcribe import transcribe_media_to_txt_file
    from rag_mvp.video_transcript_summary import (
        build_structured_summary_from_transcript_text,
        parse_timestamped_transcript,
    )

    # Checkpoint 0: bail before claiming if already cancelled.
    if r is not None and _is_cancel_requested(r, material_id):
        logger.info(
            "process_transcribe_and_index: cancel signal detected before claim for material {}",
            material_id,
        )
        return

    claimed = _claim_material_for_parse(conn, material_id)
    if not claimed:
        return

    course_id = claimed["course_id"]
    minio_path = claimed["minio_path"]
    original_filename = claimed.get("original_filename")

    work_parent = Path(tempfile.mkdtemp(prefix="edu_vid_"))

    try:
        suffix = Path(minio_path).suffix or ".mp4"
        local_file = work_parent / f"{material_id}{suffix}"
        download_object_to_path(minio_path, local_file)

        # Checkpoint 1: before the expensive Whisper step.
        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-transcribe")

        logger.info("Transcribing media for material {} ({})", material_id, local_file.name)
        txt_path = transcribe_media_to_txt_file(local_file, transcript_dir=work_parent)
        transcript_text = txt_path.read_text(encoding="utf-8")
        logger.info("Transcription done for material {} ({} chars)", material_id, len(transcript_text))

        # Checkpoint 2: before LLM summary / embedding starts.
        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-summary")

        ts_lines = parse_timestamped_transcript(transcript_text)
        if ts_lines:
            try:
                _orig_stem = Path(original_filename).stem if original_filename else txt_path.stem
                _, _json_path, summary_md_path = build_structured_summary_from_transcript_text(
                    transcript_text,
                    txt_path.stem,
                    work_parent,
                    md_title=f"视频结构化摘要 · {_orig_stem}",
                )
                ingest_text = summary_md_path.read_text(encoding="utf-8")
                logger.info(
                    "Structured summary built for material {} ({} chars)",
                    material_id,
                    len(ingest_text),
                )
            except Exception as summ_exc:
                logger.warning(
                    "Structured summary failed for material {} (falling back to raw transcript): {}",
                    material_id,
                    summ_exc,
                )
                ingest_text = transcript_text
        else:
            logger.info(
                "No timestamp lines in transcript for material {}; ingesting raw transcript",
                material_id,
            )
            ingest_text = transcript_text

        with conn.transaction():
            _save_media_transcript(conn, "materials", material_id, transcript_text, ingest_text)
            update_material_status(
                conn, material_id, "PARSED", None, expect_status_in=("PARSING",)
            )

        with conn.transaction():
            update_material_status(
                conn, material_id, "INDEXING", None, expect_status_in=("PARSED",)
            )

        n = _ingest_text_dispatch(
            course_id,
            material_id,
            ingest_text,
            str(original_filename) if original_filename else None,
        )

        with conn.transaction():
            ok = update_material_status(
                conn,
                material_id,
                "READY",
                None,
                indexed_chunk_count=n,
                expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Material {material_id} lost INDEXING state before READY commit",
                )

        logger.success(
            "transcribe_and_index: material {} indexed ({} chunks)", material_id, n
        )
    except MaterialCancelledError:
        logger.info(
            "Material {} transcription/indexing cancelled; skipping ingest", material_id
        )
    except Exception as exc:
        logger.exception("transcribe_and_index failed for material {}", material_id)
        with conn.transaction():
            update_material_status(conn, material_id, "FAILED", str(exc)[:2000])
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


# ---------------------------------------------------------------------------
# Personal KB processing (mirrors course processing against personal_materials table)
# ---------------------------------------------------------------------------

def update_personal_material_status(
    conn: psycopg.Connection,
    material_id: str,
    status: str,
    status_message: str | None = None,
    indexed_chunk_count: int | None = None,
    *,
    expect_status_in: tuple[str, ...] | None = None,
) -> bool:
    set_clauses: list[sql.Composable] = [sql.SQL("status = %s"), sql.SQL("updated_at = NOW()")] 
    args: list[Any] = [status]
    if status_message is not None:
        set_clauses.append(sql.SQL("status_message = %s"))
        args.append(status_message)
    if indexed_chunk_count is not None:
        set_clauses.append(sql.SQL("indexed_chunk_count = %s"))
        args.append(indexed_chunk_count)
    args.append(material_id)
    where_clauses: list[sql.Composable] = [
        sql.SQL("id = %s::uuid"),
        sql.SQL("is_deleted = false"),
    ]
    if expect_status_in:
        placeholders = sql.SQL(", ").join([sql.SQL("%s")] * len(expect_status_in))
        where_clauses.append(sql.SQL("status IN ({})").format(placeholders))
        args.extend(expect_status_in)
    query = sql.SQL("UPDATE personal_materials SET {} WHERE {}").format(
        sql.SQL(", ").join(set_clauses),
        sql.SQL(" AND ").join(where_clauses),
    )
    with conn.cursor() as cur:
        cur.execute(query, args)
        return (cur.rowcount or 0) > 0


def _claim_personal_material_for_parse(
    conn: psycopg.Connection, material_id: str
) -> dict[str, Any] | None:
    stale = _material_stale_seconds()
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE personal_materials m
                SET status = 'PARSING', updated_at = NOW()
                FROM (
                    SELECT id FROM personal_materials
                    WHERE id = %s::uuid AND is_deleted = false
                      AND NOT (
                        LOWER(file_type) IN ('ppt', 'pptx', 'doc', 'docx')
                        AND preview_pdf_status = 'PENDING'
                      )
                      AND (
                        status = 'UPLOADED'
                        OR (
                          status IN ('PARSING', 'INDEXING', 'PARSED')
                          AND updated_at < NOW() - (%s * INTERVAL '1 second')
                        )
                      )
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.user_id::text, m.minio_path, m.file_type, m.original_filename
                """,
            (material_id, stale),
        )
        row = cur.fetchone()
        if row:
            return {
                "user_id": row[0],
                "minio_path": row[1],
                "file_type": row[2],
                "original_filename": row[3],
            }
    logger.info("personal_parse: material {} not claimable", material_id)
    return None


def _claim_personal_material_for_index_retry(
    conn: psycopg.Connection, material_id: str
) -> dict[str, Any] | None:
    """Atomically move FAILED personal material to INDEXING for index-only retry."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """
                UPDATE personal_materials m
                SET status = 'INDEXING', updated_at = NOW(), status_message = NULL
                FROM (
                    SELECT id FROM personal_materials
                    WHERE id = %s::uuid AND is_deleted = false AND status = 'FAILED'
                    FOR UPDATE SKIP LOCKED
                ) s
                WHERE m.id = s.id
                RETURNING m.user_id::text, m.original_filename,
                          m.minio_path::text, m.file_type::text
                """,
            (material_id,),
        )
        row = cur.fetchone()
        if row:
            return {
                "user_id": row[0],
                "original_filename": row[1],
                "minio_path": row[2],
                "file_type": row[3],
            }
    return None


def _ingest_personal_parsed_dispatch(
    user_id: str,
    material_id: str,
    local_file: Path,
    original_filename: str | None,
    text_only: bool,
) -> int:
    async def _worker_coro() -> int:
        try:
            return await ingest_parsed_material_into_personal_async(
                user_id, material_id, local_file,
                original_filename=original_filename,
                text_only=text_only,
            )
        finally:
            _invalidate_personal_rag_cache(user_id)

    if is_worker_async_loop_started():
        return run_worker_coroutine(_worker_coro(), timeout=None)
    return ingest_parsed_material_into_personal_sync(
        user_id, material_id, local_file,
        original_filename=original_filename,
        text_only=text_only,
    )


def _ingest_personal_text_dispatch(
    user_id: str,
    material_id: str,
    text: str,
    original_filename: str | None,
) -> int:
    async def _worker_coro() -> int:
        return await ingest_text_into_personal_async(
            user_id, material_id, text,
            original_filename=original_filename,
        )

    if is_worker_async_loop_started():
        return run_worker_coroutine(_worker_coro(), timeout=None)
    return ingest_text_into_personal_sync(
        user_id, material_id, text,
        original_filename=original_filename,
    )


def _delete_personal_material_rag_dispatch(user_id: str, material_id: str) -> None:
    async def _worker_coro() -> None:
        try:
            await delete_material_personal_async(user_id, material_id)
        finally:
            _invalidate_personal_rag_cache(user_id)

    if is_worker_async_loop_started():
        run_worker_coroutine(_worker_coro(), timeout=None)
    else:
        delete_material_personal_sync(user_id, material_id)


def _run_personal_material_download_parse_and_ingest(
    conn: psycopg.Connection,
    material_id: str,
    user_id: str,
    minio_path: str,
    file_type: str,
    original_filename: str | None,
    text_only: bool,
    r: redis.Redis | None = None,
) -> None:
    """MinIO → parse → personal vector index. Row must already be PARSING."""
    work_parent = Path(tempfile.mkdtemp(prefix="edu_pmat_"))
    suffix = Path(minio_path).suffix or ".bin"
    local_file = work_parent / f"{material_id}{suffix}"
    parsed_committed = False

    try:
        download_object_to_path(minio_path, local_file)

        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-parse")

        preview_key = _preview_pdf_minio_key(minio_path)
        if local_file.suffix.lower() in _OFFICE_SUFFIXES:
            if _object_exists(preview_key):
                pdf_file = work_parent / f"{material_id}.pdf"
                download_object_to_path(preview_key, pdf_file)
                local_file = pdf_file
            else:
                try:
                    pdf_file = _convert_to_pdf(local_file, work_parent / "pdf_out")
                    _upload_preview_pdf_with_verify(pdf_file, preview_key)
                    with conn.transaction(), conn.cursor() as cur:
                        cur.execute(
                            """UPDATE personal_materials SET preview_pdf_status = 'READY',
                                   updated_at = NOW() WHERE id = %s::uuid""",
                            (material_id,),
                        )
                except Exception:
                    with conn.transaction(), conn.cursor() as cur:
                        cur.execute(
                            """UPDATE personal_materials SET preview_pdf_status = 'FAILED',
                                   updated_at = NOW() WHERE id = %s::uuid""",
                            (material_id,),
                        )
                    raise
                local_file = pdf_file

        _parse_file_dispatch(local_file)

        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-ingest")

        with conn.transaction():
            update_personal_material_status(
                conn, material_id, "PARSED", None, expect_status_in=("PARSING",)
            )
        parsed_committed = True

        # Generate the summary while parser artifacts still exist.
        if settings.document_summary_enabled:
            _generate_and_save_document_summary(
                conn, material_id, "personal_materials", original_filename
            )

        with conn.transaction():
            update_personal_material_status(
                conn, material_id, "INDEXING", None, expect_status_in=("PARSED",)
            )

        n = _ingest_personal_parsed_dispatch(
            user_id, material_id, local_file,
            str(original_filename) if original_filename else None,
            text_only,
        )

        with conn.transaction():
            ok = update_personal_material_status(
                conn, material_id, "READY", None,
                indexed_chunk_count=n, expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Personal material {material_id} lost INDEXING state before READY commit"
                )

        stem_dir = settings.output_dir / material_id
        if stem_dir.exists():
            shutil.rmtree(stem_dir, ignore_errors=True)

        logger.success("Indexed personal material {} ({} chunks)", material_id, n)
    except MaterialCancelledError:
        logger.info("Personal material {} processing cancelled", material_id)
        shutil.rmtree(settings.output_dir / material_id, ignore_errors=True)
    except Exception as exc:
        logger.exception("Personal material processing failed")
        if not parsed_committed:
            shutil.rmtree(settings.output_dir / material_id, ignore_errors=True)
        with conn.transaction():
            update_personal_material_status(conn, material_id, "FAILED", str(exc)[:2000])
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def process_personal_parse_and_index(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
    r: redis.Redis | None = None,
) -> None:
    if r is not None and _is_cancel_requested(r, material_id):
        logger.info("personal_parse_and_index: cancel signal before claim for {}", material_id)
        return

    claimed = _claim_personal_material_for_parse(conn, material_id)
    if not claimed:
        return

    _run_personal_material_download_parse_and_ingest(
        conn, material_id,
        claimed["user_id"],
        claimed["minio_path"],
        claimed["file_type"],
        claimed.get("original_filename"),
        text_only, r=r,
    )


def process_personal_delete_material(conn: psycopg.Connection, material_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT user_id::text, is_deleted FROM personal_materials WHERE id = %s::uuid",
            (material_id,),
        )
        row = cur.fetchone()
    if not row:
        logger.error("personal_delete: material {} not found", material_id)
        return
    user_id, is_deleted = row[0], row[1]
    if not is_deleted:
        raise RuntimeError(
            f"personal_delete: material {material_id} expected is_deleted=true"
        )
    _delete_personal_material_rag_dispatch(user_id, material_id)
    logger.info("Deleted personal vector document for material {}", material_id)


def process_personal_transcribe_and_index(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
    r: redis.Redis | None = None,
) -> None:
    """Transcribe a personal video/audio file and ingest into the user's personal KB."""
    from rag_mvp.video_transcribe import transcribe_media_to_txt_file
    from rag_mvp.video_transcript_summary import (
        build_structured_summary_from_transcript_text,
        parse_timestamped_transcript,
    )

    if r is not None and _is_cancel_requested(r, material_id):
        logger.info("personal_transcribe: cancel signal before claim for {}", material_id)
        return

    claimed = _claim_personal_material_for_parse(conn, material_id)
    if not claimed:
        return

    user_id = claimed["user_id"]
    minio_path = claimed["minio_path"]
    original_filename = claimed.get("original_filename")

    work_parent = Path(tempfile.mkdtemp(prefix="edu_pvid_"))

    try:
        suffix = Path(minio_path).suffix or ".mp4"
        local_file = work_parent / f"{material_id}{suffix}"
        download_object_to_path(minio_path, local_file)

        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-transcribe")

        txt_path = transcribe_media_to_txt_file(local_file, transcript_dir=work_parent)
        raw_transcript = txt_path.read_text(encoding="utf-8")

        segments = parse_timestamped_transcript(raw_transcript)
        if segments:
            try:
                _orig_stem = Path(original_filename).stem if original_filename else txt_path.stem
                _, _json_path, summary_md_path = build_structured_summary_from_transcript_text(
                    raw_transcript,
                    txt_path.stem,
                    work_parent,
                    md_title=f"视频结构化摘要 · {_orig_stem}",
                )
                ingest_text = summary_md_path.read_text(encoding="utf-8")
            except Exception as summ_exc:
                logger.warning(
                    "Structured summary failed for personal material {} (falling back to raw transcript): {}",
                    material_id,
                    summ_exc,
                )
                ingest_text = raw_transcript
        else:
            ingest_text = raw_transcript

        if r is not None:
            _raise_if_cancelled(r, material_id, "pre-ingest")

        with conn.transaction():
            _save_media_transcript(conn, "personal_materials", material_id, raw_transcript, ingest_text)
            update_personal_material_status(
                conn, material_id, "PARSED", None, expect_status_in=("PARSING",)
            )

        with conn.transaction():
            update_personal_material_status(
                conn, material_id, "INDEXING", None, expect_status_in=("PARSED",)
            )

        n = _ingest_personal_text_dispatch(
            user_id, material_id, ingest_text,
            str(original_filename) if original_filename else None,
        )

        with conn.transaction():
            ok = update_personal_material_status(
                conn, material_id, "READY", None,
                indexed_chunk_count=n, expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Personal material {material_id} lost INDEXING state before READY commit"
                )

        logger.success("personal_transcribe_and_index: material {} ({} chunks)", material_id, n)
    except MaterialCancelledError:
        logger.info("Personal material {} transcription cancelled", material_id)
    except Exception as exc:
        logger.exception("personal_transcribe_and_index failed for material {}", material_id)
        with conn.transaction():
            update_personal_material_status(conn, material_id, "FAILED", str(exc)[:2000])
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def _enqueue_personal_parse_and_index_task(material_id: str, *, text_only: bool) -> None:
    """Chain personal Phase 2 after Office preview PDF is ready."""
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL is not set; cannot enqueue personal_parse_and_index")
    r = redis.from_url(redis_url, decode_responses=True)
    r.xadd(
        _rag_task_stream_name(),
        {
            "task_id": str(uuid4()),
            "material_id": material_id,
            "operation": "personal_parse_and_index",
            "created_at": datetime.now(UTC).isoformat(),
            "text_only": "true" if text_only else "false",
        },
    )


def process_personal_convert_preview(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
) -> None:
    """Phase 1 for personal Office uploads: LibreOffice → preview.pdf → READY; then personal_parse_and_index."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT LOWER(file_type::text), status::text, preview_pdf_status::text, minio_path::text, user_id::text
            FROM personal_materials WHERE id = %s::uuid AND is_deleted = false
            """,
            (material_id,),
        )
        row = cur.fetchone()
    if not row:
        logger.error("personal_convert_preview: material {} not found", material_id)
        return
    ft_lower, status, preview_st, minio_path, _ = row[0], row[1], row[2], row[3], row[4]

    if ft_lower not in _OFFICE_FT_LOWER:
        logger.info(
            "personal_convert_preview: material {} is not office ({}); enqueue personal_parse_and_index",
            material_id, ft_lower,
        )
        try:
            _enqueue_personal_parse_and_index_task(material_id, text_only=text_only)
        except Exception:
            logger.exception(
                "personal_convert_preview: personal_parse_and_index enqueue failed for {}",
                material_id,
            )
            raise
        return

    preview_key = _preview_pdf_minio_key(minio_path)

    if status == "UPLOADED" and preview_st == "READY":
        if _object_exists(preview_key):
            logger.info(
                "personal_convert_preview: material {} already READY; chain personal_parse_and_index",
                material_id,
            )
            try:
                _enqueue_personal_parse_and_index_task(material_id, text_only=text_only)
            except Exception:
                logger.exception(
                    "personal_convert_preview: chain enqueue failed for {}",
                    material_id,
                )
                raise
            return
        with conn.transaction():
            update_personal_material_status(conn, material_id, "UPLOADED", "PREVIEW_OBJECT_MISSING_REBUILD")

    if status != "UPLOADED":
        logger.info(
            "personal_convert_preview: skip material {} (status={})",
            material_id, status,
        )
        return

    work_parent = Path(tempfile.mkdtemp(prefix="edu_pconv_"))
    try:
        suffix = Path(minio_path).suffix or ".docx"
        local_src = work_parent / f"{material_id}{suffix}"
        download_object_to_path(minio_path, local_src)

        pdf_out = work_parent / f"{material_id}.pdf"
        import subprocess
        result = subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", str(work_parent), str(local_src)],
            capture_output=True, timeout=300,check=False
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"libreoffice failed (rc={result.returncode}): {result.stderr.decode(errors='replace')[:500]}"
            )

        if not pdf_out.exists():
            stem = local_src.stem
            candidates = list(work_parent.glob(f"{stem}*.pdf"))
            if not candidates:
                raise RuntimeError("libreoffice produced no PDF output")
            pdf_out = candidates[0]

        _upload_preview_pdf_with_verify(pdf_out, preview_key)

        with conn.transaction():
            update_personal_material_status(conn, material_id, "UPLOADED", None)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE personal_materials SET preview_pdf_status = 'READY' WHERE id = %s::uuid",
                    (material_id,),
                )

        logger.success(
            "personal_convert_preview: material {} preview ready; chaining personal_parse_and_index",
            material_id,
        )
        _enqueue_personal_parse_and_index_task(material_id, text_only=text_only)
    except Exception as exc:
        logger.exception("personal_convert_preview failed for material {}", material_id)
        with conn.transaction():
            update_personal_material_status(conn, material_id, "FAILED", str(exc)[:2000])
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)


def process_personal_index_only(
    conn: psycopg.Connection,
    material_id: str,
    *,
    text_only: bool = True,
) -> None:
    """Re-ingest personal material from local parse cache, or full MinIO→parse→ingest fallback."""
    claimed = _claim_personal_material_for_index_retry(conn, material_id)
    if not claimed:
        logger.info("personal_index_only: material {} not claimed (not FAILED or locked)", material_id)
        return

    user_id = claimed["user_id"]
    original_filename = claimed.get("original_filename")
    minio_path = claimed["minio_path"]
    file_type = claimed["file_type"]

    if not _parse_output_has_artifact(material_id):
        logger.info(
            "personal_index_only: full reparse fallback for material {} (no local parse artifact)",
            material_id,
        )
        with conn.transaction():
            ok = update_personal_material_status(
                conn, material_id, "PARSING", None, expect_status_in=("INDEXING",),
            )
        if not ok:
            logger.error(
                "personal_index_only: could not move material {} from INDEXING to PARSING for fallback",
                material_id,
            )
            with conn.transaction():
                update_personal_material_status(
                    conn, material_id, "FAILED", "RETRY_STATE_LOST", expect_status_in=("INDEXING",),
                )
            return
        _run_personal_material_download_parse_and_ingest(
            conn, material_id, user_id, minio_path, file_type,
            str(original_filename) if original_filename else None,
            text_only,
        )
        return

    source_placeholder = Path(f"{material_id}.pdf")
    try:
        _delete_personal_material_rag_dispatch(user_id, material_id)
        n = _ingest_personal_parsed_dispatch(
            user_id, material_id, source_placeholder,
            str(original_filename) if original_filename else None,
            text_only,
        )
        with conn.transaction():
            ok = update_personal_material_status(
                conn, material_id, "READY", None,
                indexed_chunk_count=n, expect_status_in=("INDEXING",),
            )
            if not ok:
                raise RuntimeError(
                    f"Personal material {material_id} lost INDEXING state before READY commit"
                    " (personal_index_only)",
                )
        stem_dir = settings.output_dir / material_id
        if stem_dir.exists():
            shutil.rmtree(stem_dir, ignore_errors=True)
        logger.success("Re-indexed personal material {} ({} chunks)", material_id, n)
    except Exception as exc:
        logger.exception("personal_index_only failed for material {}， exception: {}", material_id, str(exc))
        with conn.transaction():
            update_personal_material_status(
                conn, material_id, "FAILED", str(exc)[:2000], expect_status_in=("INDEXING",),
            )
