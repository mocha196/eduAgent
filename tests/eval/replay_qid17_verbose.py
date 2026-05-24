"""
=== 案例复现脚本：QID 17 的 Mix vs Agentic 详细对比 ===

本脚本对 QID 17 进行重测，并将检索块、工具调用、推理过程全部打印到终端。

用法：
    python -m tests.eval.replay_qid17_verbose

要求：Next.js dev server 在 http://localhost:3000 运行
"""
from __future__ import annotations

import json
import os
import re
import sys
import textwrap
import time

from tests.eval._common import (
    COURSE_RAGAS_CUSTOM,
    _bootstrap,
    make_eval_jwt,
    ensure_course_enrollment,
    setup_eval_db,
    _rrf_merge,
)

_bootstrap()

# ─── Patch: 跳过 RAGAnything 的 parser 安装检查 ──────────────────────────────
# 检索操作不需要 document parser (mineru)，只有文档摄入时才需要。
# 通过提前将 _parser_installation_checked 置为 True 跳过该检查。
from rag_mvp.engine import RAGAnything as _RAGAnything

_orig_ensure_init = _RAGAnything._ensure_lightrag_initialized

async def _patched_ensure_init(self):
    self._parser_installation_checked = True  # skip mineru check; retrieval-only
    return await _orig_ensure_init(self)

_RAGAnything._ensure_lightrag_initialized = _patched_ensure_init  # type: ignore[method-assign]

# ─── 目标问题 ─────────────────────────────────────────────────────────────────
QUESTION_ID   = "17"
QUESTION_TEXT = "网络体系结构中协议分层结构如何应对异构性，并且协议设计目的是什么？"
GOLD_ANSWER   = (
    "协议分层结构通过将网络划分为多个层次，每层独立处理特定功能，并使用标准接口，"
    "从而应对异构性。例如，不同介质（光纤、铜缆、空气）和接入方式（有线、WLAN、移动数据网络）"
    "通过分层实现统一标准，确保技术互通。协议设计目的是为进行网络中的数据交换而建立规则、"
    "标准或约定，包括语法（数据格式）、语义（功能）和时序（操作顺序），使通信双方共同遵守、互相理解。"
)

COURSE_ID   = os.environ.get("EVAL_COURSE_ID", COURSE_RAGAS_CUSTOM)
BASE_URL    = os.environ.get("NEXT_PUBLIC_APP_URL", "http://localhost:3000")

DIVIDER = "=" * 80
SUBDIV  = "-" * 60


def banner(title: str) -> None:
    print(f"\n{DIVIDER}")
    print(f"  {title}")
    print(DIVIDER)


def print_chunk(idx: int, text: str, label: str = "") -> None:
    header = f"  ┌── 检索块 #{idx + 1}" + (f"  [{label}]" if label else "")
    print(f"\n{header}")
    # Print first 600 chars to keep output manageable
    preview = text[:600]
    for line in preview.splitlines():
        for wrapped in textwrap.wrap(line or " ", width=74, initial_indent="  │  ", subsequent_indent="  │  "):
            print(wrapped)
    if len(text) > 600:
        print("  │  … (内容截断，共 {} 字符)".format(len(text)))
    print("  └──")


def _make_llm():
    """Build the same ChatOpenAI instance used by _common.query_lightrag_direct."""
    from rag_mvp.config import settings
    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr
    return ChatOpenAI(
        model=settings.effective_chat_model,
        api_key=SecretStr(settings.effective_chat_api_key or "placeholder"),
        base_url=settings.effective_chat_base_url,
        temperature=0.0,
        extra_body={"enable_thinking": False},
    )


# ─── Part 1: Mix 模式（手动执行管线，逐步打印）────────────────────────────────

