from rag_mvp.engine import _rrf_merge
from rag_mvp.vector_store import _cjk_bigrams


def _hit(chunk_id: str, score: float) -> dict:
    return {"chunk_id": chunk_id, "text": chunk_id, "relevance_score": score}


def test_cjk_bigrams_are_stable_and_deduplicated() -> None:
    assert _cjk_bigrams("密钥轮换，密钥泄露") == ["密钥", "钥轮", "轮换", "钥泄", "泄露"]


def test_rrf_prioritizes_hits_returned_by_both_retrievers() -> None:
    merged = _rrf_merge(
        [_hit("dense-only", 0.9), _hit("both", 0.8)],
        [_hit("both", 0.7), _hit("lexical-only", 0.6)],
        top_k=3,
    )

    assert merged[0]["chunk_id"] == "both"
    assert merged[0]["retrieval_sources"] == ["vector", "lexical"]
    assert merged[0]["relevance_score"] == 1.0
