# 02. Domain과 Loro CRDT core

상태: 계획됨

## 목표

UI와 저장소 없이도 graph/page/block/journal/Markdown/uniform property 동작을
완전히 실행할 수 있는 Rust core를 만든다. 이 단계에서 canonical schema와 domain
command semantics를 fixture로 고정한다.

## 검증 가능한 딜리버러블

headless scenario runner가 다음 동작을 수행하고 최종 graph snapshot과 semantic
event log를 출력한다.

- graph와 regular/journal page 생성
- root/child block 생성, Markdown 수정, indent/outdent/move/delete
- 다섯 property value type의 설정/삭제
- 단일/반복 property와 unknown property round-trip
- `tag: PageId` 추가 및 page default property materialization
- task/query/page/journal well-known property validation
- local undo/redo
- 두 개 이상 peer의 concurrent edit/move/delete 후 수렴

## 구현 범위

### Pure domain

- opaque `GraphId`, `PageId`, `BlockId`, `LocalDate`, `PropertyKey`,
  `PropertyValue`, `PropertyEntry`를 정의한다.
- well-known property definition registry에 type, cardinality, validation,
  defaultability를 정의한다.
- `tag`, `query.source`, `query.language`, `task.status`, `task.scheduled`,
  `task.deadline`, `task.priority`, `page.*`, `journal.date`, `block.page`,
  `system.*` 계약을 fixture로 만든다.
- unknown key는 지원 value type으로 보존하고 generic property로 취급한다.

### Graph command

- page ensure/rename/delete/restore와 deterministic journal ensure를 구현한다.
- block insert/edit/move/indent/outdent/delete를 intent command로 구현한다.
- property set/remove/add-repeated/remove-repeated와 page default command를
  구현한다.
- `AddTag` convenience command는 반복 property 추가와 default 복사를 한 Loro
  transaction으로 변환한다.
- command idempotency cache와 local undo grouping을 구현한다.

### Loro projection

- 문서 root container와 `PropertyBag` slot encoding을 schema version 1로
  고정한다.
- Markdown은 Loro text, block hierarchy는 movable tree, property bag은 map으로
  projection한다.
- root의 `block.page` invariant, cycle, dangling page reference, invalid
  property를 검사하고 deterministic repair/quarantine 결과를 낸다.
- raw Loro container가 domain DTO/API 밖으로 나오지 않게 한다.

### GraphRuntime

- 한 graph당 단일 actor/message loop를 구현한다.
- in-memory repository와 clock을 사용해 command, remote import, read, event
  subscription을 직렬화한다.
- bounded event cursor와 `ResyncRequired` 동작을 구현한다.

## 자동 검증 gate

```text
nix build .#core-native
nix build .#core-wasm
nix run .#test-domain
nix run .#test-core-model
nix run .#test-core-convergence
nix run .#core-scenario -- fixtures/core/basic.yaml
nix flake check
```

수렴 suite는 최소한 다음 교란을 property-based/randomized test로 생성한다.

- concurrent Markdown insert/delete
- 같은 block의 서로 다른 parent/page 이동
- ancestor delete와 descendant move
- 같은 single property의 concurrent set/remove
- 같은/different repeated tag 추가·삭제
- 같은 날짜 journal의 concurrent ensure
- tag 추가와 page default/property 직접 수정의 동시성
- update 순서 변경과 중복 import

## 수동 데모

1. scenario YAML을 실행해 journal과 nested outline을 만든다.
2. task/tag/query property가 generic property dump에 같은 형식으로 나타나는지
   본다.
3. 두 peer가 offline branch에서 수정한 뒤 update 순서를 뒤집어 import한다.
4. canonical JSON과 version fingerprint가 같고 semantic event가 설명 가능한지
   본다.

## 완료 조건

- [ ] architecture의 schema와 실제 fixture가 일치한다.
- [ ] 모든 비 Markdown feature state가 `PropertyBag`에만 존재한다.
- [ ] 다섯 value type과 single/repeated/unknown key가 lossless round-trip한다.
- [ ] tag default는 기존 값을 덮어쓰지 않고, 후속 default 변경은 소급되지
      않는다.
- [ ] randomized convergence test seed가 저장되고 실패를 재현할 수 있다.
- [ ] local undo가 imported remote command를 되돌리지 않는다.
- [ ] native/Wasm core fixture 결과가 byte 또는 canonical semantic form으로
      같다.

## 이 단계에서 하지 않는 것

- SQLite/IndexedDB durability
- frontend editor와 query 실행
- remote server/transport
- schema migration과 physical compaction
