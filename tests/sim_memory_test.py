"""
记忆机制功能测试 — 模拟真实学生对话
=====================================
模拟 test_student 在「计算机网络基础」课程中进行多轮对话，
触发后端 MemoryConsolidator，然后验证 DB 中生成了 Facts / Concepts。

用法（在 e:/appProjects/eee 目录下）：
    .venv\\Scripts\\python.exe -m tests.sim_memory_test

环境要求：
- Next.js 服务运行在 localhost:3000
- DATABASE_URL 在 .env 中配置（用于最终验证查询）
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import textwrap
import hmac
import hashlib
import base64
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parents[1]
for _p in [REPO_ROOT / ".env", REPO_ROOT / "edu-platform" / ".env"]:
    if _p.exists():
        from dotenv import load_dotenv
        load_dotenv(_p, override=False)

# ---------------------------------------------------------------------------
# 测试学生凭证（已通过 Prisma 脚本创建并加入课程）
# ---------------------------------------------------------------------------
STUDENT_ID       = "db0caf7b-2211-43b1-8eac-cda72f062215"
STUDENT_USERNAME = "test_student"
COURSE_ID        = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"
BASE_URL         = os.environ.get("NEXT_PUBLIC_APP_URL", "http://localhost:3000")

# ---------------------------------------------------------------------------
# 对话场景：真实模拟一名初学者学习计算机网络
#
# 设计原则：
#   - Round 1-2：基础问题，学生刚开始学，什么都不懂 → 预期提取 question / difficulty facts
#   - Round 3：学生对 HTTP 有所理解，对 DNS 感到困惑 → 预期 concept_mastery(HTTP) + concept_confusion(DNS)
#   - Round 4：追问三次握手，表示困惑 → 预期 concept_confusion(三次握手/TCP)
#   - Round 5：学生说"哦我明白了"，总结 OSI 分层 → 预期 concept_mastery(OSI分层)
# ---------------------------------------------------------------------------
CONVERSATION_TURNS = [
    {
        "label": "初学：协议分层动机",
        "message": "老师，我刚开始学计算机网络，网络协议为什么要分层？有什么好处？",
    },
    {
        "label": "基础：OSI与TCP/IP",
        "message": (
            "OSI 模型有七层，TCP/IP 只有四层，这两个模型有什么区别？"
            "实际互联网用的是哪一个？"
        ),
    },
    {
        "label": "对HTTP理解，但对DNS困惑",
        "message": (
            "HTTP 我大概明白了，就是浏览器和服务器之间的请求响应协议。"
            "但是我不明白 DNS 是干什么的，域名解析到底是怎么工作的？"
            "如果没有 DNS 会怎样？"
        ),
    },
    {
        "label": "TCP三次握手感到困惑",
        "message": (
            "TCP 三次握手我看了好几遍还是搞不清楚。"
            "为什么非要三次，两次不行吗？"
            "第三次 ACK 如果丢失了会发生什么？"
        ),
    },
    {
        "label": "理解OSI分层，总结收获",
        "message": (
            "经过这几个问题，我终于搞明白了网络分层的意义：每一层只负责自己的事，"
            "通过接口调用下层服务，这样修改某一层不会影响其他层。"
            "请问传输层和网络层的主要区别是什么？"
        ),
    },
]

# ---------------------------------------------------------------------------
# JWT 生成（纯 stdlib，不依赖 PyJWT）
# ---------------------------------------------------------------------------

def make_jwt(user_id: str, username: str, role: str = "STUDENT", ttl: int = 3600) -> str:
    secret = os.environ.get("JWT_SECRET", "").strip()
    if not secret:
        raise RuntimeError("JWT_SECRET 未设置，请确认 .env 已加载")
    iss = os.environ.get("JWT_ISS", "edu-platform")
    now = int(time.time())

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header  = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps(
        {"sub": user_id, "username": username, "role": role,
         "iat": now, "exp": now + ttl, "iss": iss},
        separators=(",", ":"),
    ).encode())
    sig_input = f"{header}.{payload}".encode()
    sig = b64url(hmac.new(secret.encode(), sig_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


# ---------------------------------------------------------------------------
# SSE 流式请求辅助
# ---------------------------------------------------------------------------

def chat_request(jwt: str, message: str) -> dict:
    """
    向 /api/v1/courses/{COURSE_ID}/chat 发送请求，消费 SSE 流。
    返回 {answer, tool_calls, tokens, exec_ms, error}
    """
    import httpx

    url = f"{BASE_URL}/api/v1/courses/{COURSE_ID}/chat"
    headers = {
        "Authorization": f"Bearer {jwt}",
        "Content-Type": "application/json",
    }
    body = {"message": message}

    answer_parts: list[str] = []
    tool_calls: list[dict] = []
    tokens: int | None = None
    exec_ms: int | None = None
    error: str | None = None

    try:
        with httpx.stream(
            "POST", url,
            json=body,
            headers=headers,
            timeout=httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0),
        ) as resp:
            if resp.status_code != 200:
                body_bytes = resp.read()
                return {
                    "answer": "",
                    "tool_calls": [],
                    "tokens": None,
                    "exec_ms": None,
                    "error": f"HTTP {resp.status_code}: {body_bytes.decode(errors='replace')[:300]}",
                }
            for line in resp.iter_lines():
                line = line.strip()
                if not line or not line.startswith("data: "):
                    continue
                if line == "data: [DONE]":
                    break
                try:
                    ev = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue
                t = ev.get("type")
                if t == "text" and ev.get("content"):
                    answer_parts.append(ev["content"])
                elif t == "tool_call":
                    tool_calls.append({"name": ev.get("name"), "input": ev.get("input")})
                elif t == "done":
                    tokens = ev.get("tokens")
                    exec_ms = ev.get("exec_time_ms")
                    error = ev.get("error")
    except Exception as exc:
        error = str(exc)

    return {
        "answer": "".join(answer_parts),
        "tool_calls": tool_calls,
        "tokens": tokens,
        "exec_ms": exec_ms,
        "error": error,
    }


# ---------------------------------------------------------------------------
# DB 验证
# ---------------------------------------------------------------------------

def _psycopg_dsn(url: str) -> str:
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    url = url.replace("postgresql+asyncpg", "postgresql").replace("postgresql+psycopg", "postgresql")
    parsed = urlparse(url)
    if parsed.query:
        _LIBPQ_PARAMS = {"host","port","dbname","user","password","sslmode","connect_timeout"}
        filtered = {k: v for k, v in parse_qs(parsed.query).items() if k in _LIBPQ_PARAMS}
        parsed = parsed._replace(query=urlencode(filtered, doseq=True))
    return urlunparse(parsed)


def verify_memory_in_db(user_id: str) -> dict:
    """查询 DB 返回该用户的 facts 和 concepts 数量及内容摘要。"""
    import psycopg
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        return {"error": "DATABASE_URL 未设置，跳过 DB 验证"}
    dsn = _psycopg_dsn(db_url)
    result: dict = {}
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # Facts
            cur.execute(
                "SELECT id, category, content, confidence, timestamp "
                "FROM user_memory_facts WHERE user_id = %s ORDER BY timestamp DESC LIMIT 20",
                (user_id,),
            )
            rows = cur.fetchall()
            result["facts"] = [
                {"id": str(r[0])[:8], "category": r[1], "content": r[2],
                 "confidence": float(r[3]), "ts": str(r[4])}
                for r in rows
            ]
            result["facts_count"] = len(rows)

            # Concepts
            cur.execute(
                "SELECT id, name, mastery_level, last_updated "
                "FROM user_memory_concepts WHERE user_id = %s ORDER BY last_updated DESC LIMIT 20",
                (user_id,),
            )
            rows = cur.fetchall()
            result["concepts"] = [
                {"id": str(r[0])[:8], "name": r[1], "mastery": float(r[2]),
                 "last_updated": str(r[3])}
                for r in rows
            ]
            result["concepts_count"] = len(rows)
    return result


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

    print("=" * 60)
    print("  记忆机制功能测试")
    print(f"  学生: {STUDENT_USERNAME} ({STUDENT_ID[:8]}...)")
    print(f"  课程: {COURSE_ID[:8]}...")
    print(f"  后端: {BASE_URL}")
    print("=" * 60)

    # 生成 JWT
    try:
        jwt = make_jwt(STUDENT_ID, STUDENT_USERNAME)
        print(f"\n[JWT] 生成成功（前40字符: {jwt[:40]}...）\n")
    except RuntimeError as e:
        print(f"\n[错误] {e}")
        return

    # 查询对话前的记忆状态（基线）
    print("─" * 60)
    print("[基线] 对话前的记忆状态：")
    baseline = verify_memory_in_db(STUDENT_ID)
    if "error" not in baseline:
        print(f"  Facts 数量：{baseline['facts_count']}")
        print(f"  Concepts 数量：{baseline['concepts_count']}")
    else:
        print(f"  {baseline['error']}")
    print()

    # 依次发送每轮对话
    results = []
    for i, turn in enumerate(CONVERSATION_TURNS, start=1):
        print(f"─" * 60)
        print(f"[Turn {i}/{len(CONVERSATION_TURNS)}] {turn['label']}")
        print(f"  问: {textwrap.shorten(turn['message'], width=80, placeholder='...')}")
        t0 = time.perf_counter()
        resp = chat_request(jwt, turn["message"])
        elapsed = time.perf_counter() - t0

        if resp["error"]:
            print(f"  ✗ 错误: {resp['error']}")
        else:
            answer_preview = textwrap.shorten(resp["answer"], width=120, placeholder="...")
            print(f"  答: {answer_preview}")
            tc_names = [tc["name"] for tc in resp["tool_calls"]]
            if tc_names:
                print(f"  工具: {', '.join(tc_names)}")
            print(f"  耗时: {elapsed:.1f}s  tokens: {resp['tokens']}  后端ms: {resp['exec_ms']}")

        results.append({"turn": i, "label": turn["label"], **resp})

        # 轮次间短暂等待，给后端记忆提取时间（consolidateSession 是 async void）
        if i < len(CONVERSATION_TURNS):
            print("  [等待后端记忆提取 3s ...]")
            time.sleep(3)

    # 等待最后一次记忆提取完成
    print()
    print("[等待最后一次记忆提取 8s ...]")
    time.sleep(8)

    # 查询对话后的记忆状态
    print()
    print("=" * 60)
    print("[验证] 对话后的记忆状态：")
    after = verify_memory_in_db(STUDENT_ID)
    if "error" in after:
        print(f"  {after['error']}")
    else:
        print(f"\n  Facts 数量：{after['facts_count']}（基线: {baseline.get('facts_count', '?')}）")
        if after["facts"]:
            print("\n  最新 Facts：")
            for f in after["facts"][:8]:
                print(f"    [{f['category']:20s}] conf={f['confidence']:.2f}  {f['content']}")

        print(f"\n  Concepts 数量：{after['concepts_count']}（基线: {baseline.get('concepts_count', '?')}）")
        if after["concepts"]:
            print("\n  最新 Concepts：")
            for c in after["concepts"][:8]:
                bar = "█" * int(c["mastery"] * 10) + "░" * (10 - int(c["mastery"] * 10))
                print(f"    {bar} {c['mastery']:.2f}  {c['name']}")

    # 摘要
    print()
    print("=" * 60)
    success_turns = sum(1 for r in results if not r["error"])
    print(f"[汇总] {success_turns}/{len(CONVERSATION_TURNS)} 轮对话成功")
    if "error" not in after:
        new_facts = after["facts_count"] - baseline.get("facts_count", 0)
        new_concepts = after["concepts_count"] - baseline.get("concepts_count", 0)
        print(f"       新增 Facts: {new_facts}  新增 Concepts: {new_concepts}")
        if new_facts > 0:
            print("\n  记忆提取验证通过！")
        else:
            print("\n  警告：未检测到新 Facts，请检查 Next.js 日志中的 MemoryConsolidator 输出")
    print("=" * 60)


if __name__ == "__main__":
    main()
