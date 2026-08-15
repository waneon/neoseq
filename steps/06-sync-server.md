# 06. Durable synchronization server

상태: 계획됨

## 목표

클라이언트 UI와 독립적으로 검증 가능한 Rust synchronization service를 만든다.
서버가 update를 PostgreSQL에 commit하기 전에는 ack나 fan-out하지 않는다는
durability/security boundary를 fault test로 증명한다.

## 검증 가능한 딜리버러블

headless native/Wasm test client가 인증된 WebSocket session으로 server에
연결한다. 두 client가 서로 다른 update를 보내고 재접속한 뒤 같은 Loro state로
수렴한다. 서버 process 또는 PostgreSQL을 실패시켜도 ack된 update는 유실되지
않고, commit되지 않은 update는 다른 client에게 보이지 않는다.

## 구현 범위

### Versioned protocol

- `Hello`, `Welcome`, `Update`, `Ack`, `Presence`, `Error`, `ResyncRequired`
  binary envelope와 size/version negotiation을 구현한다.
- client message ID와 server receipt cursor를 transport metadata로 사용한다.
- Loro version vector/frontiers만 CRDT synchronization truth로 사용한다.
- unknown protocol/schema range와 oversized/malformed frame의 stable error를
  만든다.

### PostgreSQL model

- graph metadata, membership, update, checkpoint pointer, audit event schema와
  migration을 만든다.
- `(graph_id, message_id)` uniqueness로 retry를 idempotent하게 한다.
- graph content를 page/block SQL table로 projection하지 않는다.
- test backup/restore와 schema downgrade rejection을 제공한다.

### Graph room

- newest checkpoint와 update tail에서 room을 single-flight로 rehydrate한다.
- incoming update를 temporary Loro fork에서 제한/validation한다.
- exact bytes를 DB에 commit한 뒤 live room에 적용하고 ack/fan-out한다.
- commit 후 live import가 실패하면 room을 폐기하고 durable state에서 재구성한다.
- bounded connection/room queue와 slow-consumer disconnect를 구현한다.

### Authentication/authorization seam

- test issuer를 포함한 token verification port와 membership authorization을
  만든다.
- 모든 graph API/session/update에서 authorization을 검사한다.
- live session의 membership version/revocation 재검사를 구현한다.
- production identity provider 선택은 adapter configuration으로 남긴다.

### 운영 기본선

- liveness/readiness, structured log, trace correlation, metrics endpoint를
  만든다.
- note text/property value/raw update/token을 telemetry에서 redaction한다.
- frame/update/graph/rate/decompressed-size limit을 적용한다.

## 자동 검증 gate

```text
devenv tasks run build:sync-server
devenv tasks run test:server-protocol
devenv tasks run test:server-db
devenv tasks run test:sync -- --headless
devenv tasks run test:sync-faults
devenv tasks run test:server-authz
devenv --profile browser test
```

fault matrix는 DB commit 전/후 server kill, duplicate update, reordered update,
malformed Loro bytes, slow consumer, membership revoke, room
eviction/reconstruction을 포함한다.

## 수동 데모

1. devenv task로 PostgreSQL migration과 server를 실행한다.
2. test principal 두 명에게 같은 graph membership을 부여한다.
3. headless client 두 개에서 offline update를 만든 뒤 연결한다.
4. 양쪽 state hash와 durable update cursor를 확인한다.
5. PostgreSQL을 중단한 상태에서 update가 ack/fan-out되지 않는지 확인한다.
6. DB 복구 후 retry와 재접속으로 수렴하는지 확인한다.

## 완료 조건

- [ ] DB commit 이전에는 ack와 fan-out이 발생하지 않는다.
- [ ] retry/duplicate/reorder 후에도 peer와 server room이 수렴한다.
- [ ] authorization이 CRDT state와 독립적으로 강제된다.
- [ ] unauthorized/revoked principal은 graph 존재나 update를 관찰하지 못한다.
- [ ] process/room 재시작이 correctness에 영향을 주지 않는다.
- [ ] bounded queue와 limit이 부하 test에서 메모리 무한 증가를 막는다.
- [ ] telemetry sample에 사용자 content/credential이 없다.

## 이 단계에서 하지 않는 것

- 제품 Web client의 login/sync UX
- production identity provider와 billing
- 장기 update retention/physical compaction
- multi-region active-active와 broker 도입
