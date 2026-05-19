"""Evaluate answers against the GraphRAG-Bench benchmark.

Merges questions + naive answers + full answers, computes:
  - ROUGE-L  (approximate answer quality)
  - EM / F1 token overlap (proxy for correctness)
  - Tool-call stats (how many knowledge-graph lookups the agent made)

For a proper academic comparison, also runs the official GraphRAG-Benchmark
gen_eval script if the repo is available.

Usage:
  python -m tests.eval.eval_graphrag_bench \
    --questions   tests/eval/data/graphrag_bench_questions.json \
    --naive       tests/eval/results/graphrag_bench_naive_answers.json \
    --full        tests/eval/results/graphrag_bench_full_answers.json \
    [--official-eval-dir <path/to/GraphRAG-Benchmark>]
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
            by_type[qtype] = {"rouge": [], "f1": [], "em": [], "n": 0, "answered": 0}
        by_type[qtype]["n"] += 1

        if a is None:
            rouge_scores.append(0.0)
            f1_scores.append(0.0)
            em_scores.append(0.0)
            by_type[qtype]["rouge"].append(0.0)
            by_type[qtype]["f1"].append(0.0)
            by_type[qtype]["em"].append(0.0)
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
            }
            for t, v in by_type.items()
        },
    }


def intersect_questions(
    questions: list[dict],
    naive_answers: list[dict],
    full_answers: list[dict],
) -> list[dict]:
    """Return only questions answered in BOTH naive and full answer files."""
    naive_ids = {str(a.get("id", "")) for a in naive_answers}
    full_ids = {str(a.get("id", "")) for a in full_answers}
    common = naive_ids & full_ids
    return [q for q in questions if str(q.get("id", "")) in common]


# ---------------------------------------------------------------------------
# LLM-as-Judge
# ---------------------------------------------------------------------------

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


def _build_judge_context(tool_calls: list[dict], max_chars: int = 2000) -> str:
    """Concatenate and truncate retrieved context from tool call outputs."""
    if not tool_calls:
        return "(No context retrieved)"
    parts = []
    for i, tc in enumerate(tool_calls, 1):
        out = str(tc.get("output", ""))[:600]
        if out:
            parts.append(f"[Tool {i}] {out}")
    combined = "\n\n".join(parts)
    return combined[:max_chars]


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
        context = _build_judge_context(a.get("tool_calls", []))

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
    full_path: str,
    official_eval_dir: str | None = None,
    intersection: bool = False,
    llm_judge: bool = False,
    judge_model: str | None = None,
) -> None:
    print("\n=== GraphRAG-Bench Evaluation ===\n")

    questions = load_json(questions_path)
    naive_answers = load_json(naive_path) if Path(naive_path).exists() else []
    full_answers = load_json(full_path) if Path(full_path).exists() else []

    print(f"Questions:     {len(questions)}")
    print(f"Naive answers: {len(naive_answers)}")
    print(f"Full answers:  {len(full_answers)}")

    if intersection and naive_answers and full_answers:
        questions = intersect_questions(questions, naive_answers, full_answers)
        print(f"Intersection:  {len(questions)} (questions answered in both)")

    results: dict = {}

    SCALAR_METRICS = ["rouge_l", "f1_token", "exact_match",
                      "avg_tool_calls", "tool_success_rate",
                      "avg_latency_ms", "avg_tokens", "empty_answer_rate"]

    def _print_metrics(metrics: dict) -> None:
        for k in ["n", "answered"] + SCALAR_METRICS:
            if k in metrics:
                print(f"  {k}: {metrics[k]}")
        by_type = metrics.get("by_type", {})
        if by_type:
            print("  by_type:")
            for t, tv in by_type.items():
                print(f"    [{t}] n={tv['n']} answered={tv['answered']}"
                      f"  rouge_l={tv['rouge_l']}  f1={tv['f1_token']}  em={tv['exact_match']}")

    if naive_answers:
        print("\n--- Naive RAG (vector-only) ---")
        naive_metrics = evaluate_answers(questions, naive_answers)
        results["naive"] = naive_metrics
        _print_metrics(naive_metrics)

    if full_answers:
        print("\n--- Full LightRAG (KG+vector) ---")
        full_metrics = evaluate_answers(questions, full_answers)
        results["full"] = full_metrics
        _print_metrics(full_metrics)

    # Delta comparison (scalar metrics only)
    if naive_answers and full_answers:
        print("\n--- Delta (Full - Naive) ---")
        for metric in SCALAR_METRICS:
            n = results["full"].get(metric, 0)
            v = results["naive"].get(metric, 0)
            if isinstance(n, (int, float)) and isinstance(v, (int, float)):
                delta = n - v
                sign = "+" if delta >= 0 else ""
                print(f"  {metric}: {sign}{delta:.4f}")
        # per-type delta
        naive_by = results["naive"].get("by_type", {})
        full_by = results["full"].get("by_type", {})
        if naive_by and full_by:
            print("  by_type rouge_l delta:")
            for t in naive_by:
                if t in full_by:
                    d = full_by[t]["rouge_l"] - naive_by[t]["rouge_l"]
                    sign = "+" if d >= 0 else ""
                    print(f"    [{t}]: {sign}{d:.4f}")

    # LLM-as-judge
    if llm_judge:
        _judge_model = judge_model or os.getenv("LLM_JUDGE_MODEL") or os.getenv("LLM_MODEL", "gpt-4o-mini")
        print(f"\n--- LLM-as-Judge (model: {_judge_model}) ---")
        for label, ans_list in [("naive", naive_answers), ("full", full_answers)]:
            if not ans_list:
                continue
            print(f"  [{label}]")
            judge_metrics = run_llm_judge(
                ans_list, questions, label, _judge_model
            )
            results.setdefault(label, {})["llm_judge"] = judge_metrics
            for k, v in judge_metrics.items():
                if k != "cache":
                    print(f"    {k}: {v}")
        # Delta for judge metrics
        if naive_answers and full_answers:
            nj = results.get("naive", {}).get("llm_judge", {})
            fj = results.get("full", {}).get("llm_judge", {})
            print("  [judge delta (Full - Naive)]")
            for m in ["avg_correctness_1_5", "avg_faithfulness_1_5"]:
                nv, fv = nj.get(m, 0), fj.get(m, 0)
                if isinstance(nv, (int, float)) and isinstance(fv, (int, float)):
                    d = fv - nv
                    print(f"    {m}: {'+' if d >= 0 else ''}{d:.3f}")

    # Official eval
    if official_eval_dir:
        print("\n--- Official GraphRAG-Benchmark Eval ---")
        for label, answers_path in [("naive", naive_path), ("full", full_path)]:
            official = _run_official_eval(
                Path(official_eval_dir),
                Path(answers_path),
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
    parser = argparse.ArgumentParser(description="Evaluate GraphRAG-Bench answers")
    parser.add_argument("--questions", default="tests/eval/data/graphrag_bench_questions.json")
    parser.add_argument("--naive", default="tests/eval/results/graphrag_bench_naive_answers.json")
    parser.add_argument("--full", default="tests/eval/results/graphrag_bench_full_answers.json")
    parser.add_argument("--official-eval-dir", default=None, help="Path to GraphRAG-Benchmark repo")
    parser.add_argument("--intersection", action="store_true",
                        help="Only evaluate questions answered in BOTH naive and full files")
    parser.add_argument("--llm-judge", action="store_true",
                        help="Run LLM-as-judge scoring (correctness + faithfulness 1-5)")
    parser.add_argument("--judge-model", default=None,
                        help="Model for LLM judge (default: $LLM_JUDGE_MODEL env var)")
    args = parser.parse_args()
    main(
        args.questions, args.naive, args.full,
        args.official_eval_dir, args.intersection,
        args.llm_judge, args.judge_model,
    )
