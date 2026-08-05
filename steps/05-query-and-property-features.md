# 05. SPARQL query, derived index와 property-driven feature

상태: 계획됨

## 목표

Loro document를 canonical source of truth로 유지하면서, graph 전역 query와
search는 재생산 가능한 RDF index에서 실행한다. 사용자 query 언어를 read-only
SPARQL 1.1 profile로 고정하고, task/query 기능이 별도 canonical 모델 없이
ordinary property와 같은 query 경로 위에서 동작함을 제품 수준에서 증명한다.

## 검증 가능한 딜리버러블

사용자는 Web app에서 `query.source`에 SPARQL을 작성해 Markdown, property, tag,
page/block hierarchy를 조회하고 graph edit에 따라 결과가 갱신되는 것을 볼 수
있다. index cache를 모두 지운 뒤에도 Loro snapshot에서 같은 RDF projection과
query 결과를 재생산한다. 같은 block은 `task.*` property에 따라 task control을
제공하지만 generic property inspector에서도 동일 값을 읽고 수정할 수 있다.

## 구현 범위

### RDF projection과 index

- page, block, tag를 graph-scoped stable entity IRI로, structural relation을
  `neo:*` predicate로 투영한다.
- ordinary property key는 reversible `prop:` predicate, tag default key는
  `def:` predicate로 투영한다.
- number/string/page/checkbox/date를 각각 고정된 RDF IRI 또는 typed literal로
  변환하며 dangling reference는 object IRI로 보존한다.
- RDF term dictionary와 `SPO`, `POS`, `OSP` permutation, predicate statistics,
  entity-to-triple ledger를 구현한다.
- Markdown token/trigram posting과 hierarchy reachability cache는 같은 RDF
  revision을 검증하는 accelerator로만 둔다.
- semantic change를 entity/field change set으로 바꾸고 triples/postings를 한
  index revision으로 atomic publish한다.
- index revision에 Loro frontier와 document/projection/query-profile/analyzer
  version fingerprint를 기록한다. mismatch/corruption이면 cache를 폐기하고
  Loro snapshot에서 rebuild한다.

### SPARQL language와 execution

- language identifier를 `sparql-1.1/neoseq-v1`로 고정한다.
- `SELECT`, `ASK`, basic graph pattern, filter/bind/values, optional/union/minus,
  exists, subquery, aggregate/group/order/distinct/pagination, property path를
  지원한다.
- `CONSTRUCT`, `DESCRIBE`, dataset/`GRAPH`, `SERVICE`, SPARQL Update와 extension
  loading은 parse/validation 단계에서 거부한다.
- Markdown search는 index로 lower 가능한
  `neo:matchesText(?content, ?needle)` 하나만 extension으로 제공한다.
- parameters는 typed RDF initial bindings로 전달하며 source string에
  interpolation하지 않는다.
- parser/algebra/planner가 source span을 가진 diagnostic을 반환하고 triple
  statistics로 permutation과 join order를 선택한다.
- source/algebra/path depth, time, scanned entry, intermediate solution, row,
  memory budget과 cancellation을 구현한다. Production execution은 LoroDoc
  full scan으로 fallback하지 않는다.

### Reactive query와 공용 search

- compiled plan이 predicate/entity/text/structural dependency를 선언한다.
- dependency가 겹치는 subscribed query만 debounce/re-execute한다. variable
  predicate는 모든 triple revision에 의존한다.
- query 결과에 index revision과 Loro frontier를 포함하고 UI가 stale result를
  폐기한다.
- global search, backlink, task list, agenda는 SPARQL request를 생성해 동일한
  query API를 사용하며 별도 graph scan API를 만들지 않는다.

### Query projection UI

- `query.source: String`이 있는 block에 SPARQL editor, vocabulary/property/entity
  IRI autocomplete, diagnostic, loading/result view를 제공한다.
- 새 query block은 `query.language: "sparql-1.1/neoseq-v1"`을 함께 기록한다.
- query 결과와 bindings는 derived UI이며 CRDT나 property로 저장하지 않는다.
- invalid source는 ordinary string property로 계속 수정할 수 있다.
- query renderer가 제거되어도 generic property editor에서 source/language가
  보인다.

### Task projection UI

- `task.status`에 `todo`, `doing`, `done` 기본 control을 제공하되 stored value는
  String property다.
- `task.scheduled`, `task.deadline`에는 date control, `task.priority`에는 String
  priority control을 제공한다.
- task list/agenda는 RDF projection의 `prop:task.*` predicate를 SPARQL로
  조회하고 별도 task table/index를 만들지 않는다.
- unknown status/priority는 손실 없이 generic value와 fallback label로 표시한다.

## 자동 검증 gate

```text
nix run .#test-query-projection
nix run .#test-query-rebuild
nix run .#test-query-conformance
nix run .#test-query-differential
nix run .#test-query-budget
nix run .#test-e2e-web -- --grep query-task
nix build .#web
nix flake check
```

검증 corpus는 다음을 포함한다.

- 모든 entity/relation과 다섯 property type의 RDF mapping
- repeated value, deleted entity, dangling PageId/TagId, duplicate display title
- SPARQL supported profile과 명시적으로 제외한 query/update form
- deep/wide hierarchy property path와 Markdown search
- incremental revision과 clean rebuild의 semantic triple/result equality
- indexed plan과 projected triple set reference interpreter 결과 비교
- native/Wasm 결과, ordering, typed binding, diagnostic 일치
- edit 중 cancellation과 stale revision 결과 폐기
- budget 초과 시 incomplete row 대신 typed error 반환

## 수동 데모

1. 여러 journal block에 project tag와 task properties를 넣는다.
2. 별도 block에 overdue todo를 찾는 `SELECT` query를 작성하고 `?today`를 typed
   binding으로 실행한다.
3. query 결과에서 task status를 `done`으로 변경한다.
4. 원본 block과 generic property inspector 값이 바뀌고 결과가 즉시 사라지는지
   본다.
5. app을 닫고 derived index cache를 삭제한 뒤 다시 열어 동일 결과가 rebuild되는지
   확인한다.
6. task/query renderer를 feature flag로 꺼도 모든 값이 generic property로
   보존되는지 확인한다.

## 완료 조건

- [ ] Loro document/update/checkpoint 외 query/search canonical 저장소가 없다.
- [ ] graph 전역 query/search가 runtime에서 LoroDoc을 scan하지 않는다.
- [ ] index 삭제/손상/version mismatch 후 projection과 결과가 재생산된다.
- [ ] tag/task/property/hierarchy/Markdown을 한 SPARQL API로 조회할 수 있다.
- [ ] SPARQL profile의 허용/거부 범위와 typed binding/result 계약이 고정된다.
- [ ] incremental index와 clean rebuild가 전체 corpus에서 같다.
- [ ] indexed plan과 reference interpreter가 전체 corpus에서 같다.
- [ ] native/Wasm query 결과와 diagnostic fixture가 같다.
- [ ] reactive query가 partial index revision을 관찰하지 않는다.
- [ ] malicious/expensive query가 UI thread를 장시간 점유하지 않는다.
- [ ] Local MVP demo가 계정/서버 없이 재현된다.

## 이 단계에서 하지 않는 것

- server-side/federated SPARQL endpoint
- SPARQL Update 또는 RDF를 통한 graph mutation
- arbitrary JavaScript/Rust/Wasm user function
- inference/entailment regime와 외부 ontology fetch
- remote collaboration과 native-specific task notification
