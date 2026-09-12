// Chat-ID auto-discovery (TELEGRAM_CHAT_ID left empty).
//
// Usage from the repo root (PowerShell):
//   $env:TELEGRAM_BOT_TOKEN = "<botfather token>"   # or put it in .env and add --env-file=.env
//   node .\adapters\telegram\discover.ts
//
// Then: send any message to the bot (DM) or post in the channel where the
// bot is a member. The first received message reveals its chat_id, which
// this script prints to the console. Copy it into .env as TELEGRAM_CHAT_ID.
//
// Official getUpdates API only. No reversing of any kind.

import { getUpdates, toIngress } from "./index.ts";

const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (botToken === "") {
  console.error("TELEGRAM_BOT_TOKEN is empty. Set it in .env or the environment first.");
  process.exit(1);
}
const coreBaseUrl = (process.env.CORE_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

let offset: number | undefined;
console.log("Waiting for the first message (send anything to the bot)...");

for (;;) {
  let updates;
  try {
    updates = await getUpdates(botToken, offset, 30);
  } catch (error) {
    console.error(`getUpdates failed, retrying: ${(error as Error).message}`);
    continue;
  }
  for (const update of updates) {
    offset = update.update_id + 1;
    const inbound = update.message ?? update.channel_post;
    const chatId = inbound?.chat?.id;
    if (chatId === undefined) continue;
    const label =
      inbound?.chat?.title ?? inbound?.chat?.type ?? "unknown chat";
    console.log(`TELEGRAM_CHAT_ID=${chatId}  (${label})`);
    const ingress = toIngress(update);
    if (ingress !== null) {
      console.log(`first message: "${ingress.body}"`);
      try {
        const res = await fetch(`${coreBaseUrl}/ingress`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ingress),
        });
        console.log(`forwarded to core /ingress: http ${res.status}`);
      } catch {
        console.log("core not reachable — start it later; the chat_id above is still valid.");
      }
    }
    process.exit(0);
  }
}
