// Discord adapter (official REST API only, P1).
// Outbound: POST /channels/{id}/messages. Inbound: gateway MESSAGE_CREATE
// forwarded to core /ingress by the runner (runner not included in LOC).

export interface DiscordConfig {
  botToken: string;
  channelId: string;
}

export async function sendDiscord(
  config: DiscordConfig,
  text: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${config.channelId}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bot ${config.botToken}`,
      },
      body: JSON.stringify({ content: text }),
    },
  );
  if (!res.ok) throw new Error(`discord send http ${res.status}`);
}

export interface DiscordAuthor {
  id?: string;
  username?: string;
  global_name?: string;
  bot?: boolean;
}

export interface DiscordEvent {
  id?: string;
  content?: string;
  author?: DiscordAuthor;
}

export interface IngressPayload {
  origin: string;
  nativeId: string;
  lang: string;
  body: string;
  sender?: { platform: string; id: string; displayName: string };
}

export function toIngress(event: DiscordEvent): IngressPayload | null {
  if (!event.content) return null;
  const author = event.author;
  return {
    origin: "discord",
    nativeId: event.id ?? String(Date.now()),
    lang: "en",
    body: event.content,
    sender:
      author?.id !== undefined
        ? {
            platform: "discord",
            id: author.id,
            displayName: author.global_name ?? author.username ?? author.id,
          }
        : undefined,
  };
}
