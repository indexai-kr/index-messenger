import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router } from "./router.ts";
import { PassthroughProvider } from "./translate/index.ts";
import { makeMessage } from "./schema.ts";

describe("router fan-out", () => {
  it("sends hub Korean to every bound channel except origin", async () => {
    const router = new Router({
      bindings: { hub: "ko", telegram: "ja", discord: "en" },
      translate: new PassthroughProvider(),
    });
    const msg = makeMessage("hub", "1", "ko", "안녕하세요");
    const routed = await router.route(msg);
    assert.equal(routed.targets.length, 2);
    assert.deepEqual(
      routed.targets.map((t) => t.channel).sort(),
      ["discord", "telegram"],
    );
    assert.equal(routed.targets.find((t) => t.channel === "telegram")?.lang, "ja");
    assert.equal(routed.targets.find((t) => t.channel === "discord")?.lang, "en");
  });

  it("skips translation when languages match", async () => {
    const router = new Router({
      bindings: { hub: "ko", telegram: "ko" },
      translate: new PassthroughProvider(),
    });
    const routed = await router.route(makeMessage("hub", "2", "ko", "그대로"));
    assert.equal(routed.targets[0]?.body, "그대로");
  });
});

describe("echo suppression", () => {
  it("drops own sends and keeps foreign traffic", async () => {
    const router = new Router({
      bindings: { hub: "ko", telegram: "ja" },
      translate: new PassthroughProvider(),
    });
    const own = makeMessage("telegram", "99", "ja", "echo?");
    router.markEmitted(own.id);
    assert.equal(router.isEcho(own), true);
    assert.equal(router.isEcho(makeMessage("telegram", "100", "ja", "new")), false);
  });

  it("survives a 20-message round trip without loops", async () => {
    const router = new Router({
      bindings: { hub: "ko", telegram: "ja", discord: "en" },
      translate: new PassthroughProvider(),
    });
    let delivered = 0;
    for (let i = 0; i < 20; i++) {
      const origin = i % 2 === 0 ? "hub" : "telegram";
      const lang = origin === "hub" ? "ko" : "ja";
      const msg = makeMessage(origin, `n${i}`, lang, `msg ${i}`);
      if (router.isEcho(msg)) continue;
      const routed = await router.route(msg);
      delivered += routed.targets.length;
      for (const copy of routed.targets) {
        router.markEmitted(`${msg.id}->${copy.channel}`);
        // A redelivery of the same outbound copy must read as echo.
        assert.equal(router.isEcho({ ...msg, id: `${msg.id}->${copy.channel}` }), true);
      }
    }
    assert.ok(delivered > 0);
  });
});
