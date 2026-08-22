"""One-time copy of legacy vector chunks into the new pgvector schema.

The source database is read-only. Existing chunk IDs are preserved so current
`material_chunk_pages` citation mappings continue to resolve after cut-over.

Required environment variables:
  LEGACY_RAG_PG_DSN  source database containing LIGHTRAG_VDB_CHUNKS
  RAG_PG_DSN         target database for rag_documents / rag_chunks
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rag_mvp.vector_store import _dsn as target_dsn
from rag_mvp.vector_store import ensure_schema


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _ensure_target_database(dsn: str) -> None:
    """Create the target database when upgrading an existing Compose volume."""
    parsed = urlparse(dsn)
    database = parsed.path.lstrip("/")
    if not database or database == "postgres":
        return
    admin_dsn = urlunparse(parsed._replace(path="/postgres", query=""))
    try:
        with psycopg.connect(admin_dsn, autocommit=True) as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database,))
            if cur.fetchone() is None:
                cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
                print(f"Created target database {database}.")
    except psycopg.Error as exc:
        raise RuntimeError(
            f"Target database {database!r} is unavailable and could not be created. "
            "Create it with a database-admin account, then rerun this script."
        ) from exc


def main() -> None:
    source_dsn = _required_env("LEGACY_RAG_PG_DSN")
    _ensure_target_database(target_dsn())
    ensure_schema()

    with psycopg.connect(source_dsn) as source, psycopg.connect(target_dsn()) as target:
        with source.cursor() as src, target.cursor() as dst:
            src.execute(
                """
                SELECT workspace, id, full_doc_id, content, COALESCE(file_path, ''),
                       COALESCE(chunk_order_index, 0), content_vector::text
                FROM LIGHTRAG_VDB_CHUNKS
                WHERE content IS NOT NULL AND content_vector IS NOT NULL
                ORDER BY workspace, full_doc_id, chunk_order_index
                """
            )
            rows = src.fetchall()
            document_counts = Counter((str(row[0]), str(row[2])) for row in rows)

            for (workspace, document_id), count in document_counts.items():
                first = next(row for row in rows if str(row[0]) == workspace and str(row[2]) == document_id)
                dst.execute(
                    """
                    INSERT INTO rag_documents
                        (workspace, id, file_path, status, chunks_count, metadata)
                    VALUES (%s, %s, %s, 'processed', %s, %s::jsonb)
                    ON CONFLICT (workspace, id) DO UPDATE SET
                        file_path = EXCLUDED.file_path,
                        status = 'processed',
                        chunks_count = EXCLUDED.chunks_count,
                        metadata = EXCLUDED.metadata,
                        updated_at = now()
                    """,
                    (workspace, document_id, str(first[4]), count, json.dumps({"migrated": True})),
                )

            dst.executemany(
                """
                INSERT INTO rag_chunks
                    (workspace, id, document_id, content, file_path,
                     chunk_order_index, metadata, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::vector)
                ON CONFLICT (workspace, id) DO UPDATE SET
                    document_id = EXCLUDED.document_id,
                    content = EXCLUDED.content,
                    file_path = EXCLUDED.file_path,
                    chunk_order_index = EXCLUDED.chunk_order_index,
                    metadata = EXCLUDED.metadata,
                    embedding = EXCLUDED.embedding
                """,
                [
                    (
                        str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4]),
                        int(row[5]), json.dumps({"migrated": True}), str(row[6]),
                    )
                    for row in rows
                ],
            )
        target.commit()

    print(f"Migrated {len(rows)} chunks across {len(document_counts)} documents.")


if __name__ == "__main__":
    main()
