import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "@/lib/agent/types";

const {
  getMock,
  setMock,
  delMock,
  evalMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
  delMock: vi.fn(),
  evalMock: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(async () => ({
    get: getMock,
    set: setMock,
    del: delMock,
    eval: evalMock,
  })),
}));

import { SessionStore } from "@/lib/agent/session-store";

describe("SessionStore", () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    delMock.mockReset();
    evalMock.mockReset();
  });

  it("业务规则：会话不存在时读取历史应返回空数组", async () => {
    // given
    getMock.mockResolvedValueOnce(null);
    const store = new SessionStore();

    // when
    const history = await store.get("sess-missing");

    // then
    expect(history).toEqual([]);
  });

  it("业务规则：Redis 中坏 JSON 不应污染历史，应回退为空数组", async () => {
    // given
    getMock.mockResolvedValueOnce("{bad-json");
    const store = new SessionStore();

    // when
    const history = await store.get("sess-corrupt");

    // then
    expect(history).toEqual([]);
  });

  it("业务规则：append 应保留原顺序并写入 24h TTL", async () => {
    // given
    const incoming: Message[] = [{ role: "assistant", content: "A1" }];
    evalMock.mockResolvedValueOnce(2);
    const store = new SessionStore();

    // when
    await store.append("sess-1", incoming);

    // then
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET'"),
      {
        keys: ["agent:session:sess-1"],
        arguments: [JSON.stringify(incoming), String(24 * 60 * 60)],
      },
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("业务规则：reset 应删除对应会话键", async () => {
    // given
    const store = new SessionStore();

    // when
    await store.reset("sess-to-delete");

    // then
    expect(delMock).toHaveBeenCalledWith("agent:session:sess-to-delete");
  });
});
