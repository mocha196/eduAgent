"""Test the agent's conversational memory (session history continuity).

Sends question chains where each follow-up explicitly references prior context.
Uses a dedicated memory-test student account so eval data is never contaminated.
Each chain shares one session_id and does NOT pass trim_history_to, so the
TS backend accumulates chat history across turns.

Pass criteria per chain:
  - The follow-up answer contains at least one "recall signal" word/phrase (e.g.
    "之前", "刚才", "上面", "前面", "如上", "您提到", "你提到", "您问", "你问",
    "根据对话", "继续" etc.) OR directly quotes / paraphrases content from turn 1.
  - Heuristic only — a human reviewer should confirm borderline results.

Usage:
  python -m tests.eval.test_memory_mechanism
  python -m tests.eval.test_memory_mechanism --base-url http://localhost:3000
  python -m tests.eval.test_memory_mechanism --output tests/eval/results/memory_test.json
"""
from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path

import httpx

from tests.eval._common import (
    RESULTS_DIR,
    COURSE_RAGAS_CUSTOM,
    _bootstrap,
    _get_db_url,
    _psycopg_dsn,
    _hash_password,
    make_eval_jwt,
)

_bootstrap()

# ---------------------------------------------------------------------------
# Dedicated memory-test student (separate from eval_student)
# ---------------------------------------------------------------------------
MEMORY_TEST_STUDENT_ID       = "e0000003-0000-4000-8000-000000000000"
MEMORY_TEST_STUDENT_USERNAME = "memory_test_student"
MEMORY_TEST_STUDENT_EMAIL    = "memory_test@eval.internal"

_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

# ---------------------------------------------------------------------------
# Test chains
# Each chain is a list of {"question": str, "expect_recall": bool} turns.
# expect_recall=True means this turn's answer should contain a recall signal.
# ---------------------------------------------------------------------------
TEST_CHAINS = [
    {
        "name": "TCP三次握手-追问总结",
        "description": "先问详细解释，再要求一句话总结——agent必须引用上一轮内容",
        "turns": [
            {
                "question": "TCP的三次握手过程是什么？请详细解释每个步骤。",
                "expect_recall": False,
            },
            {
                "question": "请用一句话总结你刚才对TCP三次握手的解释。",
                "expect_recall": True,
            },
        ],
    },
    {
        "name": "HTTP-HTTPS-追问细节",
        "description": "先问区别，再追问其中提到的某个细节",
        "turns": [
            {
                "question": "HTTP和HTTPS有什么主要区别？",
                "expect_recall": False,
            },
            {
                "question": "你上面提到了加密或安全相关的内容，能具体说明TLS握手的步骤吗？",
                "expect_recall": True,
            },
        ],
    },
    {
        "name": "IP地址分类-代词引用",
        "description": "先问分类，再用'上面的分类'引用",
        "turns": [
            {
                "question": "IP地址按类别可以分为哪几类？各类的地址范围是什么？",
                "expect_recall": False,
            },
            {
                "question": "在上面提到的这些IP地址分类中，哪一类在实际互联网中最常用？为什么？",
                "expect_recall": True,
            },
        ],
    },
    {
        "name": "用户偏好记忆",
        "description": "告知偏好后，agent是否能在后续回答中体现",
        "turns": [
            {
                "question": "我目前主要在学习计算机网络的运输层，请介绍一下UDP协议的特点。",
                "expect_recall": False,
            },
            {
                "question": "根据我刚才提到的学习方向，你觉得我应该接下来重点学习哪个主题？",
                "expect_recall": True,
            },
        ],
    },
]

# Phrases that indicate the agent is drawing on conversation history
_RECALL_SIGNALS = [
    "之前", "刚才", "上面", "上文", "前面", "如上", "前述",
    "您提到", "你提到", "您说", "你说", "您问", "你问",
    "根据对话", "根据上文", "根据你", "根据您",
    "继续上", "接着上", "之前提到", "刚才提到",
    "上一", "前一", "第一", "首先你问",
]


# ---------------------------------------------------------------------------
# DB setup for memory test student
# ---------------------------------------------------------------------------

def _setup_memory_test_student(course_id: str) -> None:
    """Idempotently create the memory-test student and enrol in course_id."""
    import psycopg

    dsn = _psycopg_dsn(_get_db_url())
    pw_hash = _hash_password("memory_test_not_used_456!")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (id, username, email, password_hash, role,
                                   real_name, is_active, updated_at)
                VALUES (%s, %s, %s, %s, 'STUDENT', 'Memory Test Student', true, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (MEMORY_TEST_STUDENT_ID, MEMORY_TEST_STUDENT_USERNAME,
                 MEMORY_TEST_STUDENT_EMAIL, pw_hash),
            )
            cur.execute(
                """
                INSERT INTO course_enrollments (id, course_id, student_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (course_id, student_id) DO NOTHING
                """,
                (str(uuid.uuid4()), course_id, MEMORY_TEST_STUDENT_ID),
            )
        conn.commit()
    print(f"[setup] memory_test_student created/verified and enrolled in {course_id}")


# ---------------------------------------------------------------------------
# SSE helpers (same as collect_answers_agentic, but simpler)
# ---------------------------------------------------------------------------

