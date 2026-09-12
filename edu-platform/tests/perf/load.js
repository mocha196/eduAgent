/**
 * Phase 2 — 负载测试 (Load)
 *
 * 目标：阶梯式加压，测量 10 / 20 / 30 个并发用户下的响应时间变化。
 * 每个 VU 模拟一个真实学生：登录 → 浏览课程 → 发送聊天消息 → 查看历史。
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/load.js
 *
 * 保存结果:
 *   k6 run --out json=output/perf/load.json --summary-export output/perf/load_summary.json tests/perf/load.js
 *
 * 测试时长约 22 分钟，适合在有基线数据后运行。
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { login, authHeaders, BASE_URL, COURSE_ID, MOCK_USERS, vuUser, randomQuestion } from './utils.js';

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  stages: [
    { duration: '2m',  target: 5  },  // 热身: 爬升到 5 VUs
    { duration: '3m',  target: 5  },  // 保持 5 VUs
    { duration: '2m',  target: 15 },  // 爬升到 15 VUs
    { duration: '3m',  target: 15 },  // 保持 15 VUs
    { duration: '2m',  target: 30 },  // 爬升到 30 VUs
    { duration: '5m',  target: 30 },  // 保持 30 VUs（主压力段）
    { duration: '3m',  target: 0  },  // 冷却
  ],
  thresholds: {
    'http_req_duration{type:auth}':    ['p(90)<2000',  'p(95)<3000'],
    'http_req_duration{type:courses}': ['p(90)<1500',  'p(95)<2500'],
    'http_req_duration{type:chat}':    ['p(90)<45000', 'p(95)<60000'],
    http_req_failed:                   ['rate<0.05'],
  },
};

// setup() 在所有 VU 开始前运行一次，结果共享给每个 VU 的 default 函数
export function setup() {
  // 预登录 30 个账号，返回 token 数组；VU 按索引取用
  const sessions = [];
  for (const u of MOCK_USERS) {
    const s = login(u.username, u.password);
    if (s) sessions.push(s.token);
  }
  console.log(`[setup] Pre-logged ${sessions.length} sessions`);
  return { tokens: sessions };
}

export default function (data) {
  // 每个 VU 取对应 token；若 setup 未提供则临时登录
  let token = data?.tokens?.[(__VU - 1) % (data.tokens.length || 1)];
  if (!token) {
    const u = vuUser();
    const s = login(u.username, u.password);
    if (!s) return;
    token = s.token;
  }
  const hdrs = authHeaders(token);

  // ── 1. 浏览课程列表 ──────────────────────────────────────────────────────
  group('browse', () => {
    const r = http.get(`${BASE_URL}/api/v1/courses`, {
      headers: hdrs,
      tags: { type: 'courses' },
    });
    if (r.status !== 200) console.log(`[courses] VU${__VU} status=${r.status} body=${r.body?.slice(0,120)}`);
    check(r, { 'courses 200': (r) => r.status === 200 });
    sleep(0.5);

    const r2 = http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}`, {
      headers: hdrs,
      tags: { type: 'courses' },
    });
    check(r2, { 'course detail 200': (r) => r.status === 200 });
    sleep(0.5);
  });

  // ── 2. 发送聊天消息（SSE 流） ─────────────────────────────────────────────
  group('chat', () => {
    const chatRes = http.post(
      `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat`,
      JSON.stringify({ message: randomQuestion() }),
      {
        headers: { ...hdrs, Accept: 'text/event-stream' },
        tags:    { type: 'chat' },
        timeout: '90s',
      },
    );
    check(chatRes, {
      'chat 200': (r) => r.status === 200,
      'chat non-empty': (r) => (r.body?.length ?? 0) > 10,
    });
  });

  // ── 3. 查看聊天历史 ───────────────────────────────────────────────────────
  group('history', () => {
    const hRes = http.get(
      `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat/history`,
      { headers: hdrs, tags: { type: 'courses' } },
    );
    check(hRes, { 'history 200': (r) => [200, 404].includes(r.status) });
    sleep(0.3);
  });

  sleep(1); // 模拟用户思考间隔
}
