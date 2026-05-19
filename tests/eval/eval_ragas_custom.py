"""Evaluate Ragas-custom (Chinese course material) answers with Ragas metrics.

Loads the synthetic QA pairs + TS agent answers, computes:
  answer_relevancy, faithfulness, context_precision, context_recall.

The context for each question is taken from the ``context`` field generated
by the Ragas TestsetGenerator during prepare_ragas_custom.py.

Usage:
  python -m tests.eval.eval_ragas_custom \
    --questions tests/eval/data/ragas_custom_questions.json \
    --answers   tests/eval/results/ragas_custom_answers.json
"""
from __future__ import annotations

import argparse
from pathlib import Path

from tests.eval._common import RESULTS_DIR, _bootstrap, load_json, save_json

_bootstrap()


def _build_ragas_llm():
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from langchain_openai import ChatOpenAI  # type: ignore[import-untyped]
    from ragas.llms import LangchainLLMWrapper  # type: ignore[import-untyped]

    llm = ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key or "placeholder",
        base_url=settings.llm_base_url,
        temperature=0.0,
    )
    return LangchainLLMWrapper(llm)


def _build_ragas_embeddings():
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from langchain_openai import OpenAIEmbeddings  # type: ignore[import-untyped]
    from ragas.embeddings import LangchainEmbeddingsWrapper  # type: ignore[import-untyped]

    emb = OpenAIEmbeddings(
        model=settings.embedding_model,
        api_key=settings.llm_api_key or "placeholder",
        base_url=settings.llm_base_url,
    )
    return LangchainEmbeddingsWrapper(emb)


def _parse_context_field(raw) -> list[str]:
    """The context field from Ragas generator can be a string, list, or JSON."""
    import json as _json
    if isinstance(raw, list):
        return [str(c) for c in raw if str(c).strip()]
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("["):
            try:
                parsed = _json.loads(stripped)
                if isinstance(parsed, list):
                    return [str(c) for c in parsed if str(c).strip()]
            except Exception:
                pass
        if stripped:
            return [stripped]
    return []


def _build_ragas_dataset(questions: list[dict], answers: list[dict]):
    from ragas import EvaluationDataset  # type: ignore[import-untyped]
    from ragas.dataset_schema import SingleTurnSample  # type: ignore[import-untyped]

    ans_map = {str(a.get("id", "")): a for a in answers}

    samples = []
    for q in questions:
        qid = str(q.get("id", ""))
        question_text = str(q.get("question", ""))
        gold_answer = str(q.get("gold_answer", ""))
        contexts = _parse_context_field(q.get("context", []))

        a = ans_map.get(qid, {})
        generated_answer = str(a.get("generated_answer", ""))

        if not contexts:
            contexts = [gold_answer] if gold_answer else ["(no context)"]

        samples.append(
            SingleTurnSample(
                user_input=question_text,
                response=generated_answer,
                retrieved_contexts=contexts,
                reference=gold_answer,
            )
        )

    return EvaluationDataset(samples=samples)


def main(questions_path: str, answers_path: str) -> None:
    print("\n=== Ragas Custom (Chinese Course) Evaluation ===\n")

    questions = load_json(questions_path)
    if not Path(answers_path).exists():
        print(f"[error] Answers file not found: {answers_path}")
        return
    answers = load_json(answers_path)

    print(f"Questions: {len(questions)}")
    print(f"Answers:   {len(answers)}")

    dataset = _build_ragas_dataset(questions, answers)

    from ragas import evaluate  # type: ignore[import-untyped]
    from ragas.metrics import (  # type: ignore[import-untyped]
        AnswerRelevancy,
        Faithfulness,
        LLMContextPrecisionWithReference,
        LLMContextRecall,
    )

    llm = _build_ragas_llm()
    emb = _build_ragas_embeddings()

    metrics = [
        AnswerRelevancy(llm=llm, embeddings=emb),
        Faithfulness(llm=llm),
        LLMContextPrecisionWithReference(llm=llm),
        LLMContextRecall(llm=llm),
    ]

    print("\n[ragas] Running evaluation...")
    result = evaluate(dataset=dataset, metrics=metrics)

    df = result.to_pandas()
    out_csv = RESULTS_DIR / "ragas_custom_scores.csv"
    df.to_csv(out_csv, index=False)
    print(f"\n[ragas] Per-question scores saved: {out_csv}")

    summary = {k: round(float(v), 4) for k, v in result.items() if isinstance(v, (int, float))}
    print("\n--- Summary ---")
    for k, v in summary.items():
        print(f"  {k}: {v}")

    save_json(RESULTS_DIR / "ragas_custom_summary.json", summary)
    print(f"\n✓ Summary saved: {RESULTS_DIR / 'ragas_custom_summary.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate Ragas-custom answers")
    parser.add_argument("--questions", default="tests/eval/data/ragas_custom_questions.json")
    parser.add_argument("--answers", default="tests/eval/results/ragas_custom_answers.json")
    args = parser.parse_args()
    main(args.questions, args.answers)
