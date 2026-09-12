// Slack adapter (official Web API only, P2).
// Target: <=100 lines including this header (see docs/adapters.md).

export interface SlackConfig {
  botToken: string;
  channelId: string;
}

export async function sendSlack(config: SlackConfig, text: string): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.botToken}`,
    },
    body: JSON.stringify({ channel: config.channelId, text }),
  });
  if (!res.ok) throw new Error(`slack send http ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(`slack api: ${data.error ?? "unknown"}`);
}

export interface SlackEvent {
  event_id?: string;
  text?: string;
  user?: string;
  username?: string;
}

export function toIngress(event: SlackEvent): {
  origin: string;
  nativeId: string;
  lang: string;
  body: string;
  sender?: { platform: string; id: string; displayName: string };
} | null {
  if (!event.text) return null;
  return {
    origin: "slack",
    nativeId: event.event_id ?? String(Date.now()),
    lang: "en",
    body: event.text,
    sender:
      event.user !== undefined
        ? { platform: "slack", id: event.user, displayName: event.username ?? event.user }
        : undefined,
  };
}
