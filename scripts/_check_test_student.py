import psycopg, os
from dotenv import load_dotenv

load_dotenv('edu-platform/.env', override=False)
db_url = os.environ.get('DATABASE_URL', '').split('?')[0]
conn = psycopg.connect(db_url)

rows = conn.execute(
    "SELECT id, username, role, student_id FROM users "
    "WHERE username LIKE 'test%' OR username LIKE 'tstu%' "
    "   OR student_id LIKE 'test%' OR student_id LIKE 'S20%' "
    "ORDER BY created_at DESC"
).fetchall()
print('test users:', rows)
print('total users:', conn.execute('SELECT COUNT(*) FROM users').fetchone()[0])
conn.close()
