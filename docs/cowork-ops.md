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

## Read deliveries: `GET /outbox?channel&since`

```sh
curl "$CORE/outbox?channel=kakao&since=0"
# {"items":[{"messageId":"hub:…->kakao","body":"…","lang":"ko","ts":…}]}
```

Poll with the last seen `ts` as `since`. Items are routing decisions from
the ledger, newest last.

## Inject a hub-originated send (gate first, always)

Step 1 — approval gate:

```sh
curl -X POST "$CORE/send" -H 'content-type: application/json' \
  -d '{"body":"내일 3시에 만나요","lang":"ko"}'
# held:true → {id, matched, roundTrips[]} → inspect, then:
curl -X POST "$CORE/confirm" -H 'content-type: application/json' \
  -d '{"id":"hub:…"}'
# held:false → proceed directly
```

Step 2 — fan-out into the pipeline (cowork path):

```sh
curl -X POST "$CORE/cowork/ingress" -H 'content-type: application/json' \
  -d '{"nativeId":"cowork-001","lang":"ko","body":"…"}'
```

Skipping step 1 bypasses the gate and violates the policy below.
`nativeId` is your idempotency key: reuse your `client_message_id` here.
A retried id executes nothing — only the duplicate receipt is logged
(`verdict: duplicate`). Timeouts are safe to retry with the same id.

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
