# 09. Data lifecycle, migration, archive

상태: 계획됨

## 목표

장기간 사용과 version upgrade에서 graph를 잃지 않도록 local/server data
lifecycle을 완성한다. migration, checkpoint/retention, import/export, corruption
quarantine, backup/restore를 compatibility fixture와 fault test로 검증한다.

## 검증 가능한 딜리버러블

이전 schema fixture를 현재 client/server로 열어 migration하고, 큰 remote graph를
checkpoint/compact한 뒤 장기간 offline이었던 client가 다시 동기화된다. 같은
graph를 portable archive로 export해 새 profile/platform에 import하면 canonical
content가 일치한다. 손상 fixture는 마지막 valid state로 복구되고 손상 원본은
보존된다.

## 구현 범위

### Schema/property definition migration

- supported schema range, migration ID, `applied_migrations`, minimum client
  write gate를 구현한다.
- migration은 idempotent/monotonic normal CRDT operation으로 실행한다.
- well-known property definition, RDF projection/vocabulary, SPARQL profile,
  text analyzer version의 compatibility fixture를 유지한다.
- future schema는 가능한 경우 read-only/export mode로 열고 silent downgrade하지
  않는다.

### Local checkpoint/compaction

- bytes/count/idle threshold와 safe checkpoint replacement를 구현한다.
- newest checkpoint 기록이 durable해진 뒤에만 포함된 update를 compactable로
  표시한다.
- crash 시 prior checkpoint 또는 valid tail로 돌아갈 수 있게 한다.
- derived RDF/query index cache는 Loro frontier 또는 projection/profile/analyzer
  version mismatch 시 삭제하고 canonical snapshot에서 rebuild한다.

### Server checkpoint/retention

- background worker가 durable state를 rehydrate/verify/export하고 checkpoint
  pointer를 transaction으로 교체한다.
- 최소 한 개 prior verified checkpoint와 retention grace window를 유지한다.
- incremental history 밖의 client에는 checkpoint+tail resync를 제공한다.
- pinned Loro version에서 shallow/history retention이 offline restore와 수렴함을
  증명한 뒤에만 physical update deletion을 켠다.

### Portable archive

- versioned manifest, checksum, Loro snapshot/update bundle을 가진 archive
  format을 구현한다.
- explicit create 또는 replace semantics를 제공하고 title이 같다는 이유로
  merge하지 않는다.
- decompression/path/size/checksum limit과 untrusted parser fuzz target을
  만든다.
- archive에 credential, local cursor, presence, derived index를 포함하지 않는다.

### Corruption과 삭제

- corrupt update/checkpoint/archive를 quarantine하고 diagnostic/export handle을
  남긴다.
- graph local replica 삭제와 remote graph administrative deletion을 분리한다.
- soft delete/restore와 physical retention cleanup의 사용자 의미를 구분한다.

## 자동 검증 gate

```text
nix run .#test-schema-compatibility
nix run .#test-property-compatibility
nix run .#test-checkpoint-recovery
nix run .#test-server-retention
nix run .#test-archive-roundtrip
nix run .#test-backup-restore
nix flake check
```

fixture matrix는 최초 지원 schema부터 현재 schema, unknown property, invalid
typed property, pre/post checkpoint crash, truncated archive, zip bomb 유사
입력, retention window 밖 client를 포함한다.

## 수동 데모

1. 이전 version fixture를 현재 Web client에서 연다.
2. migration 후 Web/macOS/Android에서 같은 graph hash를 확인한다.
3. archive를 export하고 새 profile의 local graph로 import한다.
4. remote server DB를 backup에서 복원하고 client를 reconnect한다.
5. update 하나를 손상시켜 마지막 valid state와 quarantine 진단을 확인한다.

## 완료 조건

- [ ] 지원하는 모든 schema fixture가 현재 version으로 lossless migration된다.
- [ ] migration을 두 번 실행해도 두 번째 실행이 semantic state를 바꾸지 않는다.
- [ ] checkpoint/retention 뒤 offline client가 checkpoint+tail로 수렴한다.
- [ ] archive가 지원 platform 사이에서 canonical content를 보존한다.
- [ ] corrupt input이 panic, silent coercion, valid history overwrite를 일으키지
      않는다.
- [ ] backup restore drill이 문서화된 RPO/RTO 후보를 측정해 기록한다.
- [ ] hard delete 대상과 보존 기간이 명시적이며 테스트된다.

## 이 단계에서 하지 않는 것

- end-to-end encryption archive/key management
- 외부 Markdown 포맷과의 완전한 양방향 변환
- 법적 보존 정책의 제품별 세부 확정
- multi-region backup topology