def run_mix_verbose() -> tuple[str, list[str]]:
    banner("Part 1 — Mix 模式（非 Agentic）详细日志")
    print(f"\n问题 (QID {QUESTION_ID})：{QUESTION_TEXT}")
    print(f"\n参考答案：{GOLD_ANSWER}")

    from rag_mvp.engine import course_retrieval_hits_sync, course_bm25_hits_sync

    top_k = 5

    # ── Step 1: 向量检索 (mix 模式，直接用原始问题) ──────────────────────────
    print(f"\n{SUBDIV}")
    print(f"Step 1 / 向量检索（mode=mix，原始问题直接检索，top_k={top_k*2}）")
    print(f"  检索问题 : {QUESTION_TEXT}")
    t0 = time.perf_counter()
    vec_hits = list(course_retrieval_hits_sync(COURSE_ID, QUESTION_TEXT, mode="mix", top_k=top_k * 2))
    print(f"  → 命中 {len(vec_hits)} 块（耗时 {time.perf_counter()-t0:.1f}s）")
    for h in vec_hits:
        cid = h.get("chunk_id", "")
        score_raw = h.get('score', '?')
        try:
            score_str = f"{float(score_raw):.4f}"
        except (TypeError, ValueError):
            score_str = str(score_raw)
        print(f"      chunk_id={cid[:20]}  score={score_str}  "
              f"text_preview={str(h.get('text',''))[:60].replace(chr(10),' ')!r}")

    # ── Step 2: BM25 检索 ───────────────────────────────────────────────────
    print(f"\n{SUBDIV}")
    print(f"Step 2 / BM25 全文检索（top_k={top_k}）")
    t0 = time.perf_counter()
    try:
        bm25_hits = list(course_bm25_hits_sync(COURSE_ID, QUESTION_TEXT, top_k=top_k))
        print(f"  → 命中 {len(bm25_hits)} 块（耗时 {time.perf_counter()-t0:.1f}s）")
        for h in bm25_hits:
            cid = h.get("chunk_id", "")
            print(f"      chunk_id={cid[:20]}  score={h.get('score','?')}  "
                  f"text_preview={str(h.get('text',''))[:60].replace(chr(10),' ')!r}")
    except Exception as e:
        bm25_hits = []
        print(f"  BM25 失败: {e}")

    # ── Step 3: RRF 融合 ─────────────────────────────────────────────────────
    print(f"\n{SUBDIV}")
    print(f"Step 3 / RRF 融合排序（取 top_k={top_k}）")
    merged = _rrf_merge(vec_hits, bm25_hits, k=60, top_k=top_k)
    print(f"  融合后取 top-{top_k}，共 {len(merged)} 块：")
    for i, h in enumerate(merged):
        cid = h.get("chunk_id", "")
        print(f"    #{i+1}  chunk_id={cid[:20]}  text_preview={str(h.get('text',''))[:60].replace(chr(10),' ')!r}")

    chunk_texts = [h["text"] for h in merged if h.get("text", "").strip()]

    # ── Step 4: 展示最终检索块 ──────────────────────────────────────────────
    print(f"\n{SUBDIV}")
    print("Step 4 / 最终传入 LLM 的检索块（完整内容）")
    if chunk_texts:
        for i, ctx in enumerate(chunk_texts):
            print_chunk(i, ctx, label=f"mix #{i+1}")
    else:
        print("  （无检索结果）")

    # ── Step 5: LLM 合成 ────────────────────────────────────────────────────
    llm = _make_llm()
    print(f"\n{SUBDIV}")
    print("Step 5 / LLM 合成回答")
    from langchain_core.messages import HumanMessage, SystemMessage
    context_block = "\n\n".join(f"[{i+1}] {t.strip()}" for i, t in enumerate(chunk_texts)) \
        if chunk_texts else "（未检索到相关内容）"
    messages = [
        SystemMessage(content=(
            "根据提供的上下文简洁回答问题，使用与问题相同的语言作答。"
            "若上下文不足以支撑回答，直接回答 \"I don't know\"，不要编造内容。"
        )),
        HumanMessage(content=f"上下文：\n{context_block}\n\n问题：{QUESTION_TEXT}"),
    ]
    t0 = time.perf_counter()
    response = llm.invoke(messages)
    answer = str(response.content).strip()
    print(f"  （耗时 {time.perf_counter()-t0:.1f}s）\n")
    print(f"  【Mix 最终回答】")
    for line in answer.splitlines():
        print(f"  {line}")

    return answer, chunk_texts


