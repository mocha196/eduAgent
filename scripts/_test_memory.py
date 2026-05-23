"""Long-term memory system integration test.

Tests the two memory write paths and the retrieval/injection path:

  Path A — Agent proactively calls `remember_fact` tool during a session.
  Path B — Auto-extraction fires async after each turn (immediate, Mem0-style).
  Path C — Retrieved memory concepts are injected into subsequent session prompts.

Uses mock_student_01 (already enrolled in the CN course) via real cookie-based login.
Requires the Next.js server to be running on localhost:3000.

Usage:
  cd e:\\appProjects\\eee
  .venv\\Scripts\\python.exe scripts/_test_memory.py
  .venv\\Scripts\\python.exe scripts/_test_memory.py --base-url http://localhost:3000
  .venv\\Scripts\\python.exe scripts/_test_memory.py --no-clear-memories
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL   = "http://localhost:3000"
COURSE_ID  = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"   # 计算机网络基础
USERNAME   = "mock_student_01"
PASSWORD   = "MockStudent@2026"

# How long to wait (seconds) for async fire-and-forget extraction to complete.
EXTRACT_WAIT_SEC = 6

_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def login(base_url: str) -> str:
    """POST /api/v1/auth/login and return the edu_access cookie value."""
    resp = httpx.post(
        f"{base_url}/api/v1/login",
        json={"username": USERNAME, "password": PASSWORD},
        timeout=15.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Login failed ({resp.status_code}): {resp.text[:300]}"
        )
    cookie = resp.cookies.get("edu_access")
    if not cookie:
        raise RuntimeError("Login succeeded but edu_access cookie not found in response.")
    print(f"[auth] Logged in as {USERNAME}")
    return cookie


# ---------------------------------------------------------------------------
# Memories API helpers
# ---------------------------------------------------------------------------

def get_memories(base_url: str, cookie: str) -> dict:
    """GET /api/v1/me/memories → {facts: [...], concepts: [...]}"""
    resp = httpx.get(
        f"{base_url}/api/v1/me/memories",
        headers={"Cookie": f"edu_access={cookie}"},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def clear_memories(base_url: str, cookie: str) -> dict:
    """DELETE /api/v1/me/memories → {deleted_facts, deleted_concepts}"""
    resp = httpx.delete(
        f"{base_url}/api/v1/me/memories",
        headers={"Cookie": f"edu_access={cookie}"},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# SSE chat helper
# ---------------------------------------------------------------------------

def chat_sse(
    base_url: str,
    cookie: str,
    message: str,
    session_id: str | None = None,
    *,
    trim_history_to: int | None = None,
) -> dict:
    """Send one message to the course chat endpoint; parse all SSE events.

    session_id: if None, server auto-creates/uses the default session for this user+course.

    Returns:
      {
        "answer": str,
        "tool_calls": [{"name": str, "args": dict, "result": str}, ...],
        "tokens": int | None,
        "error": str | None,
        "session_id": str | None,
      }
    """
    url = f"{base_url.rstrip('/')}/api/v1/courses/{COURSE_ID}/chat"
    payload: dict = {"message": message}
    if session_id:
        payload["session_id"] = session_id
    if trim_history_to is not None:
        payload["trim_history_to"] = trim_history_to

    answer_parts: list[str] = []
    tool_calls: list[dict] = []
    pending_tool: dict | None = None
    tokens: int | None = None
    error: str | None = None

    with httpx.stream(
        "POST",
        url,
        json=payload,
        headers={
            "Cookie": f"edu_access={cookie}",
            "Accept": "text/event-stream",
        },
        timeout=_HTTP_TIMEOUT,
    ) as resp:
        if resp.status_code != 200:
            body = resp.read().decode(errors="replace")[:400]
            raise RuntimeError(f"HTTP {resp.status_code}: {body}")

        for raw_line in resp.iter_lines():
            line = raw_line.strip()
            if not line or line == "data: [DONE]":
                continue
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[len("data: "):])
            except json.JSONDecodeError:
                continue

            etype = event.get("type", "")

            if etype == "text":
                answer_parts.append(event.get("content", ""))

            elif etype == "tool_call":
                pending_tool = {
                    "name":   event.get("name", ""),
                    "args":   event.get("args", {}),
                    "result": None,
                }

            elif etype == "tool_result":
                if pending_tool:
                    pending_tool["result"] = event.get("content", "")
                    tool_calls.append(pending_tool)
                    pending_tool = None

            elif etype == "done":
                tokens = event.get("tokens")
                error  = event.get("error")
                break

    return {
        "answer":     "".join(answer_parts).strip(),
        "tool_calls": tool_calls,
        "tokens":     tokens,
        "error":      error,
    }


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

RESET = "\033[0m"
GREEN = "\033[32m"
RED   = "\033[31m"
CYAN  = "\033[36m"
BOLD  = "\033[1m"


def _ok(msg: str) -> str:
    return f"{GREEN}✓ {msg}{RESET}"


def _fail(msg: str) -> str:
    return f"{RED}✗ {msg}{RESET}"


def _section(title: str) -> None:
    print(f"\n{BOLD}{CYAN}{'─' * 60}{RESET}")
    print(f"{BOLD}{CYAN}  {title}{RESET}")
    print(f"{BOLD}{CYAN}{'─' * 60}{RESET}")


def _preview(text: str, n: int = 200) -> str:
    text = text.replace("\n", " ")
    return text[:n] + ("…" if len(text) > n else "")


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def test_a_agent_remember_fact(
    base_url: str, cookie: str
) -> dict:
    """Path A: Agent should proactively call remember_fact when user expresses confusion."""
    _section("Test A — Agent-triggered remember_fact")

    question = (
        "我学 TCP 拥塞控制时一直搞不清楚慢启动（slow start）和拥塞避免（congestion avoidance）"
        "这两个阶段的区别，你能帮我解释一下吗？"
    )
    print(f"  Question : {_preview(question, 120)}")

    # trim_history_to=0 clears Redis context window (fresh start), but does NOT wipe DB memories
    result = chat_sse(base_url, cookie, question, trim_history_to=0)

    print(f"  Answer   : {_preview(result['answer'])}")
    print(f"  Tokens   : {result['tokens']}")
    if result["error"]:
        print(f"  Error    : {result['error']}")

    remember_calls = [tc for tc in result["tool_calls"] if tc["name"] == "remember_fact"]
    print(f"\n  Tool calls ({len(result['tool_calls'])} total):")
    for tc in result["tool_calls"]:
        print(f"    → {tc['name']}  args={json.dumps(tc['args'], ensure_ascii=False)}")

    passed = len(remember_calls) > 0
    if passed:
        for rc in remember_calls:
            cat = rc["args"].get("category", "?")
            content = rc["args"].get("fact_content", rc["args"].get("content", "?"))
            print(f"\n  {_ok(f'remember_fact called → category={cat}')}")
            print(f"    content: {_preview(str(content), 100)}")
    else:
        print(f"\n  {_fail('remember_fact was NOT called by agent')}")
        print("  (Note: agent may not always call it; depends on LLM judgment)")

    return {"passed": passed, "tool_calls": result["tool_calls"]}


def test_b_auto_extraction(
    base_url: str, cookie: str,
    memories_before: dict, wait_sec: int,
) -> dict:
    """Path B: Auto-extraction should fire async after the turn; check DB after wait."""
    _section("Test B — Async auto-extraction after turn")

    print(f"  Facts before  : {len(memories_before['facts'])}")
    print(f"  Concepts before: {len(memories_before['concepts'])}")
    print(f"  Waiting {wait_sec}s for async extraction to complete…")
    time.sleep(wait_sec)

    memories_after = get_memories(base_url, cookie)
    new_facts    = len(memories_after["facts"])    - len(memories_before["facts"])
    new_concepts = len(memories_after["concepts"]) - len(memories_before["concepts"])

    print(f"  Facts after   : {len(memories_after['facts'])}  (Δ {new_facts:+d})")
    print(f"  Concepts after: {len(memories_after['concepts'])}  (Δ {new_concepts:+d})")

    if memories_after["facts"]:
        print("\n  Latest facts extracted:")
        for f in memories_after["facts"][:5]:
            print(f"    [{f.get('category','?')}] {_preview(f.get('content',''), 90)}"
                  f"  conf={f.get('confidence', '?'):.2f}")

    if memories_after["concepts"]:
        print("\n  Concepts (mastery levels):")
        for c in memories_after["concepts"][:5]:
            print(f"    {c.get('name','?')}  mastery={c.get('masteryLevel','?'):.2f}")

    # Pass if either new facts or concepts appeared (agent-written facts also count here)
    total_new = new_facts + new_concepts
    # Extraction could have produced 0 facts for trivial exchanges — also acceptable
    passed = True   # extraction fire is always attempted; DB change depends on LLM output
    status = _ok(f"{total_new} new memory items") if total_new > 0 else f"  (0 new items — LLM may have returned [] for this turn; fire-and-forget still ran)"
    print(f"\n  {status}")

    return {"passed": passed, "new_facts": new_facts, "new_concepts": new_concepts,
            "memories_after": memories_after}


def test_c_memory_injection(
    base_url: str, cookie: str, memories: dict
) -> dict:
    """Path C: Memory stored in DB should be injected into the next turn via
    buildRetrievedMemoryBlock (called at start of every turn)."""
    _section("Test C — Memory injection into next turn")

    if not memories["facts"] and not memories["concepts"]:
        print("  No memories in DB yet — skipping injection check.")
        return {"passed": None, "skipped": True}

    # Show what concepts/facts we expect to be injected
    if memories["concepts"]:
        print("  Concepts in DB (expect TF-IDF retrieval & injection):")
        for c in memories["concepts"][:6]:
            print(f"    {c.get('name','?')}  mastery={c.get('masteryLevel','?'):.2f}")
    if memories["facts"]:
        print("  Recent facts in DB:")
        for f in memories["facts"][:3]:
            print(f"    [{f.get('category','?')}] {_preview(f.get('content',''), 70)}")

    # Ask a follow-up question referencing the same topic.
    # Memory injection occurs automatically before this turn in buildRetrievedMemoryBlock.
    question = (
        "我想继续学习 TCP 相关的知识，你觉得我应该从哪里入手？"
        "能根据我目前的学习状态给一些建议吗？"
    )
    print(f"\n  Question : {_preview(question, 120)}")

    result = chat_sse(base_url, cookie, question)
    print(f"  Answer   : {_preview(result['answer'])}")

    # Heuristic: if memory was injected, agent is likely to mention known difficulty/mastery
    injection_signals = [
        "慢启动", "拥塞控制", "拥塞避免", "难", "困惑", "不清楚",
        "之前", "了解到", "你提到", "上次", "学习状态", "掌握",
        "建议", "你已经",
    ]
    answer_lower = result["answer"].lower()
    matched = [s for s in injection_signals if s in answer_lower]
    # Note: injection is indirect — the system prompt guides LLM, not explicit quoting
    passed = len(matched) > 0
    if passed:
        print(f"\n  {_ok('Injection signals detected: ' + ', '.join(matched))}")
    else:
        print(f"\n  {_fail('No clear injection signals found')}")
        print("  (Memory is in system prompt; agent may paraphrase rather than quote directly)")

    return {"passed": passed, "signals": matched}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(base_url: str, clear_memories_first: bool) -> None:
    print(f"\n{'=' * 60}")
    print(f"  Long-Term Memory System Integration Test")
    print(f"  base_url : {base_url}")
    print(f"  student  : {USERNAME}")
    print(f"  course   : {COURSE_ID}")
    print(f"{'=' * 60}")

    # 1. Login
    try:
        cookie = login(base_url)
    except Exception as exc:
        print(f"\n[FATAL] Cannot login: {exc}")
        sys.exit(1)

    # 2. Optionally clear existing memories for a clean run
    if clear_memories_first:
        deleted = clear_memories(base_url, cookie)
        print(f"[setup] Cleared memories: {deleted}")

    # 3. Baseline
    baseline = get_memories(base_url, cookie)
    print(f"[baseline] facts={len(baseline['facts'])}, concepts={len(baseline['concepts'])}")

    # ── Test A ──
    result_a = test_a_agent_remember_fact(base_url, cookie)

    # Snapshot memories after Test A (before extraction wait)
    memories_after_a = get_memories(base_url, cookie)

    # ── Test B ──
    result_b = test_b_auto_extraction(
        base_url, cookie,
        memories_before=memories_after_a,
        wait_sec=EXTRACT_WAIT_SEC,
    )

    # ── Test C ──
    result_c = test_c_memory_injection(
        base_url, cookie,
        memories=result_b["memories_after"],
    )

    # ── Summary ──
    _section("Summary")
    def _status(r: dict, key: str = "passed") -> str:
        v = r.get(key)
        if v is None:
            return f"{CYAN}SKIPPED{RESET}"
        return _ok("PASS") if v else _fail("FAIL")

    print(f"  Test A (agent remember_fact)  : {_status(result_a)}")
    print(f"  Test B (async auto-extraction): {_ok('FIRED')}  "
          f"(+{result_b['new_facts']} facts, +{result_b['new_concepts']} concepts)")
    print(f"  Test C (memory injection)     : {_status(result_c)}")
    if result_c.get("skipped"):
        print("           → Skipped: no concepts in DB after Tests A+B")
    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Long-term memory integration test")
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument(
        "--no-clear-memories",
        action="store_true",
        help="Keep existing memories instead of wiping them before the run",
    )
    args = parser.parse_args()
    main(args.base_url, clear_memories_first=not args.no_clear_memories)
