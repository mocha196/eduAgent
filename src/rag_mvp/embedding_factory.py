"""Embedding client abstraction for the vector RAG store."""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

from .config import settings
from .http_env import ensure_loopback_bypass_http_proxy

ensure_loopback_bypass_http_proxy()

_MAX_ATTEMPTS = 3
_RETRY_BASE_SECONDS = 2


def _base_url() -> str:
    return (settings.embedding_base_url or settings.llm_base_url or "").strip().rstrip("/")


def _api_key() -> str:
    return (settings.embedding_api_key or settings.llm_api_key or "").strip()


def _retryable(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(word in text for word in ("connection", "timeout", "network", "reset by peer", "eof"))


async def _openai_embeddings(texts: list[str]) -> list[list[float]]:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=_api_key() or "not-set", base_url=_base_url() or None)
    request: dict[str, Any] = {"model": settings.embedding_model, "input": texts}
    # `dimensions` is an OpenAI text-embedding-3 feature. Most compatible
    # providers (including BGE-M3 endpoints) reject the parameter outright.
    if settings.embedding_model.lower().startswith("text-embedding-3"):
        request["dimensions"] = settings.embedding_dim
    response = await client.embeddings.create(**request)
    ordered = sorted(response.data, key=lambda item: item.index)
    return [list(item.embedding) for item in ordered]


async def _ollama_embeddings(texts: list[str]) -> list[list[float]]:
    from ollama import AsyncClient

    kwargs: dict[str, Any] = {"host": settings.ollama_base_url.rstrip("/")}
    if settings.ollama_api_key.strip():
        kwargs["headers"] = {"Authorization": f"Bearer {settings.ollama_api_key.strip()}"}
    response = await AsyncClient(**kwargs).embed(model=settings.embedding_model, input=texts)
    embeddings = response.get("embeddings") if isinstance(response, dict) else response.embeddings
    return [list(vector) for vector in embeddings]


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a non-empty list of strings with retry and dimension validation."""
    if not texts:
        return []
    call = _openai_embeddings if settings.embedding_mode == "openai_compatible" else _ollama_embeddings
    last_error: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            vectors = await call(texts)
            for vector in vectors:
                if len(vector) != settings.embedding_dim:
                    raise RuntimeError(
                        f"Embedding dimension mismatch: expected {settings.embedding_dim}, got {len(vector)}"
                    )
            return vectors
        except Exception as exc:
            last_error = exc
            if not _retryable(exc) or attempt == _MAX_ATTEMPTS - 1:
                raise
            delay = _RETRY_BASE_SECONDS * (2**attempt)
            logger.warning(
                "Embedding request failed (attempt {}/{}); retrying in {}s: {}",
                attempt + 1,
                _MAX_ATTEMPTS,
                delay,
                exc,
            )
            await asyncio.sleep(delay)
    raise last_error or RuntimeError("Embedding request failed")
