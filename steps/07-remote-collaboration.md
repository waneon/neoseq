# 07. Remote graph와 실시간 collaboration

상태: 완료

## 목표

05의 Web app과 06의 server를 연결해 remote graph를 local-first 방식으로 사용할
수 있게 한다. 연결이 끊겨도 local edit가 계속되고, 재접속 시 update가 유실 없이
수렴하며 save/sync/live 상태를 사용자가 구분할 수 있어야 한다.

## 검증 가능한 딜리버러블

두 개의 독립 browser profile에서 같은 remote graph를 연다. 양쪽이 online에서
서로의 편집을 실시간으로 보고, 한쪽을 offline으로 전환해 각각 Markdown, outline,
tag/default/task/query property를 수정한 뒤 reconnect하면 같은 graph로 수렴한다.

## 구현 범위

### Client SyncAgent

- remote graph도 local repository/runtime을 먼저 열고 즉시 편집 가능하게 한다.
- durable local update를 outbox에 넣고 ack 전까지 retry한다.
- Hello/version-vector reconciliation, update import, ack cursor, reconnect
  backoff와 jitter를 구현한다.
- remote import도 GraphRuntime을 통해 index/event/UI에 반영한다.
- schema/protocol mismatch와 `ResyncRequired` recovery를 구현한다.

### Remote graph/account UX

- production-compatible authentication adapter와 secure Web session을 연결한다.
- remote graph 생성, membership 조회/초대/취소의 최소 UX를 제공한다.
- local graph와 remote graph를 명확히 구분하고 local-only graph는 server에
  접촉하지 않게 한다.
- `saved locally`, `synced remotely`, `live`를 독립적으로 표시한다.
- auth expiry는 sync만 pause하고 local replica를 계속 사용할 수 있게 한다.

### Realtime collaboration

- Markdown, tree move, property edit의 semantic remote event를 적용한다.
- cursor/selection presence는 expiry가 있는 비영속 message로 구현한다.
- remote text change에 selection을 transform하고 viewport 밖 update는 필요한
  projection만 갱신한다.
- local undo가 remote command를 되돌리지 않는지 UI까지 검증한다.

### Multi-tab과 session identity

- browser tab마다 고유 Loro peer/session ID를 사용한다.
- 같은 local replica를 여는 tab은 coordination lease를 획득하고, 획득하지 못한
  tab은 read-only 또는 명시적인 별도 replica mode로 연다.
- 절대로 concurrent runtime이 peer ID를 재사용하지 않게 한다.

## 자동 검증 gate

```text
devenv test
devenv --profile browser test
devenv --profile browser tasks run test:e2e-collaboration
```

collaboration E2E는 격리된 PostgreSQL/server와 두 browser context를 실행해
online fan-out, browser offline edit, reconnect 수렴, membership revocation을
검증한다. browser IndexedDB suite가 durable outbox restart를, Rust 수렴/fault
suite가 reorder, duplicate, commit 경계와 server rehydrate 뒤 canonical state를
별도로 검증한다.

## 수동 데모

1. 두 browser profile로 서로 다른 사용자로 로그인한다.
2. 한 사용자가 remote graph를 만들고 다른 사용자를 초대한다.
3. 동일 journal에서 동시에 Markdown과 block 위치를 수정한다.
4. 한 browser를 offline으로 만들고 양쪽에서 같은 task/tag property를 수정한다.
5. reconnect 후 수렴 결과와 saved/synced/live indicator를 확인한다.
6. membership을 취소해 기존 socket이 닫히고 local replica는 export 가능한지
   본다.

## 완료 조건

- [x] network가 없는 동안 local edit/save가 차단되지 않는다.
- [x] ack되지 않은 outbox update가 reconnect/server restart 후 재전송된다.
- [x] 최종 state가 native headless reference를 포함한 모든 peer에서 같다.
- [x] local save, remote sync, connection live 상태가 서로 혼동되지 않는다.
- [x] auth expiry/revocation이 local data를 삭제하거나 잠그지 않는다.
- [x] presence가 durable update/history에 포함되지 않는다.
- [x] remote beta 시나리오가 문서만으로 반복 가능하다.

## 이 단계에서 하지 않는 것

- macOS/Android native lifecycle
- end-to-end encryption
- multi-region server와 대규모 room sharding
- 최종 retention/backup SLO
