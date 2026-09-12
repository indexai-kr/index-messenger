# Issue register (mirrors to GitHub Issues once the repo is pushed)

## #1 구조 토큰 보존 유실 (OPEN, P2 gate criteria)

- 발견: P1 실측 에코 20연속 (2026-09-12), 원장 대조 확정.
  Discord 영어 팬아웃 20건 중 13건에서 `[P1 echo NN/20]` 접두 태그가
  번역 중 유실됨 (7건 보존). 동일 원문의 Telegram 일본어는 20/20 보존.
- 예시 (원장 기록):
  - 원문: `[P1 echo 04/20] 잘 도착하면 성공`
  - Discord 영어: `If it arrives well, it's a success.` (태그 유실)
  - Telegram 일본어: `[P1 echo 04/20] 無事に到着すれば成功` (태그 보존)
- 영향: 태그·번호·단위·금액·날짜 같은 구조 토큰이 번역에서 떨어지면,
  역번역 게이트도 떨어진 것을 기준으로 판단하게 된다. 관문이 눈감은
  봉투를 도장 찍는 셈이다.
- 결정: 코드는 지금 고치지 않는다 (P2 작업 범위). 공개 로드맵 P2 게이트
  기준에 "구조 토큰 보존 검증(태그·번호·단위·금액·날짜)"을 명기한다.
- 재현: `POST /ingress {origin:"hub", nativeId, lang:"ko", body:"[TAG] ..."}` →
  targets 중 discord(en) 복사본에서 `[TAG]` 유무 확인.

## #2 허브 첫 폴링 500 (OPEN, P4 scope, no code fix)

- 발견: P2-0 재실측. 헤드리스 촬영 1차 시도에서 허브 화면에 연결 오류가 떴다.
- 같은 시점 프록시 직접 조회는 200이었고, settling 후 재촬영은 정상 렌더됐다.
- 추정 원인: 콜드스타트 타이밍 (기동 직후 첫 폴링 실패), 현 UI는 실패 시 재시도 없이 에러 상태를 유지한다.
- 결정: 코드는 지금 고치지 않는다 (공개 로드맵 P4 범위).
