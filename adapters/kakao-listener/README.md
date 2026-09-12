# kakao-listener (P3, Android, separate app)

> Real implementation: `apps/kakao-listener` (Kotlin). This directory is
> the early stub, kept as reference only.

Closed-platform proof: no protocol reversing. This adapter only uses
the public Android APIs:

- Inbound: `NotificationListenerService` reads the message notification.
- Outbound: the notification's reply `RemoteInput` action sends the reply.

## Layout (to be created in Android Studio)

```
kakao-listener/
└── app/src/main/java/ai/index/messenger/
    ├── BridgeListener.kt   # NotificationListenerService -> POST /ingress
    └── ReplySender.kt      # RemoteInput reply -> KakaoTalk peer
```

## Rules

- No packet capture, no decompilation, no unofficial endpoints.
- Screenshots on a real device are the acceptance evidence.
- LOC here is compared against the official adapters in
  `docs/adapters.md` — the asymmetry is the point (declaration §5).
