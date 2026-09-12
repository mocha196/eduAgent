#!/usr/bin/env node
/** Convert k6 --summary-export JSON files into a paper-ready Markdown/JSON report. */
import fs from "node:fs";
import path from "node:path";

const inputs = process.argv.slice(2).filter((arg) => !arg.startsWith("--out="));
const outputArg = process.argv.find((arg) => arg.startsWith("--out="));
const output = outputArg?.slice("--out=".length) || "output/perf/metrics-report.md";

if (inputs.length === 0) {
  console.error("Usage: node tests/perf/summarize-results.mjs <summary.json>... [--out=report.md]");
  process.exit(1);
}

function value(metric, key) {
  // k6 1.x nested values under `values`; k6 2.x exports them directly.
  const raw = metric?.values?.[key] ?? metric?.[key] ?? (key === "rate" ? metric?.value : undefined);
  return Number.isFinite(raw) ? raw : null;
}

function fmt(number, digits = 2) {
  return number === null ? "-" : Number(number).toFixed(digits);
}

function fmtPercent(rate) {
  return rate === null ? "-" : `${fmt(rate * 100)}%`;
}

const rows = inputs.map((file) => {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const metrics = report.metrics || {};
  const latency = metrics.api_response_duration || metrics.chat_req_duration || metrics.rag_query_duration || metrics.http_req_duration;
  const requests = metrics.api_requests_total || metrics.chat_requests_total || metrics.rag_queries_total || metrics.http_reqs;
  const durationSeconds = Math.max(0.001, (report.state?.testRunDurationMs || 0) / 1000);
  const count = value(requests, "count");
  return {
    scenario: path.basename(file, path.extname(file)),
    concurrency: value(metrics.vus_max, "max") ?? value(metrics.vus, "max"),
    qps: value(requests, "rate") ?? (count === null ? null : count / durationSeconds),
    avgMs: value(latency, "avg"),
    p50Ms: value(latency, "med") ?? value(latency, "p(50)"),
    p90Ms: value(latency, "p(90)"),
    p95Ms: value(latency, "p(95)"),
    p99Ms: value(latency, "p(99)"),
    errorRate: value(metrics.http_req_failed, "rate"),
    apiSuccessRate: value(metrics.api_success_rate, "rate"),
    toolSuccessRate: value(metrics.tool_call_success_rate, "rate"),
    sampleCount: count,
  };
});

const lines = [
  "# 性能测试结果",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| 场景 | 最大并发 | QPS | avg(ms) | P50 | P90 | P95 | P99 | API成功率 | HTTP错误率 | 工具成功率 | 样本数 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((row) =>
    `| ${row.scenario} | ${fmt(row.concurrency, 0)} | ${fmt(row.qps)} | ${fmt(row.avgMs)} | ${fmt(row.p50Ms)} | ${fmt(row.p90Ms)} | ${fmt(row.p95Ms)} | ${fmt(row.p99Ms)} | ${fmtPercent(row.apiSuccessRate)} | ${fmtPercent(row.errorRate)} | ${fmtPercent(row.toolSuccessRate)} | ${fmt(row.sampleCount, 0)} |`,
  ),
  "",
  "> API 延迟为脚本标记的业务请求耗时，聊天延迟为完整 SSE 响应耗时，RAG 延迟为 /rag/query 请求耗时。所有百分比均应结合样本数解释。",
  "",
];
const markdown = lines.join("\n");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, markdown, "utf8");
fs.writeFileSync(output.replace(/\.md$/i, ".json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), "utf8");
console.log(markdown);