def _parse_sse(response: httpx.Response) -> str:
    """Extract concatenated answer text from an SSE stream."""
    parts: list[str] = []
    for raw_line in response.iter_lines():
        line = raw_line.strip()
        if not line or line == "data: [DONE]":
            if line == "data: [DONE]":
                break
            continue
        if not line.startswith("data: "):
            continue
        try:
            event = json.loads(line[len("data: "):])
        except json.JSONDecodeError:
            continue
        if event.get("type") == "text":
            parts.append(event.get("content", ""))
        elif event.get("type") == "done":
            break
    return "".join(parts).strip()


def _chat(
    base_url: str,
    course_id: str,
    message: str,
    session_id: str,
) -> str:
    """Send one message to the course chat endpoint, return the answer text."""
    jwt = make_eval_jwt(
        user_id=MEMORY_TEST_STUDENT_ID,
        username=MEMORY_TEST_STUDENT_USERNAME,
    )
    url = f"{base_url.rstrip('/')}/api/v1/courses/{course_id}/chat"
    with httpx.stream(
        "POST",
        url,
        json={
            "message": message,
            "session_id": session_id,
            # trim_history_to intentionally omitted → history accumulates
        },
        headers={"Cookie": f"edu_access={jwt}", "Accept": "text/event-stream"},
        timeout=_HTTP_TIMEOUT,
    ) as response:
        if response.status_code != 200:
            body = response.read().decode(errors="replace")[:400]
            raise RuntimeError(f"HTTP {response.status_code}: {body}")
        return _parse_sse(response)


# ---------------------------------------------------------------------------
# Recall detection
# ---------------------------------------------------------------------------

def _has_recall_signal(answer: str) -> tuple[bool, str]:
    """Return (found, matched_phrase) — True if the answer references prior context."""
    lower = answer.lower()
    for phrase in _RECALL_SIGNALS:
        if phrase in lower:
            return True, phrase
    return False, ""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(
    base_url: str,
    course_id: str,
    output_path: str,
    delay: float,
) -> None:
    print("\n=== Memory Mechanism Test ===\n")
    print(f"Student  : {MEMORY_TEST_STUDENT_USERNAME} ({MEMORY_TEST_STUDENT_ID})")
    print(f"Course   : {course_id}")
    print(f"Endpoint : {base_url}")
    print()

    _setup_memory_test_student(course_id)
    print()

    chain_results: list[dict] = []
    passed = 0
    total_recall_turns = 0

    for chain in TEST_CHAINS:
        session_id = str(uuid.uuid4())  # fresh session per chain
        print(f"── Chain: {chain['name']} ──────────────────────────────")
        print(f"   {chain['description']}")
        print(f"   session_id: {session_id}")
        print()

        turn_records: list[dict] = []
        chain_pass = True

        for t_idx, turn in enumerate(chain["turns"]):
            q = turn["question"]
            expect = turn["expect_recall"]
            print(f"  Turn {t_idx + 1}: {q[:80]}{'...' if len(q) > 80 else ''}")

            try:
                answer = _chat(base_url, course_id, q, session_id)
            except Exception as exc:
                print(f"  ERROR: {exc}")
                answer = ""

            found, matched = _has_recall_signal(answer)
            answer_preview = answer[:200].replace("\n", " ")
            print(f"  Answer : {answer_preview}{'...' if len(answer) > 200 else ''}")

            result_str = ""
            if expect:
                total_recall_turns += 1
                if found:
                    result_str = f"  ✓ RECALL DETECTED → \"{matched}\""
                    passed += 1
                else:
                    result_str = "  ✗ NO RECALL SIGNAL (answer may still be correct — manual review needed)"
                    chain_pass = False
                print(result_str)
            print()

            turn_records.append({
                "turn": t_idx + 1,
                "question": q,
                "answer": answer,
                "expect_recall": expect,
                "recall_found": found if expect else None,
                "recall_signal": matched if expect else None,
            })

            if delay > 0 and t_idx < len(chain["turns"]) - 1:
                time.sleep(delay)

        status = "PASS" if chain_pass else "FAIL (manual review)"
        print(f"  Chain result: {status}")
        print()

        chain_results.append({
            "chain": chain["name"],
            "description": chain["description"],
            "session_id": session_id,
            "status": status,
            "turns": turn_records,
        })

        if delay > 0:
            time.sleep(delay)

    # Summary
    print("=" * 60)
    print(f"Recall signal detected : {passed} / {total_recall_turns} expected turns")
    print(f"Chains passed          : {sum(1 for c in chain_results if c['status'] == 'PASS')} / {len(chain_results)}")
    print()
    print("NOTE: Heuristic recall detection. Review answers manually")
    print("      to confirm actual conversational continuity quality.")
    print("=" * 60)

    # Save results
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "summary": {
                    "recall_detected": passed,
                    "recall_expected": total_recall_turns,
                    "chains_passed": sum(1 for c in chain_results if c["status"] == "PASS"),
                    "chains_total": len(chain_results),
                },
                "chains": chain_results,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n✓ Results saved → {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test agent conversational memory")
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--course-id", default=COURSE_RAGAS_CUSTOM)
    parser.add_argument(
        "--output",
        default=str(RESULTS_DIR / "memory_test.json"),
        help="Path to write results JSON",
    )
    parser.add_argument(
        "--delay", type=float, default=1.5,
        help="Seconds between turns (default 1.5)",
    )
    args = parser.parse_args()
    main(args.base_url, args.course_id, args.output, args.delay)
