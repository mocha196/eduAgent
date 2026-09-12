from __future__ import annotations

import json

from rag_mvp.tracing import end_span, generation
from tests.eval.collect_answers_agentic import _parse_sse_stream


class _FakeResponse:
    def __init__(self, events: list[dict]):
        self._lines = [f"data: {json.dumps(event)}" for event in events]

    def iter_lines(self):
        return iter(self._lines)


class _FakeObservation:
    def __init__(self):
        self.updated: dict = {}
        self.ended = False

    def update(self, **kwargs):
        self.updated.update(kwargs)
        return self

    def end(self):
        self.ended = True


class _FakeTrace:
    def __init__(self):
        self.kwargs: dict = {}
        self.observation = _FakeObservation()

    def start_observation(self, **kwargs):
        self.kwargs = kwargs
        return self.observation


def test_agentic_sse_pairs_tool_result_with_call() -> None:
    response = _FakeResponse([
        {"type": "tool_call", "tool_call_id": "tc-1", "name": "knowledge_query", "input": {"q": "TCP"}},
        {"type": "tool_result", "tool_call_id": "tc-1", "name": "knowledge_query", "success": True, "duration_ms": 42},
        {"type": "text", "content": "answer"},
        {"type": "done"},
    ])

    answer, contexts, calls = _parse_sse_stream(response)  # type: ignore[arg-type]

    assert answer == "answer"
    assert contexts == []
    assert calls == [{
        "tool_call_id": "tc-1",
        "name": "knowledge_query",
        "input": {"q": "TCP"},
        "success": True,
        "duration_ms": 42,
    }]


def test_python_generation_records_model_usage_and_status() -> None:
    trace = _FakeTrace()
    observation = generation(trace, "question", "model-x", input="prompt")  # type: ignore[arg-type]

    assert trace.kwargs["as_type"] == "generation"
    assert trace.kwargs["model"] == "model-x"

    end_span(
        observation,  # type: ignore[arg-type]
        output="answer",
        usage_details={"input": 3, "output": 2, "total": 5},
    )
    assert trace.observation.updated["usage_details"]["total"] == 5
    assert trace.observation.ended is True
