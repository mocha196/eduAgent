"""
Relabel Neo4j nodes from old workspace label to correct one.
Old: course_c0000002-0000-0000-0000-000000000000
New: course_c0000002-0000-4000-8000-000000000000
"""
from neo4j import GraphDatabase

OLD = "course_c0000002-0000-0000-0000-000000000000"
NEW = "course_c0000002-0000-4000-8000-000000000000"

driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "edu_neo4j_password"))

with driver.session(database="neo4j") as s:
    # Count before
    r = s.run(f"MATCH (n:`{OLD}`) RETURN count(n) as cnt")
    before = r.single()["cnt"]
    print(f"Nodes with old label: {before}")

    r = s.run(f"MATCH (n:`{NEW}`) RETURN count(n) as cnt")
    print(f"Nodes with new label (before): {r.single()['cnt']}")

    if before == 0:
        print("Nothing to migrate.")
    else:
        # Relabel in batches of 2000
        total_relabeled = 0
        batch = 2000
        while True:
            result = s.run(
                f"""
                MATCH (n:`{OLD}`)
                WITH n LIMIT {batch}
                SET n:`{NEW}`
                REMOVE n:`{OLD}`
                RETURN count(n) as relabeled
                """
            )
            count = result.single()["relabeled"]
            total_relabeled += count
            print(f"  Relabeled {count} nodes (total: {total_relabeled})")
            if count == 0:
                break

        # Verify
        r = s.run(f"MATCH (n:`{OLD}`) RETURN count(n) as cnt")
        remaining = r.single()["cnt"]
        r = s.run(f"MATCH (n:`{NEW}`) RETURN count(n) as cnt")
        new_count = r.single()["cnt"]
        print(f"\nAfter migration:")
        print(f"  Old label nodes remaining: {remaining}")
        print(f"  New label nodes: {new_count}")

driver.close()
print("Done.")
