"""The Next.js initial-task manifest must remain consumable by the Python worker."""

import json
from pathlib import Path

from rag_mvp.task_handlers import TASK_HANDLERS


def test_initial_material_operations_have_worker_handlers() -> None:
    contract_path = (
        Path(__file__).resolve().parents[2]
        / "edu-platform"
        / "lib"
        / "material-ingestion.contract.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))

    assert contract["version"] == 1
    expected_kinds = {"office", "media", "document"}
    assert set(contract["initial_operations"]) == {"course", "personal"}
    for scope, operations in contract["initial_operations"].items():
        assert set(operations) == expected_kinds, scope
        for kind, operation in operations.items():
            assert operation in TASK_HANDLERS, (scope, kind, operation)
