import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.ts";

describe("ledger", () => {
  it("preserves source/translation pairs as JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    try {
      const ledger = new Ledger(join(dir, "ledger.jsonl"));
      await ledger.append({
        ts: 1,
        direction: "in",
        channel: "telegram",
        messageId: "telegram:1",
        lang: "ja",
        body: "こんにちは",
      });
      await ledger.append({
        ts: 2,
        direction: "out",
        channel: "hub",
        messageId: "telegram:1->hub",
        lang: "ko",
        body: "안녕하세요",
        translatedLang: "ko",
        translatedBody: "안녕하세요",
      });
      const all = await ledger.readAll();
      assert.equal(all.length, 2);
      assert.equal(all[0]?.body, "こんにちは");
      assert.equal(all[1]?.translatedBody, "안녕하세요");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
