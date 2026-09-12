/**
 * 不依赖外部大模型的 Web/API 并发实测。
 *
 * 示例：
 *   k6 run -e VUS=10 -e DURATION=60s \
 *     --summary-export output/perf/api_10_summary.json \
 *     tests/perf/api_concurrent.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  authHeaders,
  BASE_URL,
  COURSE_ID,
  login,
  MOCK_USERS,
} from './utils.js';

const configuredVus = Number.parseInt(__ENV.VUS || '10', 10);
const configuredDuration = __ENV.DURATION || '60s';

if (configuredVus > MOCK_USERS.length) {
  throw new Error(`VUS cannot exceed the ${MOCK_USERS.length} available test accounts`);
}

const apiRequests = new Counter('api_requests_total');
const apiSuccess = new Rate('api_success_rate');
const apiDuration = new Trend('api_response_duration', true);

export const options = {
  vus: configuredVus,
  duration: configuredDuration,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    api_success_rate: ['rate>0.99'],
    api_response_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

let token;

function request(name, url, headers) {
  const response = http.get(url, {
    headers,
    tags: { endpoint: name, workload: 'api' },
  });
  const ok = check(response, {
    [`${name} returns 200`]: (result) => result.status === 200,
  });

  apiRequests.add(1, { endpoint: name });
  apiSuccess.add(ok, { endpoint: name });
  apiDuration.add(response.timings.duration, { endpoint: name });
}

export default function () {
  if (!token) {
    const user = MOCK_USERS[(__VU - 1) % MOCK_USERS.length];
    const session = login(user.username, user.password);
    if (!session) return;
    token = session.token;
  }

  const headers = authHeaders(token);

  request('courses', `${BASE_URL}/api/v1/courses`, headers);
  request('course_detail', `${BASE_URL}/api/v1/courses/${COURSE_ID}`, headers);
  request('lessons', `${BASE_URL}/api/v1/courses/${COURSE_ID}/lessons`, headers);
  request('materials', `${BASE_URL}/api/v1/courses/${COURSE_ID}/materials`, headers);
  request('chat_history', `${BASE_URL}/api/v1/courses/${COURSE_ID}/chat/history`, headers);

  sleep(0.2);
}
