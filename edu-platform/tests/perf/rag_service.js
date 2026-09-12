/**
 * RAG 服务专项测试 (rag_service.js)
 *
 * 目标：单独测试 Python RAG 微服务（port 8001）在并发下的表现。
 * RAG 查询是整个聊天链路中最慢的环节（向量检索 + LLM）。
 *
 * 运行命令 (在 edu-platform 目录下):
 *   k6 run tests/perf/rag_service.js
 *
 * 保存结果:
 *   k6 run --out json=output/perf/rag.json --summary-export output/perf/rag_summary.json tests/perf/rag_service.js
 *
 * 需要 RAG 服务正在运行: cd edu-platform && docker-compose up rag-service -d
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { RAG_URL, COURSE_ID } from './utils.js';

const RAG_API_KEY = __ENV.RAG_SERVICE_API_KEY || '';

const ragQueryDuration = new Trend('rag_query_duration', true);
const ragErrors        = new Counter('rag_errors');
const ragQueries       = new Counter('rag_queries_total');
const ragSuccess       = new Rate('rag_query_success_rate');
const ragEmpty         = new Rate('rag_empty_result_rate');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  stages: [
    { duration: '1m', target: 3  },
    { duration: '3m', target: 3  },
    { duration: '1m', target: 8  },
    { duration: '3m', target: 8  },
    { duration: '2m', target: 0  },
  ],
  thresholds: {
    rag_query_duration:    ['p(90)<15000', 'p(95)<25000'],
    rag_errors:            ['count<5'],
    rag_query_success_rate: ['rate>0.95'],
    'http_req_failed{endpoint:query}': ['rate<0.05'],
  },
};

const RAG_QUERIES = [
  'TCP 三次握手的过程是什么？',
  '解释 HTTP 状态码 404 和 500 的区别',
  '什么是网络地址转换 NAT？',
  '请描述 DNS 解析的完整流程',
  '什么是 HTTPS 的 TLS 握手过程？',
];

const RAG_HEADERS = {
  'Content-Type':  'application/json',
  'X-Internal-Key': RAG_API_KEY,
};

export default function () {
  const query = RAG_QUERIES[Math.floor(Math.random() * RAG_QUERIES.length)];

  // ── /health 探活 ─────────────────────────────────────────────────────────
  const healthRes = http.get(`${RAG_URL}/health`, {
    headers: RAG_HEADERS,
    tags: { endpoint: 'health' },
  });
  check(healthRes, { 'rag /health 200': (r) => r.status === 200 });

  sleep(0.2);

  // ── /rag/query (hybrid mode) ──────────────────────────────────────────────
  const t0 = Date.now();
  const queryRes = http.post(
    `${RAG_URL}/rag/query`,
    JSON.stringify({
      source:     'course',
      user_id:    `perf-vu-${__VU}`,
      course_id:  COURSE_ID,
      question:   query,
      top_k:      5,
    }),
    {
      headers: RAG_HEADERS,
      timeout: '60s',
      tags: { endpoint: 'query' },
    },
  );
  ragQueryDuration.add(Date.now() - t0);
  ragQueries.add(1);

  let hasChunks = false;
  try {
    const body = queryRes.json();
    hasChunks = Array.isArray(body.hits) && body.hits.length > 0;
  } catch { /* recorded as an empty result below */ }

  const ok = check(queryRes, {
    'rag query 200': (r) => r.status === 200,
    'rag has hits': () => hasChunks,
  });
  ragSuccess.add(ok);
  ragEmpty.add(!hasChunks);

  if (!ok) {
    ragErrors.add(1);
    console.warn(`RAG query failed [${queryRes.status}]: ${queryRes.body?.slice(0, 200)}`);
  }

  sleep(1);
}
