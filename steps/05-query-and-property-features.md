# 05. Query engine과 property-driven feature

상태: 계획됨

## 목표

uniform property 모델의 확장성을 제품 수준에서 증명한다. 별도 task/query 저장
모델을 추가하지 않고 query program과 task UI를 ordinary property projection으로
구현한다. 이 단계가 끝나면 local-only 사용자에게 제공 가능한 MVP가 된다.

## 검증 가능한 딜리버러블

사용자는 Web app에서 `query.source` property를 작성해
Markdown/property/hierarchy를 검색하고, 결과가 graph edit에 반응해 갱신되는 것을
볼 수 있다. 같은 block은 `task.*` property의 존재에 따라 task control을
제공하지만 generic property inspector에서도 동일 값을 읽고 수정할 수 있다.

## 구현 범위

### Query language

- `from blocks/pages`, boolean predicate, typed comparison, repeated property
  membership, Markdown search, ancestor/descendant, projection, sort, distinct,
  limit를 구현한다.
- `property(key)`와 page `default(key)`를 구분한다.
- autocomplete가 display hint와 stable `PageId`를 source에 넣게 한다.
- parser/typechecker/planner가 source span을 가진 diagnostic을 반환한다.
- query language version을 `query.language` property로 관리한다.

### Index와 execution

- page/block entity, hierarchy, typed property, repeated property, Markdown
  token/trigram, journal date/title index를 만든다.
- Loro semantic change를 entity/field change set으로 바꾸고 한 index
  revision으로 atomic publish한다.
- dependency set이 겹치는 subscribed query만 debounce/re-execute한다.
- time, scanned candidate, row, memory, parse depth, operator budget과
  cancellation을 구현한다.
- persisted index cache는 version fingerprint mismatch 시 폐기/재생성한다.

### Query projection UI

- `query.source: String`이 있는 block에 editor, diagnostic, loading/result
  view를 제공한다.
- query 결과는 derived UI이며 CRDT나 property로 저장하지 않는다.
- invalid source는 ordinary string property로 계속 수정할 수 있다.
- query renderer가 제거되어도 generic property editor에서 source가 보인다.

### Task projection UI

- `task.status`에 `todo`, `doing`, `done` 기본 control을 제공하되 stored value는
  String property다.
- `task.scheduled`, `task.deadline`에는 date control, `task.priority`에는 String
  priority control을 제공한다.
- task list/agenda는 query engine으로 구성하고 별도 task table/index를 만들지
  않는다.
- unknown status/priority는 손실 없이 generic value와 fallback label로 표시한다.

## 자동 검증 gate

```text
nix run .#test-query-parser
nix run .#test-query-differential
nix run .#test-query-conformance
nix run .#test-query-budget
nix run .#test-e2e-web -- --grep query-task
nix build .#web
nix flake check
```

검증 corpus는 다음을 포함한다.

- 다섯 property type의 equality/order/존재/missing
- repeated `tag` membership을 generic property operator로 조회
- deleted/missing PageId와 duplicate display title
- deep/wide hierarchy predicate
- index plan과 slow full-scan interpreter의 결과 비교
- native/Wasm 결과, 정렬, diagnostic 일치
- edit 중 cancellation과 stale revision 결과 폐기
- budget 초과 시 incomplete row 대신 typed error 반환

## 수동 데모

1. 여러 journal block에 project tag와 task properties를 넣는다.
2. 별도 block에 overdue todo를 찾는 `query.source`를 property editor로 작성한다.
3. query 결과에서 task status를 `done`으로 변경한다.
4. 원본 block과 generic property inspector 값이 바뀌고 결과가 즉시 사라지는지
   본다.
5. task/query renderer를 feature flag로 끄고도 모든 값이 generic property로
   보존되는지 확인한다.

## 완료 조건

- [ ] query와 task를 위한 feature-specific canonical table/container가 없다.
- [ ] tag/task/query를 generic property operator로 조회할 수 있다.
- [ ] indexed plan과 reference interpreter가 전체 corpus에서 같다.
- [ ] native/Wasm query 결과와 diagnostic fixture가 같다.
- [ ] reactive query가 partial index revision을 관찰하지 않는다.
- [ ] malicious/expensive query가 UI thread를 장시간 점유하지 않는다.
- [ ] Local MVP 데모가 계정/서버 없이 재현된다.

## 이 단계에서 하지 않는 것

- server-side query
- arbitrary JavaScript/Rust/Wasm user function
- unbounded join, recursion, regex
- remote collaboration과 native-specific task notification
