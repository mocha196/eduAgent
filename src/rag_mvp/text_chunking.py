"""Token-aware text chunking shared by all vector indexing paths."""

from __future__ import annotations

import tiktoken

from .config import settings


def split_text(text: str) -> list[str]:
    clean = text.strip()
    if not clean:
        return []
    encoding = tiktoken.get_encoding("cl100k_base")
    tokens = encoding.encode(clean, disallowed_special=())
    size = max(1, int(settings.chunk_token_size))
    overlap = min(max(0, int(settings.chunk_overlap_token_size)), size - 1)
    step = size - overlap
    chunks: list[str] = []
    for start in range(0, len(tokens), step):
        piece = encoding.decode(tokens[start : start + size]).strip()
        if piece:
            chunks.append(piece)
        if start + size >= len(tokens):
            break
    return chunks
