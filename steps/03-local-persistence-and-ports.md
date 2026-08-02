# 03. Local persistence와 CorePort

상태: 계획됨

## 목표

02의 core를 native와 browser에서 같은 public contract로 열고, application
재시작과 부분 실패를 견디는 local-only graph를 만든다. 네트워크 없이 canonical
data의 durability를 증명하는 단계다.

## 검증 가능한 딜리버러블

동일한 persistence corpus를 SQLite와 IndexedDB adapter에 실행한다. corpus는
graph를 만들고 여러 update를 저장한 뒤 runtime/process/page를 종료하고 다시 열어
같은 snapshot을 확인한다. update tail 손상, append 실패, quota/transaction
실패도 주입하여 documented failure state를 확인한다.

## 구현 범위

### Repository port

- graph locator와 local/remote metadata를 정의하되 이 단계에서는 local graph만
  연다.
- checkpoint load/save, update tail stream/append, compact marker, index cache,
  explicit local delete port를 구현한다.
- update record에 local sequence, checksum, Loro bytes, 생성 시각을 저장한다.
- append 성공 전 `saved locally`를 emit하지 않는다.

### Native adapter

- SQLite WAL schema와 migration version을 만든다.
- metadata/update/checkpoint/outbox-ready table을 transaction으로 관리한다.
- abrupt process termination과 database busy/disk-full 오류를 typed error로
  매핑한다.

### Browser adapter

- IndexedDB object store와 version upgrade를 구현한다.
- Rust/Wasm core를 dedicated Web Worker에서 실행한다.
- transferable `ArrayBuffer`를 이용해 large payload 복사를 제한한다.
- storage quota/persistence capability를 DTO로 노출한다.

### CorePort

- `open_graph`, `execute`, `read`, `subscribe`, `close_graph`의 version 1
  schema를 고정하고 Rust/TypeScript type을 생성한다.
- native in-process adapter와 Worker message adapter에 동일 contract suite를
  적용한다.
- subscription overflow, command timeout, dirty-unsaved, unsupported schema
  오류를 안정적인 code로 노출한다.

### Checkpoint와 recovery

- append-only update를 immediate durability path로 사용한다.
- threshold/idle 기반 local checkpoint를 만든다.
- newest valid checkpoint와 checksum-valid tail만 replay한다.
- corrupt tail은 삭제하지 않고 quarantine metadata와 export handle을 남긴다.

## 자동 검증 gate

```text
nix run .#test-persistence -- --adapter sqlite
nix run .#test-persistence -- --adapter indexeddb
nix run .#test-core-port -- --adapter native
nix run .#test-core-port -- --adapter web-worker
nix run .#test-recovery
nix build .#core-native
nix build .#core-wasm
nix flake check
```

fault injection matrix는 append 전/후 process kill, checkpoint rename 전/후
실패, checksum mismatch, truncated update, IndexedDB abort/quota, SQLite
busy/disk full을 포함한다.

## 수동 데모

1. native scenario runner와 browser test page에서 각각 같은 graph fixture를
   연다.
2. journal/block/property를 수정하고 saved 상태를 확인한다.
3. process 또는 browser를 강제 종료하고 다시 연다.
4. snapshot hash와 visible state가 종료 전과 같은지 확인한다.
5. 의도적으로 corrupt tail을 주입하고 마지막 valid state가 read-only가 아닌
   usable 상태로 열리며 진단이 표시되는지 확인한다.

## 완료 조건

- [ ] SQLite와 IndexedDB가 동일 repository conformance suite를 통과한다.
- [ ] 저장 성공과 UI-visible saved event 사이의 순서가 test로 고정된다.
- [ ] crash/reload 후 acknowledged local command가 유실되지 않는다.
- [ ] corrupt data가 silent coercion 또는 전체 graph 손실을 만들지 않는다.
- [ ] native/Worker CorePort DTO와 error code가 golden fixture와 일치한다.
- [ ] local-only graph를 열고 편집하는 동안 network call이 발생하지 않는다.

## 이 단계에서 하지 않는 것

- 사용자용 editor UI
- query index/실행
- remote acknowledgement와 실시간 연결
- portable archive와 장기 server retention
