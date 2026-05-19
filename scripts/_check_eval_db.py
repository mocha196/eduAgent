"""Check enrollment FKs after course ID migration."""
import sys
sys.path.insert(0, "src")
from dotenv import load_dotenv
load_dotenv(".env", override=False)

import os
import psycopg
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

raw = os.environ["DATABASE_URL"]
p = urlparse(raw)
qs = {k: v for k, v in parse_qs(p.query).items() if k in ("sslmode", "connect_timeout")}
dsn = urlunparse(p._replace(query=urlencode({k: v[0] for k, v in qs.items()})))

with psycopg.connect(dsn) as conn:
    with conn.cursor() as cur:
        # Check enrollments for our eval courses
        cur.execute(
            "SELECT course_id::text, student_id::text FROM course_enrollments "
            "WHERE course_id::text LIKE 'c00000%' OR student_id::text LIKE 'e00000%'"
        )
        rows = cur.fetchall()
        print(f"Enrollments: {rows}")

        # Check FK constraints on course_enrollments
        cur.execute("""
            SELECT conname, confupdtype, confdeltype
            FROM pg_constraint
            JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
            WHERE pg_class.relname = 'course_enrollments' AND contype = 'f'
        """)
        print("FK constraints:", cur.fetchall())

        # Check courses
        cur.execute(
            "SELECT id::text, name FROM courses WHERE id::text LIKE 'c00000%'"
        )
        print("Courses:", cur.fetchall())

        # Check users
        cur.execute(
            "SELECT id::text, username FROM users WHERE id::text LIKE 'e00000%'"
        )
        print("Users:", cur.fetchall())
