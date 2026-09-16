// Pluggable translation interface. The default implementation speaks to
// any OpenAI-compatible chat-completions endpoint via fetch — no vendor
// SDK, so the provider stays replaceable.

export interface TranslateProvider {
  translate(text: string, from: string, to: string, signal?: AbortSignal): Promise<string>;
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements TranslateProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async translate(text: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
    if (from === to) return text;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal !== undefined ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                `Translate the user text from ${from} to ${to}. Reply with the translation only, no explanations. ` +
                `Translate idioms and slang by meaning, not word for word. If the text has a typo, translate the most ` +
                `likely intended meaning without commenting on it. Keep numbers, amounts, dates, names, URLs and ` +
                `bracketed tags exactly as written. Keep the register (casual stays casual, polite stays polite).`,
            },
            { role: "user", content: text },
          ],
        }),
        signal: combined,
      });
      if (!res.ok) throw new Error(`translate http ${res.status}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const out = data.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error("translate empty response");
      return out;
    } catch (error) {
      if (signal?.aborted) throw new Error("translate aborted");
      throw error;
    }
  }
}

// Deterministic stand-in for tests and offline demos.
export class PassthroughProvider implements TranslateProvider {
  async translate(text: string, from: string, to: string): Promise<string> {
    return `[${to}] ${text}`;
  }
}
