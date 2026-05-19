"""Verify the relabeled node can be found by entity_id."""
from neo4j import GraphDatabase

driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "edu_neo4j_password"))
ws = "course_c0000002-0000-4000-8000-000000000000"

with driver.session(database="neo4j") as s:
    r = s.run(
        f"MATCH (n:`{ws}` {{entity_id: $eid}}) RETURN n.entity_id, n.entity_type",
        eid="King Nebuchadnezzar",
    )
    rows = list(r)
    if rows:
        print("Found node:", rows[0].data())
    else:
        print("Node NOT found")

    # Count total nodes with new label
    r = s.run(f"MATCH (n:`{ws}`) RETURN count(n) as cnt")
    print(f"Total nodes with new label: {r.single()['cnt']}")

driver.close()
