"""Quick standalone test for the Agentic chat endpoint (no Mix pipeline)."""
import sys, os, time, json
sys.path.insert(0, ".")
from tests.eval._common import (
    _bootstrap, make_eval_jwt, ensure_course_enrollment,
    setup_eval_db, COURSE_RAGAS_CUSTOM,
)
_bootstrap()
setup_eval_db()
ensure_course_enrollment(COURSE_RAGAS_CUSTOM)

import httpx

COURSE_ID = COURSE_RAGAS_CUSTOM
BASE_URL = os.environ.get("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
jwt = make_eval_jwt()
url = f"{BASE_URL.rstrip('/')}/api/v1/courses/{COURSE_ID}/chat"
QUESTION = "网络体系结构中协议分层结构如何应对异构性，并且协议设计目的是什么？"
msg = (
    f"{QUESTION}\n\n"
    "直接输出最终答案，不需要解释过程或额外信息。"
    "若检索到的上下文不足以支撑回答，直接回答 \"I don't know\"，不要编造内容。\n\n"
    "`mode` 参数控制检索范围，根据问题特点自行选择最合适的模式：\n\n"
    "| 问题类型 | 推荐 mode | 原因 |\n"
    "|---|---|---|\n"
    "| 事实定义、参数查询 | `naive` | 纯向量，速度快，精度高 |\n"
    "| 概念关系、跨章节综合 | `mix` | 向量 + 知识图谱，覆盖更广 |\n"
    "| 不确定时 | `hybrid`（默认） | 自动平衡 |"
)

print(">>> 发送 Agentic 请求（eval_mode=True，Cookie 认证）…")
t0 = time.perf_counter()
tool_call_count = 0

with httpx.stream(
    "POST", url,
    json={"message": msg, "eval_mode": True, "trim_history_to": 0},
    headers={"Cookie": f"edu_access={jwt}", "Accept": "text/event-stream"},
    timeout=httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0),
) as r:
    print("STATUS:", r.status_code)
    if r.status_code != 200:
        print("BODY:", r.read().decode())
        sys.exit(1)

    answer_parts = []
    try:
        for raw in r.iter_lines():
            line = raw.strip()
            if not line or not line.startswith("data: "):
                continue
            if line == "data: [DONE]":
                print("  [SSE DONE]")
                break
            try:
                ev = json.loads(line[6:])
            except json.JSONDecodeError:
                print(f"  [非JSON行]: {line[:80]}")
                continue
            etype = ev.get("type")
            if etype == "tool_call":
                tool_call_count += 1
                name = ev.get("name", "")
                inp  = ev.get("input")
                inp_str = json.dumps(inp, ensure_ascii=False)[:150] if inp else ""
                print(f"  [工具调用 #{tool_call_count}] {name}  input={inp_str}")
            elif etype == "tool_result":
                output = ev.get("output", "")
                print(f"  [工具结果] preview={str(output)[:100]!r}")
            elif etype == "text" and ev.get("content"):
                answer_parts.append(ev["content"])
            elif etype == "error":
                print(f"  [ERROR事件] {ev}")
            elif etype == "done":
                err = ev.get("error")
                print(f"  [done] tokens={ev.get('tokens')}  time={ev.get('exec_time_ms')}ms  error={err}")
            else:
                print(f"  [其他事件 type={etype!r}]: {str(ev)[:100]}")
    except Exception as exc:
        print(f"\n  [流式读取异常] {type(exc).__name__}: {exc}")

elapsed = time.perf_counter() - t0
print(f"\n共 {tool_call_count} 次工具调用，耗时 {elapsed:.1f}s")
print("Agentic 答案:", "".join(answer_parts)[:400])
