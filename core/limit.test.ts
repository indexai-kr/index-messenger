import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pLimit } from "./p-limit.ts";

describe("pLimit", () => {
  it("caps concurrency and preserves input order", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const task = (id: number, ms: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return id;
    };
    const out = await Promise.all([
      limit(task(0, 30)),
      limit(task(1, 10)),
      limit(task(2, 10)),
      limit(task(3, 10)),
    ]);
    assert.deepEqual(out, [0, 1, 2, 3]);
    assert.ok(peak <= 2, `peak ${peak} exceeds cap`);
  });

  it("floors invalid caps to 1 and propagates errors", async () => {
    const limit = pLimit(0);
    assert.equal(await limit(async () => "ok"), "ok");
    await assert.rejects(() => limit(async () => {
      throw new Error("boom");
    }), /boom/);
  });
});
