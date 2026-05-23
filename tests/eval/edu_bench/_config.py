"""edu_bench/_config.py — constants, paths, and DB setup for the PolyU GraphRAG-Bench evaluation.

Fixed IDs (deterministic, survive DB wipes/restores):
  EDU_BENCH_TEACHER_ID = "e0000011-0000-4000-8000-000000000000"
  COURSE_EDU_BENCH     = "c0000011-0000-4000-8000-000000000000"

The eval student (EVAL_STUDENT_ID from _common.py) is enrolled in the course.
"""
from __future__ import annotations

import uuid
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
EDU_BENCH_DIR   = Path(__file__).parent
DATA_DIR        = EDU_BENCH_DIR / "data"
CORPUS_DIR      = DATA_DIR / "corpus"
QUESTIONS_RAW   = DATA_DIR / "questions" / "raw"
QUESTIONS_FILT  = DATA_DIR / "questions" / "filtered"
RESULTS_GRAPHRAG = EDU_BENCH_DIR / "results" / "graphrag"
RESULTS_AGENTIC  = EDU_BENCH_DIR / "results" / "agentic"

for _d in (CORPUS_DIR, QUESTIONS_RAW, QUESTIONS_FILT, RESULTS_GRAPHRAG, RESULTS_AGENTIC):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Fixed IDs
# ---------------------------------------------------------------------------
EDU_BENCH_TEACHER_ID = "e0000011-0000-4000-8000-000000000000"
COURSE_EDU_BENCH     = "c0000011-0000-4000-8000-000000000000"

# Question types (order matches evaluator.py expectations)
QTYPES = ["FB", "MC", "MS", "OE", "TF"]

# HuggingFace dataset repo (try primary first, fallback to original)
HF_DATASET_REPO = "Awesome-GraphRAG/GraphRAG-Bench"
HF_DATASET_REPO_ALT = "jeremycp3/GraphRAG-Bench"

# ---------------------------------------------------------------------------
# Shared utilities (imported from parent eval package)
# ---------------------------------------------------------------------------
import sys
import os

# Ensure project root is in sys.path so _common._bootstrap() works
_REPO_ROOT = EDU_BENCH_DIR.parents[2]
if str(_REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "src"))

from tests.eval._common import (  # noqa: E402
    _bootstrap,
    _get_db_url,
    _psycopg_dsn,
    _hash_password,
    EVAL_STUDENT_ID,
    is_already_ingested,
    ingest_text_full,
    stable_material_id,
    save_json,
    load_json,
    make_eval_jwt,
    ensure_course_enrollment,
    query_lightrag_direct,
)

_bootstrap()

# Alias for clarity in this module
EDU_BENCH_STUDENT_ID = EVAL_STUDENT_ID

# ---------------------------------------------------------------------------
# DB setup
# ---------------------------------------------------------------------------

def setup_edu_bench_db(password: str = "eval_password_not_used_123!") -> None:
    """Idempotently create the edu_bench teacher, course, and student enrollment.

    Safe to call multiple times — all inserts use ON CONFLICT DO NOTHING.
    Creates:
      - Teacher (e0000011-...) with username "edu_bench_teacher"
      - Course  (c0000011-...) "Eval: PolyU GraphRAG-Bench (CS Textbooks)"
      - Enrollment: EDU_BENCH_STUDENT_ID enrolled in the course
    """
    import psycopg

    db_url = _get_db_url()
    dsn = _psycopg_dsn(db_url)
    pw_hash = _hash_password(password)

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # Teacher user
            cur.execute(
                """
                INSERT INTO users (id, username, email, password_hash, role, real_name, is_active, updated_at)
                VALUES (%s, %s, %s, %s, 'TEACHER', 'Edu Bench Teacher', true, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    EDU_BENCH_TEACHER_ID,
                    "edu_bench_teacher",
                    "edu_bench_teacher@eval.internal",
                    pw_hash,
                ),
            )
            # Course
            cur.execute(
                """
                INSERT INTO courses (id, teacher_id, name, status, updated_at)
                VALUES (%s, %s, %s, 'PUBLISHED', NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (COURSE_EDU_BENCH, EDU_BENCH_TEACHER_ID, "Eval: PolyU GraphRAG-Bench (CS Textbooks)"),
            )
            # Enrollment
            cur.execute(
                """
                INSERT INTO course_enrollments (id, course_id, student_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (course_id, student_id) DO NOTHING
                """,
                (str(uuid.uuid4()), COURSE_EDU_BENCH, EDU_BENCH_STUDENT_ID),
            )
        conn.commit()

    print("[setup_edu_bench_db] ✓ Teacher, course, and enrollment created/verified.")
    print(f"  Teacher : {EDU_BENCH_TEACHER_ID}  (edu_bench_teacher)")
    print(f"  Course  : {COURSE_EDU_BENCH}  (PolyU GraphRAG-Bench)")
    print(f"  Student : {EDU_BENCH_STUDENT_ID}  (eval_student)")