# ─── Part 2: Agentic 模式 (SSE) ──────────────────────────────────────────────

def run_agentic_verbose() -> tuple[str, list[str], list[dict]]:
    import httpx

    banner("Part 2 — Agentic 模式（ReAct + 多轮工具调用）详细日志")
    print(f"\n问题 (QID {QUESTION_ID})：{QUESTION_TEXT}")
    print(f"\n{SUBDIV}")
    print("向 Next.js Chat 端点发送请求，逐条打印所有 SSE 事件…\n")

    jwt = make_eval_jwt()
    message = (
        f"{QUESTION_TEXT}\n\n"
        "直接输出最终答案，不需要解释过程或额外信息。"
        "若检索到的上下文不足以支撑回答，直接回答 \"I don't know\"，不要编造内容。\n\n"
        "`mode` 参数控制检索范围，根据问题特点自行选择最合适的模式：\n\n"
        "| 问题类型 | 推荐 mode | 原因 |\n"
        "|---|---|---|\n"
        "| 事实定义、参数查询 | `naive` | 纯向量，速度快，精度高 |\n"
        "| 概念关系、跨章节综合 | `mix` | 向量 + 知识图谱，覆盖更广 |\n"
        "| 不确定时 | `hybrid`（默认） | 自动平衡 |"
    )

    url = f"{BASE_URL.rstrip('/')}/api/v1/courses/{COURSE_ID}/chat"

    answer_parts: list[str] = []
    contexts: list[str] = []
    tool_calls: list[dict] = []

    tool_call_count = 0
    citation_count  = 0

    timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)
    t0 = time.perf_counter()

    with httpx.stream(
        "POST",
        url,
        json={
            "message": message,
            "eval_mode": True,
            "trim_history_to": 0,
        },
        headers={
            "Cookie": f"edu_access={jwt}",
            "Accept": "text/event-stream",
        },
        timeout=timeout,
    ) as response:
        response.raise_for_status()

        for raw_line in response.iter_lines():
            line = raw_line.strip()
            if not line:
                continue
            if line == "data: [DONE]":
                print("\n  [SSE] ← DONE")
                break
            if not line.startswith("data: "):
                continue

            payload_str = line[len("data: "):]
            try:
                event = json.loads(payload_str)
            except json.JSONDecodeError:
                print(f"  [非JSON行]: {line[:80]}")
                continue

            etype = event.get("type")

            if etype == "text":
                content = event.get("content", "")
                if content:
                    answer_parts.append(content)
                    # Print token-by-token in a compact way
                    print(content, end="", flush=True)

            elif etype == "tool_call":
                answer_parts.clear()  # 清空工具调用前的推理文本（最终答案才是有效回答）
                tool_call_count += 1
                name  = event.get("name", "")
                inp   = event.get("input")
                tool_calls.append({"name": name, "input": inp})

                print(f"\n\n  ┌── [工具调用 #{tool_call_count}] {name}")
                if isinstance(inp, dict):
                    for k, v in inp.items():
                        vstr = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
                        wrapped = textwrap.wrap(vstr, width=70, subsequent_indent="  │      ")
                        print(f"  │   {k}: {wrapped[0] if wrapped else ''}")
                        for extra in wrapped[1:]:
                            print(extra)
                else:
                    print(f"  │   input: {json.dumps(inp, ensure_ascii=False)}")
                print("  └──")
                print("\n  [Agent 正在思考/检索，等待结果…]")

            elif etype == "citation":
                citation_count += 1
                chunk_text = event.get("eval_text") or event.get("chunk_text", "")
                chunk_id   = event.get("chunk_id", "")
                source     = event.get("source_label") or event.get("source", "")

                if chunk_text and "Image Content" not in chunk_text and "Image Path" not in chunk_text:
                    if chunk_text not in contexts:
                        contexts.append(chunk_text)

                print(f"\n  ┌── [Citation #{citation_count}] chunk_id={chunk_id}  source={source}")
                preview = chunk_text[:300].replace("\n", " ")
                for ln in textwrap.wrap(preview, width=72, initial_indent="  │  ", subsequent_indent="  │  "):
                    print(ln)
                if len(chunk_text) > 300:
                    print("  │  … (截断)")
                print("  └──")

            elif etype == "done":
                err = event.get("error")
                if err:
                    print(f"\n  [SSE done] 错误: {err}")
                break

            elif etype == "thinking":
                thinking = event.get("content", "")
                print(f"\n  [Agent 思考链]: {thinking[:200]}")

    elapsed = time.perf_counter() - t0
    final_answer = "".join(answer_parts).strip()

    print(f"\n\n{SUBDIV}")
    print(f"【Agentic 汇总】耗时={elapsed:.1f}s  工具调用={tool_call_count}次  引用块={citation_count}个  最终上下文={len(contexts)}块")

    print(f"\n{'─'*40}")
    print("【Agentic 最终传入 LLM 的检索块】")
    if contexts:
        for i, ctx in enumerate(contexts):
            print_chunk(i, ctx)
    else:
        print("  （无检索结果）")

    print(f"\n{'─'*40}")
    print(f"【Agentic 最终回答】\n")
    # Final answer may have been printed char-by-char; reprint cleanly
    print(textwrap.fill(final_answer, width=80, initial_indent="  ", subsequent_indent="  "))

    return final_answer, contexts, tool_calls


