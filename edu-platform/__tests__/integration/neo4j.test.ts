/**
 * Integration tests: Neo4j graph database
 *
 * Uses the Neo4j HTTP Transactional Cypher API (no extra driver package needed).
 * Credentials from docker-compose.yml: neo4j / edu_neo4j_password
 *
 * TC-NEO4J-001: HTTP API connectivity + Cypher RETURN
 * TC-NEO4J-002: Node count query on the real graph data
 */
import { describe, expect, it } from "vitest";

const NEO4J_URL = "http://localhost:7474";
const NEO4J_AUTH = `Basic ${Buffer.from("neo4j:edu_neo4j_password").toString("base64")}`;
const TX_ENDPOINT = `${NEO4J_URL}/db/neo4j/tx/commit`;

async function runCypher(
  statement: string,
  parameters: Record<string, unknown> = {},
) {
  const res = await fetch(TX_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: NEO4J_AUTH,
    },
    body: JSON.stringify({ statements: [{ statement, parameters }] }),
  });
  if (!res.ok) {
    throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    results: Array<{ columns: string[]; data: Array<{ row: unknown[] }> }>;
    errors: Array<{ code: string; message: string }>;
  };
  if (json.errors.length > 0) {
    throw new Error(`Neo4j error: ${json.errors[0]?.message}`);
  }
  return json.results;
}

describe("Neo4j integration", () => {
  // ─── TC-NEO4J-001: Connectivity ────────────────────────────────────────────

  describe("TC-NEO4J-001: HTTP API connectivity", () => {
    it("GET / returns neo4j metadata", async () => {
      const res = await fetch(NEO4J_URL, {
        headers: { Authorization: NEO4J_AUTH },
      });
      expect(res.ok).toBe(true);
      const json = (await res.json()) as { bolt_routing?: unknown; bolt_direct?: unknown };
      // Neo4j root endpoint returns bolt connection URLs
      expect(json).toHaveProperty("bolt_routing");
    });

    it("RETURN 1 Cypher query executes successfully", async () => {
      const results = await runCypher("RETURN 1 AS ping");
      expect(results[0]?.columns).toContain("ping");
      expect(results[0]?.data[0]?.row[0]).toBe(1);
    });

    it("timestamp query returns a valid number", async () => {
      const results = await runCypher("RETURN timestamp() AS ts");
      const ts = results[0]?.data[0]?.row[0] as number;
      expect(typeof ts).toBe("number");
      expect(ts).toBeGreaterThan(0);
    });
  });

  // ─── TC-NEO4J-002: Graph data inspection ───────────────────────────────────

  describe("TC-NEO4J-002: graph data", () => {
    it("node label count query returns a numeric result", async () => {
      const results = await runCypher("MATCH (n) RETURN count(n) AS total");
      const total = results[0]?.data[0]?.row[0] as number;
      expect(typeof total).toBe("number");
      expect(total).toBeGreaterThanOrEqual(0);
    });

    it("database info query returns neo4j version info", async () => {
      const results = await runCypher(
        "CALL dbms.components() YIELD name, versions RETURN name, versions LIMIT 1",
      );
      expect(results[0]?.data.length).toBeGreaterThan(0);
      const row = results[0]?.data[0]?.row as [string, string[]];
      expect(row[0]).toContain("Neo4j");
      expect(row[1][0]).toMatch(/^\d+\.\d+/);
    });
  });
});
