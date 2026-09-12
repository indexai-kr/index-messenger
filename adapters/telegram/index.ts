// Telegram adapter (official Bot API only, P1).
// Outbound: sendMessage. Inbound: webhook POST -> core /ingress.
// ~70 lines: the ease-of-adding proof starts here.

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  coreBaseUrl: string;
}

export async function sendTelegram(
  config: TelegramConfig,
  text: string,
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    },
  );
  if (!res.ok) throw new Error(`telegram send http ${res.status}`);
}

// Shape of an incoming Bot API update we care about.
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramInboundMessage;
  channel_post?: TelegramInboundMessage;
}

export interface TelegramFrom {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramInboundMessage {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string; title?: string };
  from?: TelegramFrom;
}

// Long-poll the official getUpdates endpoint. Used by discover.ts when
// TELEGRAM_CHAT_ID is left empty: the first received message reveals it.
export async function getUpdates(
  botToken: string,
  offset?: number,
  timeoutSec = 30,
): Promise<TelegramUpdate[]> {
  const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
  if (offset !== undefined) url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", String(timeoutSec));
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "channel_post"]));
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutSec * 1000 + 15000) });
  if (!res.ok) throw new Error(`telegram getUpdates http ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
  return data.result ?? [];
}

export function toIngress(update: TelegramUpdate): {
  origin: string;
  nativeId: string;
  lang: string;
  body: string;
} | null {
  const inbound = update.message ?? update.channel_post;
  const text = inbound?.text;
  if (!text) return null;
  const from = inbound?.from;
  const displayName =
    [from?.first_name, from?.last_name].filter((p) => p !== undefined && p !== "").join(" ") ||
    from?.username ||
    (from?.id !== undefined ? String(from.id) : undefined);
  return {
    origin: "telegram",
    nativeId: String(inbound?.message_id ?? Date.now()),
    lang: "ja", // bound language; refined by detection upstream if needed
    body: text,
    sender:
      from?.id !== undefined && displayName !== undefined
        ? { platform: "telegram", id: String(from.id), displayName }
        : undefined,
  };
}
