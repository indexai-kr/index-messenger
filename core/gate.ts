// Outbound gate (P2): hold messages that carry high-risk patterns
// (numbers, amounts, dates, addresses) for human confirmation.
// Everything else passes automatically. Every verdict is ledger-logged.

export type GateVerdict = "pass" | "hold";

export interface GateDecision {
  verdict: GateVerdict;
  /** Back-translation shown in the hub for confirmation. */
  backTranslation: string;
  matched: string[];
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "amount", re: /[0-9][0-9,]*\s*(원|엔|¥|₩|달러|\$|USD|JPY|KRW)/ },
  { name: "number", re: /\d{2,}/ },
  { name: "time", re: /(\d{1,2}\s*시|\d{1,2}:\d{2}|내일|모레|다음\s?주)/ },
  { name: "date", re: /(\d{1,4}년|\d{1,2}월\s?\d{1,2}일|\d{4}-\d{2}-\d{2})/ },
  { name: "address", re: /(시|구|동|로|길)\s*\d|https?:\/\/\S+/ },
];

export function inspect(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

export interface BackTranslator {
  (text: string, lang: string, hubLang: string): Promise<string>;
}

export async function decide(
  text: string,
  lang: string,
  hubLang: string,
  backTranslate: BackTranslator,
): Promise<GateDecision> {
  const matched = inspect(text);
  if (matched.length === 0) {
    return { verdict: "pass", backTranslation: text, matched };
  }
  const backTranslation = await backTranslate(text, lang, hubLang);
  return { verdict: "hold", backTranslation, matched };
}
