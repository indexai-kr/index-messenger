import { useEffect, useState } from "react";
import { api, type LedgerEntry, type PendingItem, type RoundTrip } from "./api.ts";

// Single conversation screen (Korean hub) + channel binding settings.
// Polls /ledger for the converged Korean view; posts via /send so the
// gate can hold risky messages for confirmation.
export function App(): JSX.Element {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [held, setHeld] = useState<{ id: string; matched: string[]; roundTrips: RoundTrip[] } | null>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      const [ledger, bindingTable, inbox] = await Promise.all([api.ledger(), api.bindings(), api.pending()]);
      setEntries(ledger.slice(-100));
      setBindings(bindingTable);
      setPending(inbox.items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

// Source channel of a ledger line: the origin before "->", if fanned out.
function sourceOf(e: LedgerEntry): string {
  const arrow = e.messageId.indexOf("->");
  const head = arrow >= 0 ? e.messageId.slice(0, arrow) : e.messageId;
  return head.split(":")[0] ?? e.channel;
}

function formatLine(e: LedgerEntry): string {
  const sender = e.sender !== undefined ? `${e.sender.displayName}: ` : "";
  const verdict = e.verdict !== undefined && e.verdict !== "" ? ` (gate: ${e.verdict})` : "";
  return `[${sourceOf(e)}] ${sender}${e.body}${verdict}`;
}

  async function onSend(): Promise<void> {
    if (!draft.trim()) return;
    try {
      const res = await api.send(draft, "ko");
      if (res.held) {
        setHeld({ id: res.id, matched: res.matched, roundTrips: res.roundTrips });
      } else {
        setDraft("");
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onConfirm(): Promise<void> {
    if (!held) return;
    await api.confirm(held.id);
    setHeld(null);
    setDraft("");
    await refresh();
  }

  async function decide(id: string, ok: boolean): Promise<void> {
    try {
      if (ok) await api.confirm(id);
      else await api.reject(id);
      if (held?.id === id) {
        setHeld(null);
        setDraft("");
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>Index Messenger Hub</h1>
      {loading && <p>불러오는 중…</p>}
      {error !== "" && <p role="alert">연결 오류: {error}</p>}
      <section>
        <h2>대화 (한국어)</h2>
        <button onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "수렴 뷰로" : "raw 전체 보기"}
        </button>
        <ul>
          {(showRaw ? entries : entries.filter((e) => e.channel === "hub")).map((e) => (
            <li key={`${e.messageId}-${e.ts}`}>{formatLine(e)}</li>
          ))}
        </ul>
        <input
          aria-label="메시지 입력"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="한국어로 입력 — 결박된 언어로 팬아웃됩니다"
        />
        <button onClick={() => void onSend()}>보내기</button>
        {held !== null && (
          <div>
            <p>게이트 보류 (감지: {held.matched.join(", ")}) — 상대에게는 이렇게 보입니다:</p>
            <ul>
              {held.roundTrips.map((r) => (
                <li key={r.channel}>
                  [{r.channel}/{r.lang}] {r.translated} → 역번역: {r.backTranslation}
                </li>
              ))}
            </ul>
            <button onClick={() => void onConfirm()}>확인 후 전송</button>
          </div>
        )}
      </section>
      <section>
        <h2>승인 대기 ({pending.length})</h2>
        {pending.length === 0 && <p>보류된 발신이 없습니다.</p>}
        <ul>
          {pending.map((p) => (
            <li key={p.id}>
              <div>
                [{p.kind === "copy" ? `${p.origin ?? "?"} → ${p.to}` : "hub 발신"}] 감지: {p.matched.join(", ") || "-"}
                {p.sender !== undefined ? ` · ${p.sender.displayName}` : ""}
              </div>
              <div>원문: {p.source}</div>
              {p.kind === "copy" && <div>발신 예정({p.lang}): {p.body}</div>}
              {p.kind === "draft" && (
                <ul>
                  {(p.copies ?? []).map((c) => (
                    <li key={c.channel}>
                      [{c.channel}/{c.lang}] {c.body}
                    </li>
                  ))}
                </ul>
              )}
              <button onClick={() => void decide(p.id, true)}>승인 후 전송</button>
              <button onClick={() => void decide(p.id, false)}>거절</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>채널 결박 (channel → lang)</h2>
        <pre>{JSON.stringify(bindings, null, 2)}</pre>
        <button
          onClick={() =>
            void api.saveBindings(bindings).then(() => refresh()).catch((e: Error) => setError(e.message))
          }
        >
          결박 저장
        </button>
      </section>
    </main>
  );
}
