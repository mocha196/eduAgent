import psycopg
conn = psycopg.connect('postgresql://edu:edu@localhost:5432/edu_platform')
rows = conn.execute("SELECT username, password_hash FROM users WHERE role='TEACHER' LIMIT 3").fetchall()
for r in rows:
    print(r[0], r[1][:50])
conn.close()
