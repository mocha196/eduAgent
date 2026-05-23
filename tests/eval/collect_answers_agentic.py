"""Collect answers for Ragas-custom questions via the TS agentic ReAct loop.

Calls the Next.js chat endpoint (POST /api/v1/courses/{courseId}/chat) which runs
the full agentic pipeline:
  ReAct LLM → knowledge_query tool (with _decomposeQuery + _rewriteQuery)
             → LightRAG mix retrieval → answer synthesis

The eval student is enrolled in the target course automatically.
A fresh session_id UUID is used per question to avoid history contamination.

Usage:
  python -m tests.eval.collect_answers_agentic
  python -m tests.eval.collect_answers_agentic --limit 5
  python -m tests.eval.collect_answers_agentic \\
      --base-url  http://localhost:3000 \\
      --questions tests/eval/data/ragas_custom_questions.json \\
      --output    tests/eval/results/answers_agentic.json \\
      --delay     1.0
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import httpx

from tests.eval._common import (
    RESULTS_DIR,
    COURSE_RAGAS_CUSTOM,
    EVAL_STUDENT_ID,
    _bootstrap,
    load_json,
    make_eval_jwt,
    ensure_course_enrollment,
    setup_eval_db,
)

_bootstrap()

_DEFAULT_QUESTIONS = str(Path(__file__).parent / "data" / "ragas_custom_questions.json")
_DEFAULT_OUTPUT = str(RESULTS_DIR / "answers_agentic.json")

# SSE keeps the connection open for potentially long agent runs
_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)


def _get_agentic_models() -> dict[str, str]:
    """Resolve LLM model names using the same env-var fallback chain as TS llm-registry.ts."""
    default = os.environ.get("LLM_MODEL", "unknown")
    return {
        "chat":  os.environ.get("LLM_CHAT_MODEL")  or default,
        "title": (
            os.environ.get("LLM_TITLE_MODEL")
            or os.environ.get("LLM_AUXILIARY_MODEL")
            or default
        ),
    }


def _parse_sse_stream(response: httpx.Response) -> tuple[str, list[str], list[dict]]:
    """Parse a streaming SSE response into (answer_text, retrieved_contexts, tool_calls).

    tool_calls is a list of {name, input} dicts — one entry per tool_call event.
    Collects:
    - type="text"      → concatenate content into the final answer
    - type="citation"  → collect chunk_text as retrieved context snippets
    - type="tool_call" → record {name, input} (input = parsed LLM args)
    - type="done"      → stop (also stops on [DONE] sentinel)
    """
    answer_parts: list[str] = []
    contexts: list[str] = []
    tool_calls: list[dict] = []

    for raw_line in response.iter_lines():
        line = raw_line.strip()
        if not line:
            continue
        if line == "data: [DONE]":
            break
        if not line.startswith("data: "):
            continue
        payload_str = line[len("data: "):]
        try:
            event = json.loads(payload_str)
        except json.JSONDecodeError:
            continue

        etype = event.get("type")
        if etype == "text":
            content = event.get("content", "")
            if content:
                answer_parts.append(content)
        elif etype == "tool_call":
            # Discard any text emitted before this tool call (reasoning/thinking text).
            # Only the final synthesis after all tool calls is the real answer.
            answer_parts.clear()
            tool_calls.append({
                "name": event.get("name", ""),
                "input": event.get("input"),
            })
            continue
        elif etype == "citation":
            # Prefer eval_text (full chunk up to 1500 chars) over the 300-char UI preview.
            # Skip image/media metadata chunks — they carry no semantic text for eval.
            chunk_text = event.get("eval_text") or event.get("chunk_text", "")
            if chunk_text and "Image Content" not in chunk_text and "Image Path" not in chunk_text:
                if chunk_text not in contexts:
                    contexts.append(chunk_text)
        # tool_call is handled above (with answer_parts.clear())
        elif etype == "done":
            if event.get("error"):
                print(f"  [done] agent error: {event['error']}")
            break

    return "".join(answer_parts).strip(), contexts, tool_calls


def _ask_agentic(
    base_url: str,
    course_id: str,
    question_text: str,
    official: bool = False,
) -> tuple[str, list[str], list[dict]]:
    """POST one question to the TS chat endpoint and return (answer, contexts, tool_calls)."""
    jwt = make_eval_jwt()

    if official:
        # Official GraphRAG-Bench protocol: English prompt, keep tool-call guidance
        # but drop the Chinese mode table and instruction noise.
        message = (
            f"{question_text}\n\n"
            "Provide a direct and concise answer based strictly on retrieved knowledge. "
            "If the retrieved context is insufficient, respond with \"I don't know\" — do not fabricate.\n\n"
            "Use the knowledge retrieval tool to look up relevant information. "
            "Select the retrieval `mode` based on question type:\n"
            "- `naive`: fact/definition lookups (pure vector search)\n"
            "- `mix`: relational or cross-topic questions (vector + knowledge graph)\n"
            "- `hybrid` (default): when unsure"
        )
    else:
        message = (
            f"{question_text}\n\n"
            "直接输出最终答案，不需要解释过程或额外信息。"
            "若检索到的上下文不足以支撑回答，直接回答 \"I don't know\"，不要编造内容。\n\n"
            "`mode` 参数控制检索范围，根据问题特点自行选择最合适的模式：\n\n"
            "| 问题类型 | 推荐 mode | 原因 |\n"
            "|---|---|---|\n"
            "| 事实定义、参数查询 | `naive` | 纯向量，速度快，精度高 |\n"
            "| 概念关系、跨章节综合 | `mix` | 向量 + 知识图谱，覆盖更广 |\n"
            "| 不确定时 | `hybrid`（默认） | 自动平衡 |"
        )

    url = f"{base_url.rstrip('/')}/api/v1/courses/{course_id}/chat"
    with httpx.stream(
        "POST",
        url,
        json={
            "message": message,
            "trim_history_to": 0,   # each question is stateless — no prior session history
            "eval_mode": True,
        },
        headers={"Cookie": f"edu_access={jwt}", "Accept": "text/event-stream"},
        timeout=_HTTP_TIMEOUT,
    ) as response:
        if response.status_code != 200:
            body = response.read().decode(errors="replace")[:400]
            raise RuntimeError(f"HTTP {response.status_code}: {body}")
        return _parse_sse_stream(response)


def main(
    questions_path: str,
    output_path: str,
    course_id: str,
    base_url: str,
    limit: int | None,
    delay: float,
    blacklist_path: str | None = None,
    official: bool = False,
) -> None:
    mode_label = "TS Agentic ReAct (official GraphRAG-Bench protocol)" if official else "TS Agentic ReAct (mix)"
    print(f"\n=== Collect Answers — {mode_label} ===\n")

    questions = load_json(questions_path)
    if blacklist_path:
        p = Path(blacklist_path)
        if p.exists():
            bad_ids = {str(x) for x in json.load(p.open(encoding="utf-8"))}
            before = len(questions)
            questions = [q for q in questions if str(q.get("id", "")) not in bad_ids]
            print(f"Blacklist : {len(bad_ids)} IDs loaded, {before - len(questions)} skipped  →  {len(questions)} eligible")
    if limit:
        questions = questions[:limit]

    out_file = Path(output_path)

    # Resume: load already-completed answers so a crash doesn't lose work
    existing: list[dict] = []
    if out_file.exists():
        try:
            existing = json.loads(out_file.read_text(encoding="utf-8"))
            print(f"[resume] Found {len(existing)} existing answers in {output_path}")
        except Exception:
            pass
    done_ids = {str(a["id"]) for a in existing if str(a.get("generated_answer", "")).strip()}
    answers: list[dict] = [a for a in existing if str(a.get("generated_answer", "")).strip()]

    pending = [q for q in questions if str(q.get("id", "")) not in done_ids]

    print(f"Questions total     : {len(questions)}")
    print(f"Already answered    : {len(done_ids)}")
    print(f"Remaining           : {len(pending)}")
    print(f"Course ID           : {course_id}")
    print(f"Next.js URL         : {base_url}")
    print(f"Output              : {output_path}\n")

    # Ensure eval infrastructure exists in the DB
    print("[setup] Ensuring eval student and course enrollment...")
    setup_eval_db()
    ensure_course_enrollment(course_id)
    print()

    tool_calls_total = sum(len(a.get("tool_calls", [])) for a in existing)

    models = _get_agentic_models()
    print(f"LLM (chat/ReAct)    : {models['chat']}")
    print(f"LLM (title/decompose): {models['title']}\n")

    for i, q in enumerate(pending):
        qid = str(q.get("id", ""))
        question_text = str(q.get("question", ""))
        print(f"[{len(done_ids) + i + 1}/{len(questions)}] {question_text[:80]}...")

        try:
            answer, contexts, tool_calls = _ask_agentic(base_url, course_id, question_text, official=official)
            tool_calls_total += len(tool_calls)
            print(f"  → {len(answer)} chars, {len(contexts)} citations, {len(tool_calls)} tool call(s)")
        except Exception as exc:
            print(f"  ERROR: {exc}")
            answer = ""
            contexts = []
            tool_calls = []

        answers.append({
            "id": qid,
            "generated_answer": answer,
            "retrieved_contexts": contexts,
            "tool_calls": tool_calls,
            "tool_call_count": len(tool_calls),
            "llm_model": models["chat"],
            "llm_title_model": models["title"],
        })
        # Incremental save after every question
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(
            json.dumps(answers, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        if delay > 0 and i < len(pending) - 1:
            time.sleep(delay)

    answered = len([a for a in answers if a.get("generated_answer")])
    avg_tools = tool_calls_total / len(answers) if answers else 0
    print(f"\n✓ {len(answers)} answers saved → {output_path}")
    print(f"  answered: {answered}  |  avg tool calls/question: {avg_tools:.2f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect TS agentic answers")
    parser.add_argument("--questions", default=_DEFAULT_QUESTIONS)
    parser.add_argument("--output", default=_DEFAULT_OUTPUT)
    parser.add_argument("--course-id", default=COURSE_RAGAS_CUSTOM)
    parser.add_argument(
        "--base-url",
        default="http://localhost:3000",
        help="Next.js base URL (default: http://localhost:3000). "
             "Override with NEXT_PUBLIC_APP_URL env var if preferred.",
    )
    parser.add_argument("--limit", type=int, default=None,
                        help="Only process the first N questions (for testing)")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="Seconds to wait between questions (rate-limit guard)")
    parser.add_argument("--blacklist", default="tests/eval/data/bad_question_ids.json",
                        help="Path to JSON file with bad question IDs to skip")
    parser.add_argument("--official", action="store_true",
                        help="Use official GraphRAG-Bench protocol: English prompt, "
                             "no Chinese mode table. Required for fair leaderboard comparison.")
    args = parser.parse_args()

    import os
    base = os.environ.get("NEXT_PUBLIC_APP_URL", args.base_url)
    main(args.questions, args.output, args.course_id, base, args.limit, args.delay, args.blacklist, args.official)
