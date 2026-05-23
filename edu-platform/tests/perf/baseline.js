/**
 * Phase 1 — 基线测试 (Baseline)
 *
 * 目标：以 1 个虚拟用户跑 60s，确认单用户正常响应时间，建立性能基准。
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/baseline.js
 *
 * 保存结果到文件:
 *   k6 run --out json=output/perf/baseline.json --summary-export output/perf/baseline_summary.json tests/perf/baseline.js
 *
 * 重点关注结果中:
 *   - http_req_duration (avg / p95 / p99)
 *   - http_req_failed
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { login, authHeaders, BASE_URL, COURSE_ID, MOCK_USERS } from './utils.js';

export const options = {
  vus:      1,
  duration: '60s',
  thresholds: {
    // 单用户下 95% 请求必须在 2s 内完成
    'http_req_duration{type:auth}':    ['p(95)<2000'],
    'http_req_duration{type:courses}': ['p(95)<1000'],
    'http_req_duration{type:chat}':    ['p(95)<30000'],  // SSE 总时长允许更长
    // TTFT（首字节时间）≤ 2s：http_req_waiting = 从发送请求到收到第一个字节
    // 对 SSE 流式接口即等价于首 token 时延
    'http_req_waiting{type:chat}':     ['p(95)<2000'],
    http_req_failed:                   ['rate<0.01'],
  },
};

export default function () {
  const user = MOCK_USERS[0]; // 基线始终用第一个账号

  // ── Step 1: 登录 ────────────────────────────────────────────────────────────
  const session = login(user.username, user.password);
  if (!session) return;

  const hdrs = authHeaders(session.token);

  // ── Step 2: 获取课程列表 ───────────────────────────────────────────────────
  const coursesRes = http.get(`${BASE_URL}/api/v1/courses`, {
    headers: hdrs,
    tags: { type: 'courses' },
  });
  check(coursesRes, { 'GET courses 200': (r) => r.status === 200 });

  sleep(0.5);

  // ── Step 3: 获取课程详情 ───────────────────────────────────────────────────
  const courseRes = http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}`, {
    headers: hdrs,
    tags: { type: 'courses' },
  });
  check(courseRes, { 'GET course detail 200': (r) => r.status === 200 });

  sleep(0.5);

  // ── Step 4: 获取课程课时列表 ───────────────────────────────────────────────
  const lessonsRes = http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/lessons`, {
    headers: hdrs,
    tags: { type: 'courses' },
  });
  check(lessonsRes, { 'GET lessons 200': (r) => [200, 403].includes(lessonsRes.status) });

  sleep(0.5);

  // ── Step 5: 获取课程材料列表 ───────────────────────────────────────────────
  const materialsRes = http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}/materials`, {
    headers: hdrs,
    tags: { type: 'courses' },
  });
  check(materialsRes, { 'GET materials 200': (r) => [200, 403].includes(r.status) });

  sleep(0.5);

  // ── Step 6: 发送一条聊天消息（SSE） ────────────────────────────────────────
  const chatRes = http.post(
    `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat`,
    JSON.stringify({ message: '什么是TCP三次握手？' }),
    {
      headers: { ...hdrs, Accept: 'text/event-stream' },
      tags:    { type: 'chat' },
      timeout: '60s',
    },
  );
  check(chatRes, {
    'POST chat 200': (r) => r.status === 200,
    'chat has content': (r) => (r.body?.length ?? 0) > 0,
  });

  sleep(1);
}
