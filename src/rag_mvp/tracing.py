"""Langfuse tracing adapter for the Python RAG / assignment-generation pipeline.

Gracefully degrades to a no-op when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
are not set in the environment, so this module is safe to import unconditionally.

Compatible with langfuse >= 4.x (start_observation / span.start_observation API).
"""

from __future__ import annotations

import os
import contextvars
from typing import TYPE_CHECKING, Any

from loguru import logger

try:
    from langfuse import Langfuse
    from langfuse._client.span import LangfuseSpan
    from langfuse.types import TraceContext

    _LANGFUSE_AVAILABLE = True
except ImportError:
    _LANGFUSE_AVAILABLE = False

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Lazy singleton client
# ---------------------------------------------------------------------------

_client: "Langfuse | None | bool" = False  # False = not yet initialised
_current_trace: contextvars.ContextVar["LangfuseSpan | None"] = contextvars.ContextVar(
    "langfuse_current_trace", default=None
)


def get_current_trace() -> "LangfuseSpan | None":
    return _current_trace.get()


def clear_current_trace() -> None:
    _current_trace.set(None)


def get_langfuse_client() -> "Langfuse | None":
    """Return a shared Langfuse client, or None if credentials are not configured."""
    global _client
    if _client is not False:
        return _client  # type: ignore[return-value]

    if not _LANGFUSE_AVAILABLE:
        logger.debug("[Langfuse] library not installed – tracing disabled")
        _client = None
        return None

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
    if not public_key or not secret_key:
        logger.debug("[Langfuse] LANGFUSE_PUBLIC_KEY/SECRET_KEY not set – tracing disabled")
        _client = None
        return None

    base_url = os.environ.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com").strip()
    try:
        _client = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            host=base_url,
        )
        logger.info("[Langfuse] client initialised (host={})", base_url)
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] client init failed: {}", exc)
        _client = None
    return _client  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Helpers for assignment pipeline
# ---------------------------------------------------------------------------


def create_assignment_trace(
    assignment_id: str,
    course_id: str,
    teacher_request: str,
) -> "LangfuseSpan | None":
    """Create a root span that acts as the Langfuse trace for one assignment run.

    In langfuse v4 a trace is simply a root-level start_observation with only
    trace_id in the TraceContext (no parent_span_id).  Returns None when tracing
    is disabled (no-op caller pattern).
    """
    client = get_langfuse_client()
    if client is None:
        return None
    try:
        trace_id = Langfuse.create_trace_id(seed=f"assign-{assignment_id}")
        trace_ctx = TraceContext(trace_id=trace_id)
        root = client.start_observation(
            trace_context=trace_ctx,
            name="assignment.generate",
            input=teacher_request,
            metadata={"assignment_id": assignment_id, "course_id": course_id},
        )
        root.set_trace_io(input=teacher_request)
        _current_trace.set(root)
        return root  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] create_assignment_trace failed: {}", exc)
        return None


def span(
    trace: "LangfuseSpan | None",
    name: str,
    input: Any = None,
) -> "LangfuseSpan | None":
    """Start a child span on *trace*.  Returns None when tracing is disabled."""
    if trace is None:
        return None
    try:
        return trace.start_observation(name=name, input=input)  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] span '{}' failed: {}", name, exc)
        return None


def end_span(
    sp: "LangfuseSpan | None",
    output: Any = None,
    *,
    usage_details: "dict | None" = None,
    level: str | None = None,
    status_message: str | None = None,
) -> None:
    """End a span (no-op if None)."""
    if sp is None:
        return
    try:
        updates: dict[str, Any] = {}
        if output is not None:
            updates["output"] = output
        if usage_details:
            updates["usage_details"] = usage_details
        if level:
            updates["level"] = level
        if status_message:
            updates["status_message"] = status_message
        if updates:
            sp.update(**updates)
        sp.end()
        if sp is _current_trace.get():
            _current_trace.set(None)
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] end_span failed: {}", exc)


def create_trace(
    name: str,
    input: Any = None,
    metadata: "dict | None" = None,
) -> "LangfuseSpan | None":
    """Create a generic root trace (not scoped to assignment pipeline).

    Use this for video-summary, mindmap, rag-eval, etc.
    Returns None when tracing is disabled.
    """
    client = get_langfuse_client()
    if client is None:
        return None
    try:
        trace_ctx = TraceContext(trace_id=Langfuse.create_trace_id())
        root = client.start_observation(
            trace_context=trace_ctx,
            name=name,
            input=input,
            metadata=metadata or {},
        )
        root.set_trace_io(input=input)
        _current_trace.set(root)
        return root  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] create_trace '{}' failed: {}", name, exc)
        return None


def generation(
    trace: "LangfuseSpan | None",
    name: str,
    model: str,
    input: Any = None,
    output: Any = None,
    metadata: "dict | None" = None,
) -> "LangfuseSpan | None":
    """Start a *generation* child observation (records model + token usage).

    Call ``end_span(sp, output=...)`` after the LLM returns to close it.
    If *output* is provided here the span is closed immediately (fire-and-forget).
    """
    if trace is None:
        return None
    try:
        gen = trace.start_observation(
            as_type="generation",
            name=name,
            input=input,
            model=model,
            metadata=metadata or {},
        )
        if output is not None:
            try:
                if output is not None:
                    gen.update(output=output)
                gen.end()
            except Exception:  # pragma: no cover
                pass
            return None
        return gen  # type: ignore[return-value]
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] generation '{}' failed: {}", name, exc)
        return None


def flush() -> None:
    """Fire-and-forget flush of pending Langfuse events."""
    client = get_langfuse_client()
    if client is None:
        return
    try:
        client.flush()
    except Exception as exc:  # pragma: no cover
        logger.warning("[Langfuse] flush failed: {}", exc)
