"""Evaluate answers against the GraphRAG-Bench benchmark.

Compares three retrieval strategies:
  - naive   : LightRAG naive mode (pure vector, COURSE_GRAPHRAG_NAIVE)
  - mix     : LightRAG mix mode  (vector + KG, COURSE_GRAPHRAG_FULL)
  - agentic : TS ReAct agent     (mix retrieval + query decomposition, COURSE_GRAPHRAG_FULL)

Metrics computed per strategy:
  - ROUGE-L, Token-F1, Exact-Match  (answer quality vs gold_answer)
  - context_recall   (heuristic: how much of the evidence is covered by retrieved contexts)
  - context_precision (LLM-as-judge when --llm-judge: are retrieved contexts relevant?)
  - avg_tool_calls, tool_success_rate, avg_latency_ms, avg_tokens

For a proper academic comparison, also runs the official GraphRAG-Benchmark
gen_eval script if the repo is available.

Usage:
  python -m tests.eval.eval_graphrag_bench \
    --questions tests/eval/data/graphrag_bench_questions.json \
    --naive     tests/eval/results/graphrag_bench_naive_answers.json \
    --mix       tests/eval/results/graphrag_bench_mix_answers.json \
    --agentic   tests/eval/results/graphrag_bench_agentic_answers.json

  # Collect answers first:
  # Naive  : python -m tests.eval.collect_answers_naive  --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_naive_answers.json   --course-id c0000001-0000-4000-8000-000000000000
  # Mix    : python -m tests.eval.collect_answers_mix    --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_mix_answers.json     --course-id c0000002-0000-4000-8000-000000000000
  # Agentic: python -m tests.eval.collect_answers_agentic --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_agentic_answers.json --course-id c0000002-0000-4000-8000-000000000000
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from tests.eval._common import RESULTS_DIR, load_json, save_json

# ---------------------------------------------------------------------------
# Text normalisation helpers (from SQuAD official script)
# ---------------------------------------------------------------------------


def _parse_evidence(evidence_str: str) -> list[str]:
    """Parse the evidence field which is stored as a Python-repr string of a list."""
    if not evidence_str or evidence_str.strip() in ("", "[]"):
        return []
    try:
        import ast
        val = ast.literal_eval(evidence_str)
        if isinstance(val, list):
            return [str(v).strip() for v in val if str(v).strip()]
    except Exception:
        pass
    # Fallback: treat as single statement
    return [evidence_str.strip()]


def _context_recall_heuristic(retrieved_contexts: list[str], evidence: list[str]) -> float:
    """Estimate context recall: fraction of evidence statements covered by retrieved contexts.

    A statement is considered 'covered' if its token-F1 against the best-matching
    retrieved context chunk exceeds a 0.3 threshold.
    """
    if not evidence:
        return 0.0
    if not retrieved_contexts:
        return 0.0
    covered = 0
    for stmt in evidence:
        best_f1 = max(
            _f1_token_overlap(ctx, stmt)
            for ctx in retrieved_contexts
        )
        if best_f1 >= 0.3:
            covered += 1
    return covered / len(evidence)


def _context_precision_heuristic(retrieved_contexts: list[str], gold_answer: str, evidence: list[str]) -> float:
    """Estimate context precision: fraction of retrieved chunks that are relevant.

    A chunk is considered relevant if it has token-F1 >= 0.2 with the gold answer
    or any evidence statement.
    """
    if not retrieved_contexts:
        return 0.0
    reference_texts = [gold_answer] + evidence
    relevant = 0
    for ctx in retrieved_contexts:
        best = max(_f1_token_overlap(ctx, ref) for ref in reference_texts)
        if best >= 0.2:
            relevant += 1
    return relevant / len(retrieved_contexts)


def _normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _rouge_l(pred: str, ref: str) -> float:
    """Compute sentence-level ROUGE-L F1."""
    pred_tokens = _normalize(pred).split()
    ref_tokens = _normalize(ref).split()
    if not pred_tokens or not ref_tokens:
        return 0.0

    # LCS
    m, n = len(ref_tokens), len(pred_tokens)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if ref_tokens[i - 1] == pred_tokens[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    lcs = dp[m][n]
    prec = lcs / n if n else 0
    rec = lcs / m if m else 0
    if prec + rec == 0:
        return 0.0
    return 2 * prec * rec / (prec + rec)


def _f1_token_overlap(pred: str, ref: str) -> float:
    """Token-level F1 (multi-set overlap)."""
    p = _normalize(pred).split()
    r = _normalize(ref).split()
    if not p or not r:
        return 0.0
    common = sum(min(p.count(t), r.count(t)) for t in set(p) & set(r))
    prec = common / len(p)
    rec = common / len(r)
    if prec + rec == 0:
        return 0.0
    return 2 * prec * rec / (prec + rec)


def _exact_match(pred: str, ref: str) -> bool:
    return _normalize(pred) == _normalize(ref)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate_answers(questions: list[dict], answers: list[dict]) -> dict:
    """Compute aggregate + per-question_type metrics for a single answers file."""
    ans_map = {str(a.get("id", "")): a for a in answers}

    rouge_scores: list[float] = []
    f1_scores: list[float] = []
    em_scores: list[float] = []
    recall_scores: list[float] = []
    precision_scores: list[float] = []
    tool_call_counts: list[int] = []
    tool_success_rates: list[float] = []
    latencies: list[float] = []
    token_counts: list[int] = []
    answered_count = 0
    empty_count = 0

    # per question_type accumulators
    by_type: dict[str, dict] = {}

    for q in questions:
        qid = str(q.get("id", ""))
        gold = str(q.get("gold_answer", ""))
        qtype = str(q.get("question_type", "unknown"))
        a = ans_map.get(qid)

        if qtype not in by_type:
            by_type[qtype] = {"rouge": [], "f1": [], "em": [], "recall": [], "precision": [], "n": 0, "answered": 0}
        by_type[qtype]["n"] += 1

        if a is None:
            rouge_scores.append(0.0)
            f1_scores.append(0.0)
            em_scores.append(0.0)
            recall_scores.append(0.0)
            precision_scores.append(0.0)
            by_type[qtype]["rouge"].append(0.0)
            by_type[qtype]["f1"].append(0.0)
            by_type[qtype]["em"].append(0.0)
            by_type[qtype]["recall"].append(0.0)
            by_type[qtype]["precision"].append(0.0)
            continue

        answered_count += 1
        by_type[qtype]["answered"] += 1
        pred = str(a.get("generated_answer", ""))
        if not pred.strip():
            empty_count += 1

        rouge = _rouge_l(pred, gold)
        f1 = _f1_token_overlap(pred, gold)
        em = 1.0 if _exact_match(pred, gold) else 0.0
        rouge_scores.append(rouge)
        f1_scores.append(f1)
        em_scores.append(em)
        by_type[qtype]["rouge"].append(rouge)
        by_type[qtype]["f1"].append(f1)
        by_type[qtype]["em"].append(em)

        # Context recall / precision (heuristic, requires evidence field + retrieved_contexts)
        evidence = _parse_evidence(str(q.get("evidence", "")))
        retrieved = a.get("retrieved_contexts", [])
        if not retrieved:  # agentic stores contexts in tool_calls outputs too
            retrieved = [str(tc.get("output", "")) for tc in a.get("tool_calls", []) if tc.get("output")]
        recall = _context_recall_heuristic(retrieved, evidence)
        precision = _context_precision_heuristic(retrieved, gold, evidence)
        recall_scores.append(recall)
        precision_scores.append(precision)
        by_type[qtype]["recall"].append(recall)
        by_type[qtype]["precision"].append(precision)

        tcs = a.get("tool_calls", [])
        tool_call_counts.append(len(tcs))
        if tcs:
            tool_success_rates.append(sum(1 for tc in tcs if tc.get("success")) / len(tcs))
        if "exec_time_ms" in a:
            latencies.append(a["exec_time_ms"])
        if "tokens" in a:
            token_counts.append(a["tokens"])

    def avg(lst): return round(sum(lst) / len(lst), 4) if lst else 0.0

    return {
        "n": len(questions),
        "answered": answered_count,
        "empty_answer_rate": round(empty_count / answered_count, 4) if answered_count else 0.0,
        "rouge_l": avg(rouge_scores),
        "f1_token": avg(f1_scores),
        "exact_match": avg(em_scores),
        "context_recall": avg(recall_scores),
        "context_precision": avg(precision_scores),
        "avg_tool_calls": avg(tool_call_counts),
        "tool_success_rate": avg(tool_success_rates),
        "avg_latency_ms": round(sum(latencies) / len(latencies)) if latencies else 0,
        "avg_tokens": round(sum(token_counts) / len(token_counts)) if token_counts else 0,
        "by_type": {
            t: {
                "n": v["n"],
                "answered": v["answered"],
                "rouge_l": avg(v["rouge"]),
                "f1_token": avg(v["f1"]),
                "exact_match": avg(v["em"]),
                "context_recall": avg(v["recall"]),
                "context_precision": avg(v["precision"]),
            }
            for t, v in by_type.items()
        },
    }


def intersect_questions(
    questions: list[dict],
    *answer_lists: list[dict],
) -> list[dict]:
    """Return only questions answered in ALL provided answer files."""
    if not answer_lists:
        return questions
    common = None
    for ans_list in answer_lists:
        ids = {str(a.get("id", "")) for a in ans_list}
        common = ids if common is None else common & ids
    return [q for q in questions if str(q.get("id", "")) in (common or set())]


# ---------------------------------------------------------------------------
# LLM-as-Judge
# ---------------------------------------------------------------------------

_CONTEXT_PRECISION_PROMPT = """\
You are an evaluator for a RAG retrieval benchmark.

