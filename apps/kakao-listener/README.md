# kakao-listener app (Android, Kotlin)

Closed-platform bridge with no protocol reversing: notification read for
ingress, notification reply action (RemoteInput) for egress, core outbox
polling in between. See the repo README for the inherent limits.

## Build

Android Studio Ladybug or newer, SDK 34, a physical device (no emulator
notification access to KakaoTalk). Open `apps/kakao-listener`, sync, run.

## Run

1. Start the core server on a host reachable from the phone.
2. In the app: hub address, default room title, poll seconds, max retries.
   Nothing here is prefilled with personal data.
3. Grant notification access, start the poll loop from the settings screen.
4. Acceptance per the P3 directive: one KakaoTalk message in, one hub
   message out to the room, failure-without-notification recorded.

## Design notes

- `KakaoListener`: MessagingStyle bursts are injected one by one with
  `key:postTime:index` ids; delivered ids persist (cap 500).
- `PollService`: hub-originated traffic only; retry queue capped at 20,
  bodies dropped after the retry cap; the hub ledger is the record.
- Send pacing: same-room 30 s, room-switch 10 s, ±20% jitter, quiet
  01–07, daily cap 50 — all adjustable, none removable below safe floors.
- Same-title rooms are undeliverable by design (`ambiguous-room`).
- No message content is logged anywhere in the app.

## First live run (one room only)

1. Dry-run ON, default room = a test room you own, save and start.
2. Send a test message in that room; confirm a `dry-run` ack lands in
   the hub ledger and nothing arrives in the room.
3. Dry-run OFF, repeat; confirm real arrival + `delivered` ack.
4. Only then point the default room at a live room.
