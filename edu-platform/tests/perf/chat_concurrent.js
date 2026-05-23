/**
 * Phase 3 — 并发聊天测试 (Chat Concurrency)
 *
 * 目标：专门测试 SSE 流式聊天接口在高并发下的表现。
 * 聊天是系统最重的操作（LLM 调用 + RAG 检索），需要单独测试。
 *
 * 测试两个场景:
 *   scenario_light:  10 VUs 并发，持续 5 分钟（模拟正常课堂）
 *   scenario_heavy:  20 VUs 并发，持续 3 分钟（模拟考试高峰）
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/chat_concurrent.js
 *
 * 保存结果:
 *   k6 run --out json=output/perf/chat.json --summary-export output/perf/chat_summary.json tests/perf/chat_concurrent.js
 *
 * 关键指标: chat_req_duration (p95 < 60s), chat_error_rate (< 2%)
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { login, authHeaders, BASE_URL, COURSE_ID, vuUser, randomQuestion } from './utils.js';

// 自定义指标：单独追踪聊天接口
const chatDuration  = new Trend('chat_req_duration',  true);
const chatErrors    = new Counter('chat_errors');
const chatSuccesses = new Counter('chat_successes');

export const options = {
  scenarios: {
    // 场景 A：轻量并发（正常使用）
    scenario_light: {
      executor:          'constant-vus',
      vus:               10,
      duration:          '5m',
      gracefulStop:      '30s',
      tags:              { scenario: 'light' },
    },
    // 场景 B：重量并发（高峰期），在 A 结束后开始
    scenario_heavy: {
      executor:          'constant-vus',
      vus:               20,
      duration:          '3m',
      startTime:         '5m30s',  // A 结束 + 30s 冷却后开始
      gracefulStop:      '30s',
      tags:              { scenario: 'heavy' },
    },
  },
  thresholds: {
    chat_req_duration:                 ['p(95)<60000'],  // 95% 聊天请求 60s 内完成
    'chat_req_duration{scenario:light}': ['p(95)<45000'],
    'chat_req_duration{scenario:heavy}': ['p(95)<60000'],
    chat_errors:                       ['count<10'],     // 允许少量错误
    http_req_failed:                   ['rate<0.05'],
  },
};

export function setup() {
  // 预登录所有 30 个 mock 账号
  const tokens = [];
  const users = Array.from({ length: 30 }, (_, i) => ({
    username: `mock_student_${String(i + 1).padStart(2, '0')}`,
    password: 'MockStudent@2026',
  }));
  for (const u of users) {
    const s = login(u.username, u.password);
    if (s) tokens.push(s.token);
  }
  console.log(`[setup] Pre-logged ${tokens.length}/30 sessions`);
  return { tokens };
}

export default function (data) {
  const token = data?.tokens?.[(__VU - 1) % (data.tokens.length || 1)];
  if (!token) {
    console.error(`VU ${__VU}: no token available`);
    return;
  }

  const start   = Date.now();
  const question = randomQuestion();

  const res = http.post(
    `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat`,
    JSON.stringify({ message: question }),
    {
      headers: {
        ...authHeaders(token),
        'Accept': 'text/event-stream',
      },
      timeout: '120s',
      tags: { type: 'chat' },
    },
  );

  const elapsed = Date.now() - start;
  chatDuration.add(elapsed);

  const ok = check(res, {
    'chat status 200': (r) => r.status === 200,
    'chat body non-empty': (r) => (r.body?.length ?? 0) > 20,
    'chat no error event': (r) => !r.body?.includes('"type":"error"'),
  });

  if (ok) {
    chatSuccesses.add(1);
  } else {
    chatErrors.add(1);
    console.warn(`VU ${__VU}: chat failed [${res.status}] q="${question.slice(0, 30)}"`);
  }

  // 模拟用户阅读回答（2~5 秒）
  const thinkTime = 2 + Math.random() * 3;
  // sleep(thinkTime);  // 取消注释以模拟更真实的用户行为（会降低实际并发压力）
}
