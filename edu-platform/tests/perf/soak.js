/**
 * Phase 4 — 稳定性测试 (Soak)
 *
 * 目标：低并发持续 30 分钟，检测:
 *   - 内存泄漏（响应时间随时间增长）
 *   - 连接池耗尽（错误率随时间上升）
 *   - 日志积压 / Redis 内存溢出
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/soak.js
 *
 * 保存结果:
 *   k6 run --out json=output/perf/soak.json --summary-export output/perf/soak_summary.json tests/perf/soak.js
 *
 * 测试时长约 40 分钟，建议在非工作时间运行。
 * 配合 Grafana (http://localhost:3300) 监控服务资源。
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';
import { login, authHeaders, BASE_URL, COURSE_ID, vuUser, randomQuestion } from './utils.js';

// 自定义趋势：追踪随时间变化的延迟（用于检测内存泄漏导致的性能退化）
const authLatency    = new Trend('soak_auth_duration');
const browseLatency  = new Trend('soak_browse_duration');
const chatLatency    = new Trend('soak_chat_duration');

export const options = {
  stages: [
    { duration: '3m',  target: 8  },  // 热身爬升
    { duration: '30m', target: 8  },  // 核心：保持 8 VUs 运行 30 分钟
    { duration: '5m',  target: 0  },  // 冷却
  ],
  thresholds: {
    // 30 分钟内响应时间不应持续升高（绝对值要求）
    soak_auth_duration:   ['p(95)<3000'],
    soak_browse_duration: ['p(95)<2000'],
    soak_chat_duration:   ['p(95)<60000'],
    http_req_failed:      ['rate<0.02'],
    // 错误数阈值（30min 内不能超过 20 次错误）
    http_req_failed:      ['count<20'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= 30; i++) {
    const username = `mock_student_${String(i).padStart(2, '0')}`;
    const s = login(username, 'MockStudent@2026');
    if (s) tokens.push(s.token);
  }
  console.log(`[soak setup] ${tokens.length} sessions ready`);
  return { tokens };
}

export default function (data) {
  const token = data?.tokens?.[(__VU - 1) % (data.tokens.length || 1)];
  if (!token) return;
  const hdrs = authHeaders(token);

  // ── 轮流执行三种操作，模拟真实学习行为 ───────────────────────────────────
  const iteration = __ITER % 3;

  if (iteration === 0) {
    // 操作 A: 认证刷新（模拟页面跳转重新验证）
    group('auth-check', () => {
      const t0 = Date.now();
      const r = http.get(`${BASE_URL}/api/v1/user`, { headers: hdrs });
      authLatency.add(Date.now() - t0);
      check(r, { 'GET /user 200': (r) => r.status === 200 });
    });
    sleep(1);

  } else if (iteration === 1) {
    // 操作 B: 浏览课程（轻量读操作）
    group('browse', () => {
      const t0 = Date.now();
      const r1 = http.get(`${BASE_URL}/api/v1/courses`, { headers: hdrs });
      check(r1, { 'courses list 200': (r) => r.status === 200 });

      const r2 = http.get(`${BASE_URL}/api/v1/courses/${COURSE_ID}`, { headers: hdrs });
      check(r2, { 'course detail 200': (r) => r.status === 200 });
      browseLatency.add(Date.now() - t0);
    });
    sleep(2);

  } else {
    // 操作 C: 发送聊天消息（重量操作，LLM + RAG）
    group('chat', () => {
      const t0 = Date.now();
      const r = http.post(
        `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat`,
        JSON.stringify({ message: randomQuestion() }),
        {
          headers: { ...hdrs, Accept: 'text/event-stream' },
          timeout: '120s',
        },
      );
      chatLatency.add(Date.now() - t0);
      check(r, {
        'chat 200': (r) => r.status === 200,
        'chat has body': (r) => (r.body?.length ?? 0) > 0,
      });
    });
    sleep(3);
  }
}
