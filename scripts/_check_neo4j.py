"""Check Neo4j labels (workspaces) and their counts."""
from neo4j import GraphDatabase

driver = GraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "edu_neo4j_password"))

with driver.session(database="neo4j") as s:
    # Count nodes per label (= per workspace)
    r = s.run("CALL db.labels() YIELD label RETURN label")
    labels = [row["label"] for row in r]
    print("=== Node labels (workspaces) ===")
    for lbl in labels:
        r2 = s.run(f"MATCH (n:`{lbl}`) RETURN count(n) as cnt")
        print(f"  {lbl}: {r2.single()['cnt']} nodes")

    # Count relation types
    r = s.run("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType")
    rtypes = [row["relationshipType"] for row in r]
    print("\n=== Relation types ===")
    for rt in rtypes:
        r2 = s.run(f"MATCH ()-[r:`{rt}`]->() RETURN count(r) as cnt")
        print(f"  {rt}: {r2.single()['cnt']} rels")

driver.close()

