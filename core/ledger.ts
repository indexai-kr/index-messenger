import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SenderInfo } from "./schema.ts";

// Local JSONL ledger: every send/receive keeps its source/translation
// pair with timestamp and channel. Privacy by locality — no cloud store.

export interface LedgerEntry {
  ts: number;
  direction: "in" | "out" | "gate";
  channel: string;
  messageId: string;
  lang: string;
  body: string;
  translatedLang?: string;
  translatedBody?: string;
  verdict?: string;
  sender?: SenderInfo;
}

export class Ledger {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }

  async append(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
  }

  async readAll(): Promise<LedgerEntry[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw
        .split("\n")
        .filter((line: string) => line.trim().length > 0)
        .map((line: string) => JSON.parse(line) as LedgerEntry);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }
}
