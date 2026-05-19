"""Reset FAILED video/audio materials to UPLOADED so the worker can retry."""
import os, psycopg
from dotenv import load_dotenv

load_dotenv("edu-platform/.env")
url = os.environ["DATABASE_URL"].replace("?schema=public", "")

VIDEO_AUDIO_TYPES = ("mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "m4a", "ogg", "flac")
placeholders = ",".join(["%s"] * len(VIDEO_AUDIO_TYPES))

with psycopg.connect(url, autocommit=True) as conn:
    n = conn.execute(
        f"UPDATE materials SET status='UPLOADED', status_message=NULL, updated_at=NOW() "
        f"WHERE file_type IN ({placeholders}) AND status='FAILED'",
        VIDEO_AUDIO_TYPES,
    ).rowcount
    print(f"Reset {n} FAILED video/audio material(s) to UPLOADED")
