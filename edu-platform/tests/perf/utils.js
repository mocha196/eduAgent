/**
 * 共享工具函数
 * 所有 k6 性能测试脚本均从此处导入
 */
import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const RAG_URL  = __ENV.RAG_URL || 'http://localhost:8001';

// 测试用账号（由 prisma/seed-mock-students.ts 创建）
// 用法: MOCK_USERS[__VU % MOCK_USERS.length]
export const MOCK_USERS = Array.from({ length: 30 }, (_, i) => ({
  username: `mock_student_${String(i + 1).padStart(2, '0')}`,
  password: 'MockStudent@2026',
}));

// 目标课程 ID（mock 学生已加入该课程）
// 计算机网络基础 — 含最多已索引材料，适合聊天测试
export const COURSE_ID = __ENV.COURSE_ID || 'c8b8787f-9c7e-4f37-bab5-fb94a438d9cf';

/**
 * 登录并返回 { token, refresh_token, userId }
 * 若登录失败则 check 失败，返回 null。
 */
export function login(username, password) {
  const res = http.post(
    `${BASE_URL}/api/v1/login`,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const ok = check(res, {
    'login 200': (r) => r.status === 200,
    'login has token': (r) => {
      try { return !!r.json('token'); } catch { return false; }
    },
  });

  if (!ok) return null;

  const body = res.json();
  return {
    token:         body.token,
    refresh_token: body.refresh_token,
    userId:        body.user?.id,
  };
}

/** 返回带 Authorization 和 Content-Type 的 headers 对象 */
export function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

/** 当前 VU 对应的 mock 用户（轮转） */
export function vuUser() {
  return MOCK_USERS[(__VU - 1) % MOCK_USERS.length];
}

/** 简单的随机聊天问题集（避免 LLM 缓存命中） */
export const CHAT_QUESTIONS = [
  '什么是 TCP 三次握手？',
  '请解释 HTTP 和 HTTPS 的区别。',
  '什么是 DNS？它的工作原理是什么？',
  'UDP 和 TCP 有什么主要区别？',
  '什么是网络层的主要功能？',
  '请解释 IP 地址和子网掩码的关系。',
  '什么是 ARP 协议？',
  '请简述应用层协议的作用。',
  '什么是路由器，它如何工作？',
  '请解释什么是拥塞控制。',
];

export function randomQuestion() {
  return CHAT_QUESTIONS[Math.floor(Math.random() * CHAT_QUESTIONS.length)];
}
