import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, inspect } from "./gate.ts";

const ko = async (t: string) => `KO<${t}>`;

describe("gate patterns", () => {
  it("passes everyday chatter", async () => {
    assert.deepEqual(inspect("오늘 점심 뭐 먹지?"), []);
    const d = await decide("오늘 점심 뭐 먹지?", "ko", "ko", ko);
    assert.equal(d.verdict, "pass");
  });

  it("holds amounts, times and dates", async () => {
    for (const text of ["내일 3시에 5만엔 보내줘", "2026-10-01까지 120,000원"]) {
      const d = await decide(text, "ko", "ko", ko);
      assert.equal(d.verdict, "hold");
      assert.ok(d.matched.length > 0);
      assert.ok(d.backTranslation.length > 0);
    }
  });
});
