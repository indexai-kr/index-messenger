# Cowork ops — Hub API only

Cowork clients (e.g. a cowork seat) talk to the Hub API only. Direct
adapter calls are forbidden: every send below flows through the same L4
approval gate and the same ledger as the hub UI. No exceptions.

Conventions: `CORE=http://localhost:8787`. Bot tokens are never pasted
anywhere — they live in the server-side `.env`
(`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, …) and are referenced by name
only. The core API itself carries no auth token: bind it to localhost or
put it behind your own boundary.

## Trust rule: the server grants trust fields, never the client

`origin`, approval state, send results and policy verdicts are recorded
and granted by the server only. Cowork traffic MUST use
`POST /cowork/ingress` (not `/ingress`): the server tags it
`origin=cowork` no matter what the request claims. Any trust field the
client ships (`origin`, `verdict`, `approved`, `delivered`,
`translatedBody`, `translatedLang`, `direction`, `ts`) is stripped —
ignored, not rejected — and the strip is ledger-logged
(`verdict: stripped`, field names only, never values).

```sh
curl -X POST "$CORE/cowork/ingress" -H 'content-type: application/json' \
  -d '{"nativeId":"cowork-001","lang":"ko","body":"…"}'
```

## Read deliveries: `GET /outbox?channel&after` (or `&since`)

```sh
curl "$CORE/outbox?channel=kakao&after=0"
# {"items":[{"seq":42,"messageId":"hub:…->kakao","body":"…","lang":"ko","ts":…}],"latest":57}
```

Only undecided sends are served: once an executor has acked a
messageId (delivered / failed / dry-run) the send is folded out of the
queue. `seen` is a read receipt and does not fold. Poll with the last
`seq` as `after` (exact, even for two lines written in the same
millisecond); the legacy `since=<ts>` cursor still works. `latest` is
the current top of the ledger — a fresh executor that must not replay
history starts there.

## Approval inbox: `GET /pending`, `POST /confirm`, `POST /reject`

Every held send, whatever its origin (hub draft, relay copy, cowork
copy), is listed with the untranslated source, the patterns that held it
and the exact text that would go out:

```sh
curl "$CORE/pending"
curl -X POST "$CORE/confirm" -H 'content-type: application/json' -d '{"id":"…"}'
curl -X POST "$CORE/reject"  -H 'content-type: application/json' -d '{"id":"…"}'
```

Confirmation is by id only. A `body` in the request is a 400: approval
binds to the reviewed text, it never substitutes one. Held sends
survive a core restart (rebuilt from the ledger).

## Inject a hub-originated send

Two entrances, one gate. Both translate per bound channel, inspect the
source and every translation, and either write sendable `out` lines or
hold them for `/confirm`.

`/send` — a hub draft, held as a whole. On hold the response carries the
per-channel translation and its back-translation for review; confirming
the id releases exactly those strings:

```sh
curl -X POST "$CORE/send" -H 'content-type: application/json' \
  -d '{"body":"내일 3시에 만나요","lang":"ko"}'
# held:true  → {id, matched, roundTrips[{channel, translated, backTranslation}]}
# held:false → {id, policies[]} — the out lines are already written
curl -X POST "$CORE/confirm" -H 'content-type: application/json' -d '{"id":"hub:…"}'
```

`/cowork/ingress` — a message from a cowork client, tagged origin=cowork;
copies that trip the gate are held one by one and appear in `/pending`:

```sh
curl -X POST "$CORE/cowork/ingress" -H 'content-type: application/json' \
  -d '{"nativeId":"cowork-001","lang":"ko","body":"…"}'
```

There is no path that writes a sendable line without inspection.
`nativeId` is your idempotency key: reuse your `client_message_id` here.
The original is persisted before translation; a retried id that already
ran executes nothing (`duplicate: true`), one that is mid-flight gets
202 `processing`, and one whose translation failed (503,
`retryable: true`) resumes at translation on the next request. Timeouts
are safe to retry with the same id.

## Acknowledge: consumed is not delivered

Two different acts, two different states. Mixing them corrupts delivery
statistics, so the API refuses to mix them:

- **Consumed** (a client read the item): `POST /outbox/seen`.
- **Send result** (an executor reports the outcome): `POST /outbox/ack`
  with `delivered` / `failed:<code>` / `dry-run`.

**Acknowledged is not delivered.** Reading an item is not sending it.

```sh
curl -X POST "$CORE/outbox/seen" -H 'content-type: application/json' \
  -d '{"messageId":"hub:…->kakao","channel":"kakao","consumer":"cowork-desk"}'
# {"seen":true} → ledger verdict "seen"

curl -X POST "$CORE/outbox/ack" -H 'content-type: application/json' \
  -d '{"messageId":"hub:…->kakao","channel":"kakao","ok":true}'
# {"acked":true,"verdict":"delivered"}

curl -X POST "$CORE/outbox/ack" -H 'content-type: application/json' \
  -d '{"messageId":"hub:…->kakao","channel":"kakao","ok":false,"error":"no-notification-for-room"}'
# {"acked":true,"verdict":"failed"}

curl -X POST "$CORE/outbox/ack" -H 'content-type: application/json' \
  -d '{"messageId":"hub:…->kakao","channel":"kakao","ok":true,"mode":"dry-run"}'
# {"acked":true,"verdict":"dry-run"} — rehearsals never share "delivered"
```

## Binding policy clause

Clients of this gateway are not exempt from anything: hub-originated
sends only, the approval gate on every send, adapter-edge pacing
(same-room interval, quiet hours, daily cap), and full ledger logging.
A client that needs an exception does not get one — it gets rejected.

The single exception to "hub-originated sends only" is a relay pair the
operator wrote into `RELAY_PATH` (see `docs/architecture.md`, *Relay*):
a named `(from -> to)` corridor whose derived copies go out server-tagged
`origin=relay`, through the same gate, pacing and ledger. Every other
derived copy is `record-only` and never appears in `/outbox`. This is
not automatic forwarding between channels — it is one explicit line per
direction, and it is empty unless the operator says otherwise.
