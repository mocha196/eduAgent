"""Aggregate publication-time AI question adoption metrics from PostgreSQL.

Usage:
  python -m tests.eval.eval_question_adoption
  python -m tests.eval.eval_question_adoption --output tests/eval/results/question_adoption.json
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from rag_mvp.db import connect_sync


def collect() -> dict:
    with connect_sync() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, adoption_metrics
            FROM assignments
            WHERE status = 'PUBLISHED' AND adoption_metrics IS NOT NULL
            ORDER BY published_at
            """
        )
        rows = cur.fetchall()

    metrics = [row[1] if isinstance(row[1], dict) else json.loads(row[1]) for row in rows]
    totals = {
        key: sum(int(item.get(key, 0)) for item in metrics)
        for key in (
            "generatedCount", "retainedCount", "unchangedCount", "modifiedCount",
            "deletedCount", "teacherAddedCount",
        )
    }
    generated = totals["generatedCount"]
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "publishedAssignmentSampleSize": len(rows),
        **totals,
        "adoptionRate": totals["retainedCount"] / generated if generated else None,
        "directAdoptionRate": totals["unchangedCount"] / generated if generated else None,
        "assignmentIds": [row[0] for row in rows],
    }


def main(output: str) -> None:
    report = collect()
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default="tests/eval/results/question_adoption.json",
        help="Output JSON path",
    )
    args = parser.parse_args()
    main(args.output)