# ─── Part 3: 对比摘要 ─────────────────────────────────────────────────────────

def print_comparison(
    mix_answer: str, mix_contexts: list[str],
    agentic_answer: str, agentic_contexts: list[str], agentic_tool_calls: list[dict],
) -> None:
    banner("Part 3 — 对比摘要")

    print(f"\n  QID {QUESTION_ID}：{QUESTION_TEXT}")
    print(f"\n  标准答案：{GOLD_ANSWER}")

    print(f"\n{'─'*40}")
    print(f"  Mix 检索到的块数    : {len(mix_contexts)}")
    print(f"  Agentic 检索到的块数: {len(agentic_contexts)}")
    print(f"  Agentic 工具调用次数: {len(agentic_tool_calls)}")

    print(f"\n{'─'*40}")
    print("  Mix 回答（前 300 字）：")
    print(textwrap.fill(mix_answer[:300], width=76, initial_indent="    ", subsequent_indent="    "))

    print(f"\n  Agentic 回答（前 300 字）：")
    print(textwrap.fill(agentic_answer[:300], width=76, initial_indent="    ", subsequent_indent="    "))

    print(f"\n{'─'*40}")
    print("  评估结果（来自历史 RAGAS 评测）：")
    print("    Mix:     llm_judge_correctness = 0.50,  context_recall = 0.00")
    print("    Agentic: llm_judge_correctness = 1.00,  context_recall = 1.00")
    print(f"\n{DIVIDER}\n")


# ─── 入口 ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'#'*80}")
    print("#  QID 17 — 协议分层异构性 + 协议设计目的  —  Mix vs Agentic 详细重测")
    print(f"#{'─'*78}#")
    print(f"#  基础 URL : {BASE_URL}")
    print(f"#  Course   : {COURSE_ID}")
    print(f"{'#'*80}\n")

    # 初始化 DB（确保 eval 用户和课程存在）
    print("[初始化] 确保 eval 学生和课程注册存在…")
    setup_eval_db()
    ensure_course_enrollment(COURSE_ID)

    # ── 1. Agentic（先跑，失败时不浪费 Mix 的 token）────────────────────────
    agentic_answer, agentic_contexts, agentic_tool_calls = run_agentic_verbose()

    # ── 2. Mix ──────────────────────────────────────────────────────────────
    mix_answer, mix_contexts = run_mix_verbose()

    # ── 3. 对比 ─────────────────────────────────────────────────────────────
    print_comparison(mix_answer, mix_contexts, agentic_answer, agentic_contexts, agentic_tool_calls)
