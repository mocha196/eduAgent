import psycopg
conn = psycopg.connect('postgresql://edu:edu@localhost:5432/edu_platform')
rows = conn.execute("""
  SELECT a.course_id, a.id as assignment_id, a.title, a.status, 
         COUNT(s.id) as submissions, 
         COUNT(CASE WHEN s.status IN ('GRADED','RETURNED') THEN 1 END) as graded
  FROM assignments a
  LEFT JOIN assignment_submissions s ON s.assignment_id = a.id
  GROUP BY a.course_id, a.id, a.title, a.status
  ORDER BY graded DESC
  LIMIT 10
""").fetchall()
for r in rows:
    print(r)
conn.close()
