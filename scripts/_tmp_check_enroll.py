import psycopg
conn = psycopg.connect("postgresql://edu:edu@localhost:5432/edu_platform")
# columns
cols = conn.execute(
    "SELECT column_name FROM information_schema.columns WHERE table_name='course_enrollments' ORDER BY ordinal_position"
).fetchall()
print("columns:", [c[0] for c in cols])

# enrollments for mock_student_01
rows = conn.execute("""
    SELECT u.username, e.student_id, e.course_id
    FROM users u
    JOIN course_enrollments e ON e.student_id = u.id
    WHERE u.username = 'mock_student_01'
""").fetchall()
print("enrollments:", rows)

# also show all courses
courses = conn.execute("SELECT id, name FROM courses LIMIT 10").fetchall()
print("courses:", courses)
conn.close()
