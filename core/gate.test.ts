import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide, inspect, inspectCopy, tokensPreserved } from "./gate.ts";

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

  it("amounts: Korean scale words, symbol-first, English words", () => {
    for (const text of [
      "5만원 보내줘",
      "5만 원 보내줘",
      "3천원",
      "만원만 빌려줘",
      "$5 please",
      "€ 12.50",
      "pay 100 USD",
      "send 20 dollars",
      "50 won",
      "내일 3시에 5만원 보내줘",
    ]) {
      assert.ok(inspect(text).includes("amount"), `amount expected in: ${text}`);
    }
    for (const text of ["I wonder", "no money here", "달러 환율 궁금"]) {
      assert.ok(!inspect(text).includes("amount"), `no amount expected in: ${text}`);
    }
  });

  it("times and dates in English and Japanese", () => {
    for (const text of ["tomorrow at 3", "see you at 7", "9pm tonight", "next week", "明日3時", "来週"]) {
      assert.ok(inspect(text).includes("time"), `time expected in: ${text}`);
    }
    for (const text of ["Oct 3", "12/25", "10月3日", "2026년"]) {
      assert.ok(inspect(text).includes("date"), `date expected in: ${text}`);
    }
    assert.ok(!inspect("what a great day").includes("time"));
    assert.ok(!inspect("attend the meeting").includes("time"));
  });

  it("structural tokens: numbers and tags must survive translation", () => {
    assert.equal(tokensPreserved("120,000원", "120000 won"), true);
    assert.equal(tokensPreserved("5만원", "50,000 KRW"), false, "5 became 50000: currency was converted");
    assert.equal(tokensPreserved("[P1 echo 04/20] 잘 도착하면 성공", "If it arrives well, it's a success."), false);
    assert.equal(tokensPreserved("[P1 echo 04/20] 잘 도착하면 성공", "[P1 echo 04/20] 無事に到着すれば成功"), true);
    assert.equal(tokensPreserved("meet at 10:30", "10시 30분에 보자"), true);
    assert.equal(tokensPreserved("hello", "[en] hello"), true, "translator prefix tag is tolerated");
    assert.equal(tokensPreserved("hello", "hello 2"), false, "an invented number holds");
    assert.deepEqual(inspectCopy("hello", "hello"), []);
    assert.ok(inspectCopy("[TAG] hi", "hi").includes("tokens"));
  });
});