## Question
{question}

## Retrieved Context Chunk
{chunk}

---
Is this retrieved context chunk RELEVANT to answering the question? (i.e., does it contain information useful for answering it?)

Respond with ONLY valid JSON:
{{"relevant": true/false, "reason": "<one short sentence>"}}"""


_JUDGE_PROMPT = """\
You are an expert evaluator for a reading-comprehension RAG benchmark.

## Question
{question}

## Gold Answer (reference)
{gold_answer}

## Retrieved Context (from RAG tool calls)
{context}

## Predicted Answer
{predicted_answer}

---
Rate the predicted answer on TWO dimensions (integer 1-5 each):

**Correctness** — How well does it match the gold answer?
  5=Fully correct  4=Mostly correct, minor omission  3=Partially correct
  2=Contains some relevant info but largely wrong  1=Wrong or irrelevant

**Faithfulness** — Are all claims grounded in the retrieved context?
  5=Every claim directly supported  4=Nearly all supported, minor inference
  3=Some claims extrapolated  2=Many claims not in context  1=Heavily hallucinated
  Special: if no context was retrieved and the answer abstains → faithfulness=5;
           if no context but answer invents details → faithfulness=1.

Respond with ONLY valid JSON, nothing else:
{{"correctness": <int 1-5>, "faithfulness": <int 1-5>, "reason": "<one sentence>"}}"""


def _build_judge_context(answer: dict, max_chars: int = 2000) -> str:
    """Build context string from either retrieved_contexts or tool_call outputs."""
    parts: list[str] = []
    # Prefer explicit retrieved_contexts list (naive/mix/agentic citation events)
    retrieved = answer.get("retrieved_contexts", [])
    if retrieved:
        for i, chunk in enumerate(retrieved[:8], 1):
            parts.append(f"[Chunk {i}] {str(chunk)[:500]}")
    else:
        # Fallback: tool_call output fields (legacy format)
        for i, tc in enumerate(answer.get("tool_calls", [])[:6], 1):
            out = str(tc.get("output", ""))[:500]
            if out:
                parts.append(f"[Tool {i}] {out}")
    if not parts:
        return "(No context retrieved)"
    return "\n\n".join(parts)[:max_chars]


def _judge_one(
    client,  # openai.OpenAI
    model: str,
    question: str,
    gold_answer: str,
    predicted_answer: str,
    context: str,
    retries: int = 2,
) -> dict | None:
    """Ask the LLM to score one answer. Returns {correctness, faithfulness, reason} or None."""
    prompt = _JUDGE_PROMPT.format(
        question=question,
        gold_answer=gold_answer,
        context=context,
        predicted_answer=predicted_answer[:3000],
    )
    for attempt in range(retries):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=400,
                extra_body={"enable_thinking": False},
            )
            msg = resp.choices[0].message
            raw = (msg.content or "").strip()
            # Some reasoning models return empty content with reasoning_content only
            if not raw:
                raw = (getattr(msg, "reasoning_content", None) or "").strip()
            if not raw:
                print(f" [judge-empty finish_reason={resp.choices[0].finish_reason} attempt={attempt+1}]", end="")
                if attempt < retries - 1:
                    time.sleep(1.0)
                    continue
                return None
            # Strip markdown code fences if present
            if "```" in raw:
                raw = re.sub(r"```[a-z]*\n?", "", raw).strip()
            # Extract first JSON object anywhere in the response
            m = re.search(r'\{[^{}]*"correctness"[^{}]*\}', raw, re.DOTALL)
            if m:
                raw = m.group(0)
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f" [judge-json-err attempt={attempt+1}: {exc}; raw={raw!r:.80}]", end="")
            if attempt < retries - 1:
                time.sleep(1.0)
                continue
            return None
        except Exception as exc:
            print(f" [judge-err: {exc}]")
            return None
    return None


def run_llm_judge(
    answers: list[dict],
    questions: list[dict],
    label: str,
    model: str,
    delay_s: float = 0.3,
) -> dict:
    """Run LLM-as-judge on all answers with incremental caching.

    Cache stored at: tests/eval/results/graphrag_bench_{label}_judge.json
    Skips already-judged IDs on re-run.
    """
    try:
        from openai import OpenAI
    except ImportError:
        print("  [judge] openai package not installed — skipping")
        return {}

    client = OpenAI(
        api_key=os.getenv("LLM_JUDGE_API_KEY") or os.getenv("LLM_API_KEY", ""),
        base_url=os.getenv("LLM_JUDGE_BASE_URL") or os.getenv("LLM_BASE_URL", "https://api.openai.com/v1"),
    )

    cache_path = RESULTS_DIR / f"graphrag_bench_{label}_judge.json"
    cache: dict[str, dict] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    q_map = {str(q.get("id", "")): q for q in questions}
    correctness_scores: list[float] = []
    faithfulness_scores: list[float] = []
    judged = 0
    skipped = 0

    for a in answers:
        aid = str(a.get("id", ""))
        q = q_map.get(aid)
        if q is None:
            continue

        pred = str(a.get("generated_answer", ""))
        gold = str(q.get("gold_answer", ""))
        question_text = str(q.get("question", ""))
        context = _build_judge_context(a)

        if aid in cache:
            result = cache[aid]
        else:
            print(f"  [judge] scoring {aid} ...", end="", flush=True)
            result = _judge_one(client, model, question_text, gold, pred, context)
            if result:
                cache[aid] = result
                cache_path.write_text(
                    json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                print(
                    f" correctness={result.get('correctness')}"
                    f" faithfulness={result.get('faithfulness')}"
                    f" | {result.get('reason', '')[:60]}"
                )
            else:
                skipped += 1
                continue
            time.sleep(delay_s)

        c = result.get("correctness")
        f = result.get("faithfulness")
        if isinstance(c, (int, float)):
            correctness_scores.append(float(c))
        if isinstance(f, (int, float)):
            faithfulness_scores.append(float(f))
        judged += 1

    def avg(lst: list[float]) -> float:
        return round(sum(lst) / len(lst), 3) if lst else 0.0

    return {
        "judged": judged,
        "skipped": skipped,
        "avg_correctness_1_5": avg(correctness_scores),
        "avg_faithfulness_1_5": avg(faithfulness_scores),
        "cache": str(cache_path),
    }


def _run_official_eval(
    official_dir: Path,
    answers_file: Path,
    questions_file: Path,
    label: str,
) -> dict | None:
    """Run the official GraphRAG-Benchmark generation_eval.py if available."""
    eval_script = official_dir / "Evaluation" / "generation_eval.py"
    if not eval_script.exists():
        print(f"  [skip] Official eval script not found: {eval_script}")
        return None

    out_file = RESULTS_DIR / f"official_{label}.json"
    cmd = [
        sys.executable, str(eval_script),
        "--answers", str(answers_file),
        "--questions", str(questions_file),
        "--output", str(out_file),
    ]
    print(f"  [official] {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            print(f"  [official] stderr: {result.stderr[:500]}")
            return None
        if out_file.exists():
            return json.loads(out_file.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [official] Error: {e}")
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(
    questions_path: str,
    naive_path: str,
    mix_path: str,
    agentic_path: str,
    official_eval_dir: str | None = None,
    intersection: bool = False,
    llm_judge: bool = False,
    judge_model: str | None = None,
    limit: int | None = None,
) -> None:
    print("\n=== GraphRAG-Bench Evaluation (naive vs mix vs agentic) ===\n")

    questions = load_json(questions_path)
    if limit:
        questions = questions[:limit]
        print(f"[--limit] Evaluating first {limit} questions only.")
    naive_answers   = load_json(naive_path)   if Path(naive_path).exists()   else []
    mix_answers     = load_json(mix_path)     if Path(mix_path).exists()     else []
    agentic_answers = load_json(agentic_path) if Path(agentic_path).exists() else []

    print(f"Questions       : {len(questions)}")
    print(f"Naive answers   : {len(naive_answers)}")
    print(f"Mix answers     : {len(mix_answers)}")
    print(f"Agentic answers : {len(agentic_answers)}")

    if intersection:
        active = [a for a in [naive_answers, mix_answers, agentic_answers] if a]
        if len(active) > 1:
            questions = intersect_questions(questions, *active)
            print(f"Intersection    : {len(questions)} (questions answered in ALL provided sets)")

    results: dict = {}

    SCALAR_METRICS = [
        "rouge_l", "f1_token", "exact_match",
        "context_recall", "context_precision",
        "avg_tool_calls", "tool_success_rate",
        "avg_latency_ms", "avg_tokens", "empty_answer_rate",
    ]

    def _print_metrics(label: str, metrics: dict) -> None:
        print(f"\n--- {label} ---")
        for k in ["n", "answered"] + SCALAR_METRICS:
            if k in metrics:
                print(f"  {k}: {metrics[k]}")
        by_type = metrics.get("by_type", {})
        if by_type:
            print("  by_type:")
            for t, tv in by_type.items():
                print(f"    [{t}] n={tv['n']} ans={tv['answered']}"
                      f"  rouge={tv['rouge_l']}  f1={tv['f1_token']}  em={tv['exact_match']}"
                      f"  recall={tv['context_recall']}  prec={tv['context_precision']}")

    strategies = [
        ("naive",   naive_answers,   "Naive RAG (vector-only, COURSE_GRAPHRAG_NAIVE)"),
        ("mix",     mix_answers,     "Mix RAG (vector+KG, COURSE_GRAPHRAG_FULL)"),
        ("agentic", agentic_answers, "Agentic ReAct (mix+decompose, COURSE_GRAPHRAG_FULL)"),
    ]

    for label, ans_list, title in strategies:
        if not ans_list:
            continue
        metrics = evaluate_answers(questions, ans_list)
        results[label] = metrics
        _print_metrics(title, metrics)

    # Delta comparison table: mix-naive, agentic-naive
    if results:
        baselines = list(results.keys())
        if len(baselines) >= 2:
            print("\n--- Delta vs Naive ---")
            base = results.get("naive", {})
            for label in ["mix", "agentic"]:
                if label not in results:
                    continue
                comp = results[label]
                print(f"  [{label} - naive]")
                for metric in SCALAR_METRICS:
                    bv = base.get(metric, 0)
                    cv = comp.get(metric, 0)
                    if isinstance(bv, (int, float)) and isinstance(cv, (int, float)):
                        d = cv - bv
                        print(f"    {metric}: {'+' if d >= 0 else ''}{d:.4f}")

    # LLM-as-judge (correctness + faithfulness + context_precision)
    if llm_judge:
        _judge_model = judge_model or os.getenv("LLM_JUDGE_MODEL") or os.getenv("LLM_MODEL", "gpt-4o-mini")
        print(f"\n--- LLM-as-Judge (model: {_judge_model}) ---")
        for label, ans_list, _ in strategies:
            if not ans_list:
                continue
            print(f"  [{label}]")
            judge_metrics = run_llm_judge(ans_list, questions, label, _judge_model)
            results.setdefault(label, {})["llm_judge"] = judge_metrics
            for k, v in judge_metrics.items():
                if k != "cache":
                    print(f"    {k}: {v}")
        # Delta for judge metrics
        if "naive" in results and "llm_judge" in results["naive"]:
            nj = results["naive"]["llm_judge"]
            print("  [judge delta vs naive]")
            for label in ["mix", "agentic"]:
                if label not in results or "llm_judge" not in results[label]:
                    continue
                lj = results[label]["llm_judge"]
                print(f"    [{label}]")
                for m in ["avg_correctness_1_5", "avg_faithfulness_1_5"]:
                    nv, lv = nj.get(m, 0), lj.get(m, 0)
                    if isinstance(nv, (int, float)) and isinstance(lv, (int, float)):
                        d = lv - nv
                        print(f"      {m}: {'+' if d >= 0 else ''}{d:.3f}")

    # Official eval
    if official_eval_dir:
        print("\n--- Official GraphRAG-Benchmark Eval ---")
        path_map = {"naive": naive_path, "mix": mix_path, "agentic": agentic_path}
        for label, ans_path in path_map.items():
            if not Path(ans_path).exists():
                continue
            official = _run_official_eval(
                Path(official_eval_dir),
                Path(ans_path),
                Path(questions_path),
                label,
            )
            if official:
                results[f"official_{label}"] = official
                print(f"  [{label}] {official}")

    # Save summary
    out = RESULTS_DIR / "graphrag_bench_summary.json"
    save_json(out, results)
    print(f"\n✓ Summary saved: {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Evaluate GraphRAG-Bench: naive vs mix vs agentic",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Collect answers first:
  Naive  : python -m tests.eval.collect_answers_naive   --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_naive_answers.json   --course-id c0000001-0000-4000-8000-000000000000
  Mix    : python -m tests.eval.collect_answers_mix     --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_mix_answers.json     --course-id c0000002-0000-4000-8000-000000000000
  Agentic: python -m tests.eval.collect_answers_agentic --questions tests/eval/data/graphrag_bench_questions.json --output tests/eval/results/graphrag_bench_agentic_answers.json --course-id c0000002-0000-4000-8000-000000000000
""",
    )
    parser.add_argument("--questions", default="tests/eval/data/graphrag_bench_questions.json")
    parser.add_argument("--naive",    default="tests/eval/results/graphrag_bench_naive_answers.json")
    parser.add_argument("--mix",      default="tests/eval/results/graphrag_bench_mix_answers.json")
    parser.add_argument("--agentic",  default="tests/eval/results/graphrag_bench_agentic_answers.json")
    parser.add_argument("--official-eval-dir", default=None, help="Path to GraphRAG-Benchmark repo")
    parser.add_argument("--intersection", action="store_true",
                        help="Only evaluate questions answered in ALL provided files")
    parser.add_argument("--llm-judge", action="store_true",
                        help="Run LLM-as-judge scoring (correctness + faithfulness 1-5)")
    parser.add_argument("--judge-model", default=None,
                        help="Model for LLM judge (default: $LLM_JUDGE_MODEL env var)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Only evaluate the first N questions (for quick sanity checks)")
    args = parser.parse_args()
    main(
        args.questions, args.naive, args.mix, args.agentic,
        args.official_eval_dir, args.intersection,
        args.llm_judge, args.judge_model, args.limit,
    )
