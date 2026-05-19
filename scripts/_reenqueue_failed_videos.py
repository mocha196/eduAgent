"""Re-enqueue UPLOADED video/audio materials for transcription."""
import os, uuid
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv("edu-platform/.env")

import redis as _r
import psycopg

db_url = os.environ["DATABASE_URL"].replace("?schema=public", "")
redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
stream = os.environ.get("RAG_TASK_STREAM", "rag_tasks")

VIDEO_AUDIO_TYPES = ("mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "m4a", "ogg", "flac")
placeholders = ",".join(["%s"] * len(VIDEO_AUDIO_TYPES))

with psycopg.connect(db_url) as conn:
    rows = conn.execute(
        f"SELECT id FROM materials WHERE file_type IN ({placeholders}) AND status='UPLOADED'",
        VIDEO_AUDIO_TYPES,
    ).fetchall()

r = _r.from_url(redis_url)
for (mid,) in rows:
    r.xadd(stream, {
        "task_id": str(uuid.uuid4()),
        "material_id": str(mid),
        "operation": "transcribe_and_index",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "text_only": "true",
        "skip_kg": "true",
    })
    print(f"Enqueued transcribe_and_index for material {mid}")

print(f"Total enqueued: {len(rows)}")
