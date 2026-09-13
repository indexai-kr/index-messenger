import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DiscordRunner, type RunnerConfig } from "./runner.ts";

// The runner against a scripted fetch: no core, no Discord, no network.
// Verifies the executor contract — send what /outbox serves, ack with the
// native id, never execute an id twice, cap the day, and hand inbound
// human messages (not bots) to /ingress.

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function script(routes: Record<string, (call: Call) => unknown>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) throw new Error(`unscripted ${url}`);
    return new Response(JSON.stringify(routes[key](call)), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: stub };
}

const cfg: RunnerConfig = {
  botToken: "t",
  channelId: "c",
  core: "http://core",
  pollSecs: 1,
  minGapSecs: 1,
  dailyCap: 2,
  backfill: true,
};

describe("discord runner", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends outbox items once, acks with the native id, and caps the day", async () => {
    let created = 0;
    const s = script({
      "/outbox?": () => ({
        items: [
          { messageId: "kakao:a->discord", body: "x", lang: "ko", ts: 1, origin: "relay" },
          { messageId: "hub:b->discord", body: "y", lang: "ko", ts: 2, origin: "hub" },
          { messageId: "hub:c->discord", body: "z", lang: "ko", ts: 3, origin: "hub" },
        ],
      }),
      "/channels/c/messages": () => ({ id: `d-${++created}` }),
      "/outbox/ack": () => ({ acked: true }),
    });
    globalThis.fetch = s.fetch;
    const runner = new DiscordRunner({ ...cfg, minGapSecs: 1 });
    const sent = await runner.outboundTick();
    assert.equal(sent, 2, "daily cap of 2 stops the third");
    const acks = s.calls.filter((c) => c.url.endsWith("/outbox/ack")).map((c) => c.body);
    assert.deepEqual(
      acks.map((a) => [a?.messageId, a?.ok, a?.nativeId ?? a?.error]),
      [
        ["kakao:a->discord", true, "d-1"],
        ["hub:b->discord", true, "d-2"],
        ["hub:c->discord", false, "daily-cap"],
      ],
    );
    // Second pass serves the same lines again: nothing is re-sent.
    const again = await runner.outboundTick();
    assert.equal(again, 0);
    assert.equal(s.calls.filter((c) => c.url.includes("/channels/c/messages") && c.body !== undefined).length, 2);
  });

  it("reports a failed send with an error code, never throws out of the tick", async () => {
    const s = script({
      "/outbox?": () => ({ items: [{ messageId: "hub:f->discord", body: "x", lang: "ko", ts: 1 }] }),
      "/outbox/ack": () => ({ acked: true }),
    });
    const failing = s.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/channels/")) return new Response("{}", { status: 403 });
      return failing(input, init);
    }) as typeof fetch;
    const sent = await new DiscordRunner(cfg).outboundTick();
    assert.equal(sent, 0);
    const ack = s.calls.find((c) => c.url.endsWith("/outbox/ack"))?.body;
    assert.equal(ack?.ok, false);
    assert.equal(ack?.error, "http-403");
  });

  it("starts the inbound cursor at now, then posts human messages only", async () => {
    let cursorSet = false;
    const s = script({
      "?limit=1": () => {
        cursorSet = true;
        return [{ id: "100", content: "old", author: { id: "u0" } }];
      },
      "?after=100": () => [
        { id: "102", content: "bot echo", author: { id: "b", bot: true } },
        { id: "101", content: "hello", author: { id: "u1", username: "wonjun" } },
      ],
      "/ingress": () => ({ targets: [] }),
    });
    globalThis.fetch = s.fetch;
    const runner = new DiscordRunner(cfg);
    assert.equal(await runner.inboundTick(), 0);
    assert.ok(cursorSet);
    assert.equal(await runner.inboundTick(), 1, "one human message, the bot one is dropped");
    const ingress = s.calls.filter((c) => c.url.endsWith("/ingress")).map((c) => c.body);
    assert.equal(ingress.length, 1);
    assert.equal(ingress[0]?.origin, "discord");
    assert.equal(ingress[0]?.nativeId, "101");
    assert.equal((ingress[0]?.sender as { displayName: string })?.displayName, "wonjun");
  });
});
