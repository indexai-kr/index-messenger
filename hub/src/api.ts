const BASE = "";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`hub api ${res.status}`);
  return (await res.json()) as T;
}

export interface LedgerEntry {
  ts: number;
  direction: string;
  channel: string;
  messageId: string;
  body: string;
  verdict?: string;
  sender?: { platform: string; id: string; displayName: string };
}

export interface RoundTrip {
  channel: string;
  lang: string;
  translated: string;
  backTranslation: string;
  translateMs: number;
  backMs: number;
}

export interface SendResult {
  held: boolean;
  id: string;
  matched: string[];
  roundTrips: RoundTrip[];
}

export const api = {
  health: () => call<{ ok: boolean }>("/health"),
  bindings: () => call<Record<string, string>>("/bindings"),
  saveBindings: (b: Record<string, string>) =>
    call<Record<string, string>>("/bindings", {
      method: "POST",
      body: JSON.stringify(b),
    }),
  ledger: () => call<LedgerEntry[]>("/ledger"),
  send: (body: string, lang: string) =>
    call<SendResult>("/send", {
      method: "POST",
      body: JSON.stringify({ body, lang }),
    }),
  confirm: (id: string, body?: string) =>
    call<{ confirmed: boolean }>("/confirm", {
      method: "POST",
      body: JSON.stringify({ id, body }),
    }),
};
