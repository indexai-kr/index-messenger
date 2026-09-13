import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.ts";

// issues #2: first poll may hit a not-yet-ready proxy. One retry, then stop.
describe("hub api retry", () => {
  it("succeeds after one failed first attempt (exactly 2 calls)", async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("proxy not ready");
      return new Response(JSON.stringify([{ ts: 1 }]), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await api.ledger();
      assert.deepEqual(out, [{ ts: 1 }]);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("throws after two failures (no infinite retry)", async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("down");
    }) as typeof fetch;
    try {
      await assert.rejects(() => api.ledger(), /down/);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
