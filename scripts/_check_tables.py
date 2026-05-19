"""Check edu_platform DB table names."""
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

sql_tables = (
    "SELECT table_schema, table_name "
    "FROM information_schema.tables "
    "WHERE table_schema NOT IN ('pg_catalog','information_schema') "
    "ORDER BY table_schema, table_name LIMIT 40"
)
sql_schema = "SELECT current_schema(), current_setting('search_path')"

with psycopg.connect(dsn) as conn:
    with conn.cursor() as cur:
        cur.execute(sql_schema)
        print("schema info:", cur.fetchone())
        cur.execute(sql_tables)
        for row in cur.fetchall():
            print(row)
