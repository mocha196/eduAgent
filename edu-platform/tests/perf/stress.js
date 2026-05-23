/**
 * Phase 5 — 压力/破坏性测试 (Stress & Spike)
 *
 * 目标：找到系统承受极限，验证在超载时能否:
 *   1. 返回有意义的错误（503/429），而非崩溃/挂起
 *   2. 恢复正常后响应时间回落（弹性）
 *
 * 两个子场景:
 *   stress_ramp  — 阶梯加压直到 80 VUs（找极限）
 *   spike        — 瞬间涌入 50 VUs（测抗突刺能力）
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/stress.js
 *
 * 保存结果:
 *   k6 run --out json=output/perf/stress.json --summary-export output/perf/stress_summary.json tests/perf/stress.js
 *
 * ⚠️  该测试会给系统造成较大压力，建议在开发/测试环境运行，
 *     并确保提前备份数据库。
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { login, authHeaders, BASE_URL, COURSE_ID, randomQuestion } from './utils.js';

const serverErrors  = new Counter('server_5xx_errors');
const rateLimitHits = new Counter('rate_limit_429');

export const options = {
  scenarios: {
    // 场景 1: 阶梯加压（找极限）
    stress_ramp: {
      executor: 'ramping-vus',
      stages: [
        { duration: '2m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '2m', target: 40 },
        { duration: '3m', target: 40 },
        { duration: '2m', target: 80 },
        { duration: '3m', target: 80 },
        { duration: '3m', target: 0  },  // 冷却观察恢复
      ],
      gracefulStop: '30s',
      tags: { scenario: 'stress_ramp' },
    },
    // 场景 2: 瞬间峰值（spike），在 stress_ramp 结束后运行
    spike: {
      executor: 'ramping-vus',
      startTime: '22m',
      stages: [
        { duration: '10s', target: 50 },  // 10 秒内涌入 50 用户
        { duration: '3m',  target: 50 },  // 保持 3 分钟
        { duration: '30s', target: 0  },  // 撤退
        { duration: '2m',  target: 0  },  // 观察恢复
      ],
      gracefulStop: '30s',
      tags: { scenario: 'spike' },
    },
  },
  thresholds: {
    // 压力测试放宽阈值，主要观察崩溃/错误，而非响应时间
    http_req_duration:  ['p(95)<90000'],
    http_req_failed:    ['rate<0.20'],   // 允许 20% 失败（超过则说明系统无法支撑）
    server_5xx_errors:  ['count<50'],    // 500 错误数不能过多
    rate_limit_429:     ['count<200'],   // 限流触发是正常保护行为
  },
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= 30; i++) {
    const username = `mock_student_${String(i).padStart(2, '0')}`;
    const s = login(username, 'MockStudent@2026');
    if (s) tokens.push(s.token);
  }
  console.log(`[stress setup] ${tokens.length} sessions ready`);
  return { tokens };
}

export default function (data) {
  const token = data?.tokens?.[(__VU - 1) % (data.tokens.length || 1)];
  if (!token) return;
  const hdrs = authHeaders(token);

  // 混合请求：70% 聊天（重），30% 浏览（轻）
  const roll = Math.random();

  if (roll < 0.70) {
    // 重操作: 聊天
    const r = http.post(
      `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat`,
      JSON.stringify({ message: randomQuestion() }),
      {
        headers: { ...hdrs, Accept: 'text/event-stream' },
        timeout: '120s',
        tags: { type: 'chat' },
      },
    );

    if (r.status >= 500) {
      serverErrors.add(1);
      console.error(`VU ${__VU} [chat] 5xx: ${r.status} ${r.body?.slice(0, 200)}`);
    } else if (r.status === 429) {
      rateLimitHits.add(1);
    }

    check(r, {
      'chat responded': (r) => [200, 429, 503].includes(r.status),
    });

  } else {
    // 轻操作: 浏览
    const r = http.get(`${BASE_URL}/api/v1/courses`, {
      headers: hdrs,
      tags: { type: 'courses' },
    });

    if (r.status >= 500) serverErrors.add(1);
    check(r, { 'courses responded': (r) => r.status < 600 });
    sleep(0.2);
  }
}
