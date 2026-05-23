"""Prepare PolyU GraphRAG-Bench corpus and DB for the edu_bench evaluation.

Sub-commands (choose exactly one):
  --list-topics                   Download question jsonl files, print Level-1 Topic distribution.
  --setup-db                      Create teacher / course / enrollment in DB.
  --filter-questions --topics X   Filter raw questions to selected topics → filtered/ directory.
  --ingest-all                    Download ALL 20 textbooks and ingest into COURSE_EDU_BENCH.

Common options:
  --topics TOPICS     Comma-separated Level-1 Topic names.
                      Required for --filter-questions; optional filter for --list-topics.
                      Example: --topics "Cybersecurity,Information retrieval"
  --hf-token TOKEN    HuggingFace token (or set HF_TOKEN env var).
  --skip-ingest       (--ingest-all only) Download textbooks but skip the actual ingest step.

Environment variables required for --ingest-all:
  LLM_KG_MODEL=Qwen/Qwen3-8B
  LLM_KG_BASE_URL=https://api.siliconflow.cn/v1
  LLM_KG_API_KEY=<your_siliconflow_key>
  LLM_MAX_ASYNC=2     (recommended to stay within TPM=50,000 free quota)
  CHUNK_SIZE=1200     (matches official benchmark)

Usage examples:
  # Step 0 — explore dataset
  python -m tests.eval.edu_bench.prepare_corpus --list-topics

  # Step 1 — create DB records
  python -m tests.eval.edu_bench.prepare_corpus --setup-db

  # Step 2 — filter questions (fast, no network)
  python -m tests.eval.edu_bench.prepare_corpus --filter-questions --topics "Cybersecurity,Information retrieval"

  # Step 3 — full ingest of all 20 textbooks (~9.5h on SiliconFlow free tier, restartable)
  python -m tests.eval.edu_bench.prepare_corpus --ingest-all

  # Ingest a single textbook (e.g. textbook7 only) — useful for one-by-one testing
  python -m tests.eval.edu_bench.prepare_corpus --ingest-one 7

  # Dry-run: download textbooks only, skip ingest
  python -m tests.eval.edu_bench.prepare_corpus --ingest-all --skip-ingest
  python -m tests.eval.edu_bench.prepare_corpus --ingest-one 7 --skip-ingest

  # Register already-ingested textbooks into the materials table so they appear in the UI
  python -m tests.eval.edu_bench.prepare_corpus --register-materials
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: make sure repo root / src are resolvable before any local import
# ---------------------------------------------------------------------------
_HERE = Path(__file__).parent
_REPO_ROOT = _HERE.parents[2]
if str(_REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "src"))

from tests.eval.edu_bench._config import (  # noqa: E402
    CORPUS_DIR,
    COURSE_EDU_BENCH,
    HF_DATASET_REPO,
    HF_DATASET_REPO_ALT,
    QTYPES,
    QUESTIONS_FILT,
    QUESTIONS_RAW,
    is_already_ingested,
    ingest_text_full,
    setup_edu_bench_db,
    stable_material_id,
)

# ---------------------------------------------------------------------------
# HuggingFace helpers
# ---------------------------------------------------------------------------

def _hf_token(cli_token: str | None) -> str | None:
    return cli_token or os.environ.get("HF_TOKEN") or None


def _resolve_repo(token: str | None) -> str:
    """Try primary repo first; fall back to alternate if not found."""
    from huggingface_hub import list_repo_files
    for repo in (HF_DATASET_REPO, HF_DATASET_REPO_ALT):
        try:
            _ = next(iter(list_repo_files(repo, repo_type="dataset", token=token)))
            print(f"[hf] Using dataset repo: {repo}")
            return repo
        except Exception:
            continue
    raise RuntimeError(
        f"Could not access either HuggingFace repo:\n"
        f"  {HF_DATASET_REPO}\n  {HF_DATASET_REPO_ALT}\n"
        "Check your HF_TOKEN or network connectivity."
    )


def _hf_download_file(repo: str, hf_path: str, local_path: Path, token: str | None) -> Path:
    """Download a single file from HuggingFace if not already present."""
    from huggingface_hub import hf_hub_download

    if local_path.exists() and local_path.stat().st_size > 0:
        print(f"  [cache] {local_path.name} already exists, skipping download.")
        return local_path

    local_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  [dl] {hf_path} → {local_path} ...")
    downloaded = hf_hub_download(
        repo_id=repo,
        filename=hf_path,
        repo_type="dataset",
        token=token,
        local_dir=str(local_path.parent),
        local_dir_use_symlinks=False,
    )
    # hf_hub_download may nest the file; resolve to our expected path
    src = Path(downloaded)
    if src != local_path and src.exists():
        local_path.write_bytes(src.read_bytes())
    return local_path


def _list_repo_files_cached(repo: str, token: str | None) -> list[str]:
    from huggingface_hub import list_repo_files
    return list(list_repo_files(repo, repo_type="dataset", token=token))


# ---------------------------------------------------------------------------
# Sub-command: --list-topics
# ---------------------------------------------------------------------------

def cmd_list_topics(token: str | None, filter_topics: list[str] | None) -> None:
    """Download question jsonl files and print Level-1 Topic distribution."""
    print("\n=== Phase 0: Explore topic distribution ===\n")

    repo = _resolve_repo(token)
    all_files = _list_repo_files_cached(repo, token)

    # Find question files — try questions/, Question/, then root-level
    qfile_map: dict[str, str] = {}  # qtype -> hf_path
    for qtype in QTYPES:
        for candidate in (f"questions/{qtype}.jsonl", f"Question/{qtype}.jsonl", f"{qtype}.jsonl"):
            if candidate in all_files:
                qfile_map[qtype] = candidate
                break

    if not qfile_map:
        print("[error] No question jsonl files found in the dataset repo.")
        print("  Available files (first 30):", all_files[:30])
        sys.exit(1)

    print(f"Found question files: {list(qfile_map.values())}\n")

    # Download and parse
    topic_counter: Counter = Counter()
    topic_type_counter: dict[str, Counter] = defaultdict(Counter)
    total = 0

    for qtype, hf_path in qfile_map.items():
        local = QUESTIONS_RAW / f"{qtype}.jsonl"
        _hf_download_file(repo, hf_path, local, token)

        with open(local, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                topic = str(row.get("Level-1 Topic", row.get("level_1_topic", "Unknown"))).strip()
                topic_counter[topic] += 1
                topic_type_counter[topic][qtype] += 1
                total += 1

    print(f"Total questions: {total}\n")
    print(f"{'Level-1 Topic':<40} {'Total':>6}  {'FB':>4} {'MC':>4} {'MS':>4} {'OE':>4} {'TF':>4}")
    print("-" * 75)
    for topic, count in sorted(topic_counter.items(), key=lambda x: -x[1]):
        tc = topic_type_counter[topic]
        marker = " ◀" if filter_topics and any(t.lower() in topic.lower() for t in filter_topics) else ""
        print(
            f"{topic:<40} {count:>6}  "
            f"{tc.get('FB',0):>4} {tc.get('MC',0):>4} {tc.get('MS',0):>4} "
            f"{tc.get('OE',0):>4} {tc.get('TF',0):>4}{marker}"
        )

    print(f"\nQuestion files saved to: {QUESTIONS_RAW}")
    print("\nRecommended selection: 2-3 topics with ≥15 questions per type.")
    print("Next step:  python -m tests.eval.edu_bench.prepare_corpus --setup-db")


# ---------------------------------------------------------------------------
# Sub-command: --setup-db
# ---------------------------------------------------------------------------

def cmd_setup_db() -> None:
    """Create teacher / course / enrollment in the DB."""
    print("\n=== Phase 0: DB setup ===\n")
    setup_edu_bench_db()
    print("\nNext step:  python -m tests.eval.edu_bench.prepare_corpus --filter-questions --topics \"Cybersecurity,Information retrieval\"")


# ---------------------------------------------------------------------------
# Sub-command: --filter-questions
# ---------------------------------------------------------------------------

def cmd_filter_questions(topics: list[str]) -> None:
    """Filter raw question JSONL files by Level-1 Topic → filtered/ directory."""
    print(f"\n=== Filter questions: {topics} ===\n")
    topic_set_lower = {t.lower().strip() for t in topics}

    missing_raw = [qtype for qtype in QTYPES if not (QUESTIONS_RAW / f"{qtype}.jsonl").exists()]
    if missing_raw:
        print(f"[warn] Raw files missing for: {missing_raw}")
        print("       Run --list-topics first to download question files.")

    total_kept = 0
    for qtype in QTYPES:
        src = QUESTIONS_RAW / f"{qtype}.jsonl"
        if not src.exists():
            print(f"  [skip] {qtype}.jsonl — not in raw/")
            continue

        kept: list[str] = []
        with open(src, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                topic = str(row.get("Level-1 Topic", row.get("level_1_topic", ""))).strip()
                if topic.lower() in topic_set_lower:
                    kept.append(line)

        dest = QUESTIONS_FILT / f"{qtype}.jsonl"
        dest.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
        print(f"  {qtype}: {len(kept):>4} questions → {dest.name}")
        total_kept += len(kept)

    print(f"\nTotal filtered: {total_kept} questions")
    print(f"Saved to: {QUESTIONS_FILT}")
    print("\nNext step:  python -m tests.eval.edu_bench.prepare_corpus --ingest-all")


# ---------------------------------------------------------------------------
# Sub-command: --ingest-all
# ---------------------------------------------------------------------------

# Number of textbooks in the dataset (textbook1 … textbook20)
_TEXTBOOK_COUNT = 20

# Retry config for SiliconFlow TPM=50,000 free tier
_MAX_ATTEMPTS = 3
_RETRY_WAIT_BASE = 90  # seconds; attempt i waits _RETRY_WAIT_BASE * 2^(i-1)


# ---------------------------------------------------------------------------
# Core ingest loop — shared by --ingest-all and --ingest-one
# ---------------------------------------------------------------------------

def _ingest_books(
    book_numbers: list[int],
    repo: str,
    all_files_set: set[str],
    token: str | None,
    skip_ingest: bool,
) -> tuple[int, int, list[int]]:
    """Ingest the given textbook numbers.  Returns (done, skipped, failed).

    Uses tqdm for a book-level progress bar.
    Prints status lines via tqdm.write() to avoid clobbering the bar.
    Already-ingested books are skipped (idempotent / restart-safe).
    """
    from tqdm import tqdm  # local import so the module stays importable without tqdm

    available = [
        n for n in book_numbers
        if f"textbooks/textbook{n}/textbook{n}.md" in all_files_set
    ]
    for n in book_numbers:
        if n not in available:
            print(f"  [warn] textbook{n} not found in HF repo, skipping.")

    skipped, done, failed = 0, 0, []
    total = len(available)

    bar = tqdm(
        available,
        desc="Corpus ingest",
        unit="book",
        ncols=80,
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}<{remaining}]",
    )
    for n in bar:
        hf_path   = f"textbooks/textbook{n}/textbook{n}.md"
        local_path = CORPUS_DIR / f"textbook{n}" / f"textbook{n}.md"
        material_id = stable_material_id(f"edu_bench:textbook:{n}")

        bar.set_description(f"tb{n:>2}")

        # ------------------------------------------------------------------
        # Already ingested?
        # ------------------------------------------------------------------
        if not skip_ingest and is_already_ingested(COURSE_EDU_BENCH, material_id):
            tqdm.write(f"  [skip] textbook{n:>2}  ✓ already ingested")
            skipped += 1
            continue

        # ------------------------------------------------------------------
        # Download (cached on disk)
        # ------------------------------------------------------------------
        try:
            _hf_download_file(repo, hf_path, local_path, token)
        except Exception as exc:
            tqdm.write(f"  [ERR]  textbook{n:>2}  download failed: {exc}")
            failed.append(n)
            continue

        if skip_ingest:
            tqdm.write(f"  [dl]   textbook{n:>2}  {local_path.stat().st_size:,} bytes")
            done += 1
            continue

        # ------------------------------------------------------------------
        # Ingest with retry + elapsed-time display
        # ------------------------------------------------------------------
        text = local_path.read_text(encoding="utf-8", errors="replace")
        tqdm.write(f"  [go]   textbook{n:>2}  {len(text):,} chars — calling LightRAG ...")

        success = False
        t0 = time.time()
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                n_chunks = ingest_text_full(COURSE_EDU_BENCH, material_id, text, local_path.name)
                elapsed = time.time() - t0
                tqdm.write(
                    f"  [✓]   textbook{n:>2}  {n_chunks} chunks  "
                    f"({elapsed/60:.1f} min, attempt {attempt})"
                )
                success = True
                break
            except Exception as exc:
                wait = _RETRY_WAIT_BASE * (2 ** (attempt - 1))
                tqdm.write(f"  [!]   textbook{n:>2}  attempt {attempt}/{_MAX_ATTEMPTS}: {exc}")
                if attempt < _MAX_ATTEMPTS:
                    tqdm.write(f"        waiting {wait}s before retry ...")
                    time.sleep(wait)
                else:
                    tqdm.write(f"  [✗]   textbook{n:>2}  gave up after {_MAX_ATTEMPTS} attempts.")

        if success:
            done += 1
        else:
            failed.append(n)

    bar.close()
    return done, skipped, failed


def _print_ingest_env() -> None:
    print(f"Course  : {COURSE_EDU_BENCH}")
    print(f"Env     : CHUNK_SIZE={os.environ.get('CHUNK_SIZE', '(not set)')}")
    print(f"Env     : LLM_KG_MODEL={os.environ.get('LLM_KG_MODEL', '(not set)')}")
    print(f"Env     : LLM_MAX_ASYNC={os.environ.get('LLM_MAX_ASYNC', '(not set)')}")


def _print_ingest_summary(done: int, skipped: int, failed: list[int], next_hint: bool = True) -> None:
    print(f"\nSummary: done={done}  skipped={skipped}  failed={len(failed)}")
    if failed:
        print(f"  Failed textbooks: {failed}")
        print("  Re-run the same command to retry (already-done books are skipped automatically).")
    if next_hint and not failed:
        print("\nNext step:  python -m tests.eval.edu_bench.collect_graphrag --limit 5")


# Sub-command: --ingest-all
def cmd_ingest_all(token: str | None, skip_ingest: bool) -> None:
    """Download all 20 textbooks and ingest into COURSE_EDU_BENCH."""
    print(f"\n=== Phase 1: Full corpus ingest ({_TEXTBOOK_COUNT} textbooks) ===")
    _print_ingest_env()

    repo = _resolve_repo(token)
    all_files_set = set(_list_repo_files_cached(repo, token))

    book_numbers = list(range(1, _TEXTBOOK_COUNT + 1))
    available = [n for n in book_numbers if f"textbooks/textbook{n}/textbook{n}.md" in all_files_set]
    print(f"\nFound {len(available)}/{_TEXTBOOK_COUNT} textbook(s) in repo.\n")

    done, skipped, failed = _ingest_books(available, repo, all_files_set, token, skip_ingest)
    _print_ingest_summary(done, skipped, failed)


# Sub-command: --ingest-one N
def cmd_ingest_one(n: int, token: str | None, skip_ingest: bool) -> None:
    """Download and ingest a single textbook (useful for one-by-one testing)."""
    print(f"\n=== Ingest textbook{n} only ===")
    _print_ingest_env()
    print()

    repo = _resolve_repo(token)
    all_files_set = set(_list_repo_files_cached(repo, token))

    done, skipped, failed = _ingest_books([n], repo, all_files_set, token, skip_ingest)
    _print_ingest_summary(done, skipped, failed, next_hint=False)
    remaining = [i for i in range(1, _TEXTBOOK_COUNT + 1) if i != n]
    print(f"\nTo ingest the next book:  --ingest-one {remaining[0]}")
    print("When all books are done:  python -m tests.eval.edu_bench.collect_graphrag --limit 5")


# ---------------------------------------------------------------------------
# Sub-command: --register-materials
# ---------------------------------------------------------------------------

def cmd_register_materials() -> None:
    """Insert stub records into the `materials` table so textbooks appear in the front-end.

    Idempotent — uses ON CONFLICT (id) DO UPDATE to refresh status/chunk_count.
    Only registers textbooks whose local .md file already exists on disk
    (i.e. those downloaded by --ingest-one / --ingest-all --skip-ingest).

    Note: minioPath is set to a placeholder path.  The file is NOT uploaded to
    MinIO, so the "Download / Preview" button in the UI will fail — but the
    material will appear in the course material list with status READY.
    """
    import psycopg

    db_url = _get_db_url()  # app DB (not lightrag DB)
    dsn = _psycopg_dsn(db_url)

    registered, skipped_missing = 0, 0

    print(f"\n=== Register textbooks in materials table ===")
    print(f"Course: {COURSE_EDU_BENCH}\n")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            for n in range(1, _TEXTBOOK_COUNT + 1):
                local_path = CORPUS_DIR / f"textbook{n}" / f"textbook{n}.md"
                if not local_path.exists():
                    print(f"  [skip] textbook{n:>2} — local file not found ({local_path})")
                    skipped_missing += 1
                    continue

                material_id = stable_material_id(f"edu_bench:textbook:{n}")
                file_size   = local_path.stat().st_size
                filename    = local_path.name
                minio_path  = f"eval/edu_bench/textbook{n}/{filename}"  # placeholder

                # Count chunks from LightRAG if possible
                chunk_count = _count_lightrag_chunks(COURSE_EDU_BENCH, material_id)

                cur.execute(
                    """
                    INSERT INTO materials
                        (id, course_id, lesson_id, original_filename, file_type,
                         file_size, minio_path, preview_pdf_status, status,
                         status_message, indexed_chunk_count, is_deleted,
                         created_at, updated_at)
                    VALUES
                        (%s, %s, NULL, %s, 'text/markdown',
                         %s, %s, 'NA', 'READY',
                         NULL, %s, false,
                         NOW(), NOW())
                    ON CONFLICT (id) DO UPDATE
                        SET status             = 'READY',
                            indexed_chunk_count = EXCLUDED.indexed_chunk_count,
                            updated_at          = NOW()
                    """,
                    (material_id, COURSE_EDU_BENCH, filename,
                     file_size, minio_path, chunk_count),
                )
                print(
                    f"  [ok]   textbook{n:>2}  id={material_id[:8]}...  "
                    f"{file_size:,} bytes  {chunk_count} chunks"
                )
                registered += 1

        conn.commit()

    print(f"\nRegistered {registered} textbook(s), skipped {skipped_missing} (no local file).")
    print("Tip: front-end preview/download will not work (file not in MinIO), but")
    print("     the materials will appear in the course list with status READY.")


def _count_lightrag_chunks(course_id: str, material_id: str) -> int:
    """Query lightrag_doc_chunks to count how many chunks were indexed for this material."""
    import psycopg
    from rag_mvp.engine import material_stable_doc_id
    from rag_mvp.course_workspace import course_id_to_workspace

    try:
        # _lightrag_dsn is a private helper in _common; import directly
        import importlib
        _common = importlib.import_module("tests.eval._common")
        dsn = _common._lightrag_dsn()
    except Exception:
        return 0

    doc_id    = material_stable_doc_id(material_id)
    workspace = course_id_to_workspace(course_id)
    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM lightrag_doc_chunks"
                    " WHERE workspace = %s AND full_doc_id = %s",
                    (workspace, doc_id),
                )
                row = cur.fetchone()
                return int(row[0]) if row else 0
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare PolyU GraphRAG-Bench data for the edu_bench evaluation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list-topics",         action="store_true",    help="Print topic distribution.")
    group.add_argument("--setup-db",             action="store_true",    help="Create DB records.")
    group.add_argument("--filter-questions",     action="store_true",    help="Filter questions by topic.")
    group.add_argument("--ingest-all",           action="store_true",    help="Download + ingest all 20 textbooks.")
    group.add_argument("--ingest-one",           type=int, metavar="N", help="Download + ingest only textbook N (1-20).")
    group.add_argument("--register-materials",   action="store_true",    help="Insert stub materials rows so textbooks appear in the UI.")

    parser.add_argument(
        "--topics", type=str, default=None,
        help='Comma-separated Level-1 Topic names, e.g. "Cybersecurity,Information retrieval"',
    )
    parser.add_argument("--hf-token",    type=str,  default=None, help="HuggingFace API token.")
    parser.add_argument("--skip-ingest", action="store_true",     help="Download only, skip ingest.")

    args = parser.parse_args()

    topics: list[str] | None = (
        [t.strip() for t in args.topics.split(",") if t.strip()] if args.topics else None
    )
    token = _hf_token(args.hf_token)

    if args.list_topics:
        cmd_list_topics(token, topics)
    elif args.setup_db:
        cmd_setup_db()
    elif args.filter_questions:
        if not topics:
            parser.error("--filter-questions requires --topics")
        cmd_filter_questions(topics)
    elif args.ingest_all:
        cmd_ingest_all(token, args.skip_ingest)
    elif args.ingest_one is not None:
        if not (1 <= args.ingest_one <= _TEXTBOOK_COUNT):
            parser.error(f"--ingest-one must be between 1 and {_TEXTBOOK_COUNT}")
        cmd_ingest_one(args.ingest_one, token, args.skip_ingest)
    elif args.register_materials:
        cmd_register_materials()


if __name__ == "__main__":
    main()

