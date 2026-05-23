"""
Repair chunk_page_mappings for materials where it is empty.

Strategy:
1. Find all materials that have material_images rows but 0 chunk_page_mappings rows.
2. For each such material, fetch its LightRAG chunks from edu_lightrag.lightrag_doc_chunks
   that look like image/visual surrogates (contain "File: <sha256>.jpg").
3. Download every MinIO image for the material, compute SHA-256 of its bytes,
   then match against the SHA-256 filenames extracted from chunk texts.
4. Page index is encoded in the MinIO object key:  p{page_idx:04d}_{sha12}.ext
5. Insert the resolved (material_id, chunk_id, page_idx) rows into chunk_page_mappings.

Run:
    cd e:\appProjects\eee
    .venv\Scripts\python.exe scripts\_repair_chunk_page_mappings.py [material_id ...]

If no material_id arguments are given, repairs ALL materials with missing mappings.
"""
import sys
import re
import hashlib
import urllib.request
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
import os

sys.path.insert(0, "src")
from dotenv import load_dotenv

load_dotenv(".env", override=False)
load_dotenv("edu-platform/.env.local", override=False)

import psycopg  # type: ignore

# ── DB helpers ──────────────────────────────────────────────────────────────

def _app_dsn() -> str:
    raw = os.environ["DATABASE_URL"]
    p = urlparse(raw)
    qs = {k: v for k, v in parse_qs(p.query).items() if k in ("sslmode", "connect_timeout")}
    return urlunparse(p._replace(query=urlencode({k: v[0] for k, v in qs.items()})))


def _lightrag_conn():
    return psycopg.connect("host=localhost dbname=edu_lightrag user=edu password=edu")


# ── Core logic ──────────────────────────────────────────────────────────────

_FILE_RE = re.compile(r"File:\s*([0-9a-f]{60,})\.[a-zA-Z]+", re.IGNORECASE)
_PAGE_RE = re.compile(r"/p(\d{4})_[0-9a-f]+\.")


def _sha256_url(url: str) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = resp.read()
        return hashlib.sha256(data).hexdigest()
    except Exception as exc:
        print(f"    [WARN] failed to fetch {url}: {exc}")
        return None


def repair_material(material_id: str, app_conn: psycopg.Connection, lg_conn) -> int:
    """Return number of new mappings inserted."""

    # 1. Fetch MinIO image records for this material
    with app_conn.cursor() as cur:
        cur.execute(
            "SELECT page_idx, minio_url FROM material_images WHERE material_id=%s::uuid ORDER BY page_idx",
            (material_id,),
        )
        minio_rows = cur.fetchall()  # [(page_idx, url), ...]

    if not minio_rows:
        print(f"  [SKIP] no material_images rows for {material_id}")
        return 0

    print(f"  Downloading {len(minio_rows)} MinIO images to build SHA-256 map …")
    # page_idx can appear multiple times (multiple images per page)
    # build: sha256 → [(page_idx, url), ...]
    sha256_to_pages: dict[str, list[tuple[int, str]]] = {}
    for page_idx, url in minio_rows:
        sha = _sha256_url(url)
        if sha:
            sha256_to_pages.setdefault(sha, []).append((page_idx, url))

    if not sha256_to_pages:
        print(f"  [SKIP] could not download any images for {material_id}")
        return 0

    print(f"  Built SHA-256 map with {len(sha256_to_pages)} distinct images.")

    # 2. Fetch LightRAG chunks for this material
    #    file_path has the form  mat_{material_id}_{...}
    file_path_prefix = f"mat_{material_id}_"
    lg_cur = lg_conn.cursor()
    lg_cur.execute(
        "SELECT id, content FROM lightrag_doc_chunks WHERE file_path LIKE %s",
        (file_path_prefix + "%",),
    )
    chunks = lg_cur.fetchall()  # [(chunk_id, content), ...]
    print(f"  Found {len(chunks)} lightrag chunks for file_path prefix '{file_path_prefix}*'")

    # 3. Match chunk SHA-256 filenames → page_idx
    mappings: list[tuple[str, str, int]] = []  # (material_id, chunk_id, page_idx)
    for chunk_id, content in chunks:
        m = _FILE_RE.search(content or "")
        if not m:
            continue
        file_sha = m.group(1).lower()
        hits = sha256_to_pages.get(file_sha)
        if not hits:
            print(f"    [MISS] chunk {chunk_id}: SHA {file_sha[:20]}… not found in MinIO images")
            continue
        for page_idx, url in hits:
            mappings.append((material_id, chunk_id, page_idx))
            print(f"    [MATCH] chunk {chunk_id} → page {page_idx}  ({url.rsplit('/',1)[-1]})")

    if not mappings:
        print(f"  [SKIP] no matches found for {material_id}")
        return 0

    # 4. Insert into chunk_page_mappings
    with app_conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO chunk_page_mappings (id, material_id, chunk_id, page_idx)
            VALUES (gen_random_uuid(), %s::uuid, %s, %s)
            ON CONFLICT (material_id, chunk_id) DO UPDATE SET page_idx = EXCLUDED.page_idx
            """,
            mappings,
        )
    app_conn.commit()
    print(f"  ✓ Inserted/updated {len(mappings)} chunk_page_mappings rows for {material_id}")
    return len(mappings)


def find_materials_needing_repair(app_conn: psycopg.Connection) -> list[str]:
    """Materials that have images but no chunk_page_mappings."""
    with app_conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT mi.material_id::text
            FROM material_images mi
            WHERE NOT EXISTS (
                SELECT 1 FROM chunk_page_mappings cpm
                WHERE cpm.material_id = mi.material_id
            )
            """
        )
        return [str(r[0]) for r in cur.fetchall()]


def main() -> None:
    explicit_ids = [a for a in sys.argv[1:] if not a.startswith("-")]
    app_dsn = _app_dsn()

    with psycopg.connect(app_dsn, autocommit=False) as app_conn:
        lg_conn = _lightrag_conn()
        try:
            if explicit_ids:
                material_ids = explicit_ids
            else:
                material_ids = find_materials_needing_repair(app_conn)
                print(f"Found {len(material_ids)} materials needing repair:")
                for m in material_ids:
                    print(f"  {m}")

            total = 0
            for mid in material_ids:
                print(f"\n=== {mid} ===")
                total += repair_material(mid, app_conn, lg_conn)

            print(f"\nDone. Total mappings inserted/updated: {total}")
        finally:
            lg_conn.close()


if __name__ == "__main__":
    main()
