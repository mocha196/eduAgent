"""Shared utilities for the agentic-RAG evaluation harness.

Sets up:
  - DB connections for creating eval courses + user
  - LightRAG text-ingest helpers (naive vs full)
  - Path constants
  - Logging
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parents[2]
EVAL_DIR = Path(__file__).parent
DATA_DIR = EVAL_DIR / "data"
RESULTS_DIR = EVAL_DIR / "results"
EDU_PLATFORM_DIR = REPO_ROOT / "edu-platform"
PARSED_OUTPUT_DIR = EDU_PLATFORM_DIR / "output" / "parsed"

DATA_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Bootstrap: load .env and project src/ before importing engine
# ---------------------------------------------------------------------------

def _bootstrap() -> None:
    """Load env, add src to sys.path if needed."""
    from dotenv import load_dotenv
    # prefer project-root .env, then edu-platform/.env
    for p in [REPO_ROOT / ".env", EDU_PLATFORM_DIR / ".env"]:
        if p.exists():
            load_dotenv(p, override=False)
    src = str(REPO_ROOT / "src")
    if src not in sys.path:
        sys.path.insert(0, src)

_bootstrap()

# ---------------------------------------------------------------------------
# Deterministic IDs for eval infrastructure
# (these are fixed, so re-runs reuse the same DB rows and LightRAG workspace)
# RFC 4122–compliant UUIDs: third group starts with 4 (v4), fourth with 8 (variant 1)
# so they pass the strict UUID regex in edu-platform/lib/course-access.ts
# ---------------------------------------------------------------------------
EVAL_TEACHER_ID   = "e0000001-0000-4000-8000-000000000000"
EVAL_STUDENT_ID   = "e0000002-0000-4000-8000-000000000000"
EVAL_STUDENT_USERNAME = "eval_student"
EVAL_STUDENT_EMAIL    = "eval_student@eval.internal"

# Eval course IDs
COURSE_GRAPHRAG_NAIVE = "c0000001-0000-4000-8000-000000000000"
COURSE_GRAPHRAG_FULL  = "c0000002-0000-4000-8000-000000000000"
COURSE_FRAMES         = "c0000003-0000-4000-8000-000000000000"
# For ragas_custom, use the actual production course. Pass via EVAL_RAGAS_COURSE_ID env var.

# ---------------------------------------------------------------------------
# DB helpers: create eval user + courses if they don't exist
# ---------------------------------------------------------------------------

def _get_db_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL must be set to create eval DB records.")
    return url


def _psycopg_dsn(url: str) -> str:
    """Convert postgresql://... to a psycopg-compatible DSN string.

    Strips Prisma-specific query parameters (e.g. ?schema=public) that
    psycopg does not understand.
    """
    url = url.replace("postgresql+asyncpg", "postgresql").replace("postgresql+psycopg", "postgresql")
    # Remove unsupported query params: psycopg only accepts standard libpq params.
    # Prisma appends ?schema=<name> which causes a ProgrammingError.
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

    parsed = urlparse(url)
    if parsed.query:
        _LIBPQ_PARAMS = {
            "host", "port", "dbname", "user", "password",
            "sslmode", "sslcert", "sslkey", "sslrootcert",
            "connect_timeout", "application_name", "options",
        }
        filtered = {k: v for k, v in parse_qs(parsed.query, keep_blank_values=True).items()
                    if k in _LIBPQ_PARAMS}
        new_query = urlencode(filtered, doseq=True)
        parsed = parsed._replace(query=new_query)
        url = urlunparse(parsed)
    return url


def _hash_password(password: str) -> str:
    """Hash a password with argon2id using argon2-cffi."""
    try:
        from argon2 import PasswordHasher
        ph = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=1)
        return ph.hash(password)
    except ImportError:
        # argon2-cffi not available: return a clearly-invalid placeholder.
        # The eval user is never authenticated via password (JWT is generated directly),
        # so this only affects the login endpoint which we don't use.
        placeholder = f"INVALID_HASH_ARGON2_NOT_INSTALLED__{hashlib.sha256(password.encode()).hexdigest()}"
        return placeholder


def setup_eval_db(eval_password: str = "eval_password_not_used_123!") -> None:
    """Idempotently create eval teacher, student, courses, and enrollments in the DB.

    Safe to call multiple times; uses INSERT ... ON CONFLICT DO NOTHING.
    """
    import psycopg

    db_url = _get_db_url()
    dsn = _psycopg_dsn(db_url)
    pw_hash = _hash_password(eval_password)

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # Teacher user
            cur.execute(
                """
                INSERT INTO users (id, username, email, password_hash, role, real_name, is_active, updated_at)
                VALUES (%s, %s, %s, %s, 'TEACHER', 'Eval Teacher', true, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (EVAL_TEACHER_ID, "eval_teacher", "eval_teacher@eval.internal", pw_hash),
            )
            # Student user
            cur.execute(
                """
                INSERT INTO users (id, username, email, password_hash, role, real_name, is_active, updated_at)
                VALUES (%s, %s, %s, %s, 'STUDENT', 'Eval Student', true, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (EVAL_STUDENT_ID, EVAL_STUDENT_USERNAME, EVAL_STUDENT_EMAIL, pw_hash),
            )
            # Courses
            courses = [
                (COURSE_GRAPHRAG_NAIVE, "Eval: GraphRAG-Bench Naive RAG"),
                (COURSE_GRAPHRAG_FULL,  "Eval: GraphRAG-Bench Full LightRAG"),
                (COURSE_FRAMES,         "Eval: FRAMES Wikipedia"),
            ]
            for cid, cname in courses:
                cur.execute(
                    """
                    INSERT INTO courses (id, teacher_id, name, status, updated_at)
                    VALUES (%s, %s, %s, 'PUBLISHED', NOW())
                    ON CONFLICT (id) DO NOTHING
                    """,
                    (cid, EVAL_TEACHER_ID, cname),
                )
            # Enroll student in all courses
            for cid, _ in courses:
                cur.execute(
                    """
                    INSERT INTO course_enrollments (id, course_id, student_id)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (course_id, student_id) DO NOTHING
                    """,
                    (str(uuid.uuid4()), cid, EVAL_STUDENT_ID),
                )
        conn.commit()
    print("[setup_eval_db] Eval DB records created/verified.")


# ---------------------------------------------------------------------------
# LightRAG ingest helpers
# ---------------------------------------------------------------------------

def _lightrag_dsn() -> str:
    """Return psycopg-compatible DSN for the lightrag database."""
    dsn = os.environ.get("LIGHTRAG_PG_DSN", "").strip()
    if not dsn:
        raise RuntimeError("LIGHTRAG_PG_DSN must be set (points to the edu_lightrag PG database).")
    return _psycopg_dsn(dsn)


def is_already_ingested(course_id: str, material_id: str) -> bool:
    """Return True if this material's chunks already exist in lightrag_doc_chunks.

    Checks (workspace, full_doc_id) in the KV text-chunk table so we can skip
    re-embedding on a resumed run, avoiding unnecessary embedding API calls.
    """
    import psycopg
    from rag_mvp.engine import material_stable_doc_id
    from rag_mvp.course_workspace import course_id_to_workspace

    doc_id = material_stable_doc_id(material_id)
    workspace = course_id_to_workspace(course_id)
    try:
        with psycopg.connect(_lightrag_dsn()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM lightrag_doc_chunks"
                    " WHERE workspace = %s AND full_doc_id = %s LIMIT 1",
                    (workspace, doc_id),
                )
                return cur.fetchone() is not None
    except Exception as exc:
        print(f"  [skip-check] Could not query lightrag_doc_chunks: {exc}")
        return False


def ingest_text_naive(
    course_id: str,
    material_id: str,
    text: str,
    original_filename: str,
) -> int:
    """Ingest plain text WITHOUT entity extraction (vector-only RAG).

    Uses the sync wrapper so each call gets its own asyncio.run() and the
    course LightRAG cache is invalidated afterward (prevents 'NoneType has
    no _run_with_retry' when ingesting multiple documents in a loop).
    """
    from rag_mvp.engine import ingest_text_into_course_sync
    return ingest_text_into_course_sync(
        course_id,
        material_id,
        text,
        original_filename=original_filename,
        skip_entity_extraction=True,
    )


def ingest_text_full(
    course_id: str,
    material_id: str,
    text: str,
    original_filename: str,
) -> int:
    """Ingest plain text WITH entity extraction (full LightRAG knowledge graph).

    Uses the sync wrapper for the same cache-invalidation reason as ingest_text_naive.
    """
    from rag_mvp.engine import ingest_text_into_course_sync
    return ingest_text_into_course_sync(
        course_id,
        material_id,
        text,
        original_filename=original_filename,
        skip_entity_extraction=False,
    )


def run_ingest(coro):
    """Run a single ingest coroutine in a fresh event loop (avoids cross-loop cache)."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def save_json(path: Path | str, data) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[save_json] Saved {len(data) if hasattr(data, '__len__') else '?'} records → {p}")


def load_json(path: Path | str):
    p = Path(path)
    return json.loads(p.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Stable material_id helper (deterministic UUID from a string key)
# ---------------------------------------------------------------------------

def stable_material_id(key: str) -> str:
    """Generate a deterministic UUID v5 string for use as a material_id."""
    ns = uuid.UUID("00000000-0000-0000-0000-000000000000")
    return str(uuid.uuid5(ns, key))
