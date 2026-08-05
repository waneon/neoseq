# 05. SPARQL query, derived index와 property-driven feature

상태: 완료 (Local MVP, 2026-08-05)

## 목표

Loro document를 canonical source of truth로 유지하면서, graph 전역 query와
search는 재생산 가능한 RDF index에서 실행한다. 사용자 query 언어를 read-only
SPARQL 1.1 profile로 고정하고, task/query 기능이 별도 canonical 모델 없이
ordinary property와 같은 query 경로 위에서 동작함을 제품 수준에서 증명한다.

## 검증 가능한 딜리버러블

사용자는 Web app에서 `query.source`에 SPARQL을 작성해 Markdown, property, tag,
page/block hierarchy를 조회하고 graph edit에 따라 결과가 갱신되는 것을 볼 수
있다. app을 다시 열면 volatile index가 Loro snapshot에서 재생산되고 같은 RDF
projection과 query 결과를 얻는다. 같은 block은 `task.*` property에 따라 task control을
제공하지만 generic property inspector에서도 동일 값을 읽고 수정할 수 있다.

## 구현 범위

### RDF projection과 index

- page, block, tag를 graph-scoped stable entity IRI로, structural relation을
  `neo:*` predicate로 투영한다.
- ordinary property key는 reversible `prop:` predicate, tag default key는
  `def:` predicate로 투영한다.
- number/string/page/checkbox/date를 각각 고정된 RDF IRI 또는 typed literal로
  변환하며 dangling reference는 object IRI로 보존한다.
- Oxigraph의 RDF term/index 구조와 entity-to-triple ledger를 사용한다.
- 매 validated change 후 immutable domain snapshot을 재투영하고 entity별 triple
  diff를 한 store transaction으로 적용한 뒤 새 revision을 publish한다.
- index revision에 정렬된 Loro frontier를 기록하고 projection/query-profile/
  analyzer version을 코드 계약으로 고정한다.
- Step 5 index는 의도적으로 메모리 전용이다. app open마다 Loro snapshot에서
  rebuild하며, 향후 영속 cache도 동일 rebuild 경로를 fallback으로 사용한다.

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
- parser/algebra/evaluator diagnostic을 typed CorePort error로 반환한다.
- source bytes, algebra operators, binding 수, result row 예산을 적용한다. 요청은
  상한을 낮출 수만 있고 초과 시 partial result 대신 typed error를 반환한다. 실행은 LoroDoc full scan으로
  fallback하지 않으며 browser에서는 graph Worker 안에서 수행한다.

### Reactive query와 공용 search

- session revision이 바뀌면 visible query를 debounce/re-execute한다. generation
  token으로 이전 revision의 늦은 응답을 폐기한다.
- query 결과에 index revision과 Loro frontier를 포함하고 UI가 stale result를
  폐기한다.
- global search는 typed binding을 가진 SPARQL request를 생성해 동일한 query
  API를 사용한다. backlink, task list, agenda도 이 API 위에 추가한다.

### Query projection UI

- `query.source: String`이 있는 block에 inline SPARQL editor, diagnostic,
  loading/result view를 제공한다.
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
- 향후 task list/agenda는 RDF projection의 `prop:task.*` predicate를 SPARQL로
  조회하며 별도 task table/index를 만들지 않는다.
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
- hierarchy property path와 Markdown search
- incremental revision과 clean rebuild의 semantic triple/result equality
- refreshed index와 clean rebuild query 결과 비교
- native/Wasm public query shape, ordering, typed binding, diagnostic
- edit 중 stale revision 결과 폐기
- budget 초과 시 incomplete row 대신 typed error 반환

## 수동 데모

1. 여러 journal block에 project tag와 task properties를 넣는다.
2. 별도 block에 overdue todo를 찾는 `SELECT` query를 작성하고 `?today`를 typed
   binding으로 실행한다.
3. query 결과에서 task status를 `done`으로 변경한다.
4. 원본 block과 generic property inspector 값이 바뀌고 결과가 즉시 사라지는지
   본다.
5. app을 닫고 다시 열어 volatile derived index에서 동일 결과가 rebuild되는지
   확인한다.
6. task/query renderer를 feature flag로 꺼도 모든 값이 generic property로
   보존되는지 확인한다.

## 완료 조건

- [x] Loro document/update/checkpoint 외 query/search canonical 저장소가 없다.
- [x] graph 전역 query/search가 runtime에서 LoroDoc을 scan하지 않는다.
- [x] index를 버리고 다시 만든 뒤 projection과 결과가 재생산된다.
- [x] tag/task/property/hierarchy/Markdown을 한 SPARQL API로 조회할 수 있다.
- [x] SPARQL profile의 허용/거부 범위와 typed binding/result 계약이 고정된다.
- [x] refreshed index와 clean rebuild가 검증 corpus에서 같다.
- [x] native/Wasm이 같은 versioned CorePort query 계약을 제공한다.
- [x] reactive query가 partial index revision을 관찰하지 않는다.
- [x] query가 Worker에서 실행되고 bounded source/algebra/bindings/rows를 가진다.
- [x] Local MVP demo가 계정/서버 없이 재현된다.

## 이 단계에서 하지 않는 것

- server-side/federated SPARQL endpoint
- SPARQL Update 또는 RDF를 통한 graph mutation
- arbitrary JavaScript/Rust/Wasm user function
- inference/entailment regime와 외부 ontology fetch
- remote collaboration과 native-specific task notification
- persisted index cache와 field-level incremental projection
- text posting, hierarchy reachability, predicate-level query subscriptions
- elapsed-time/scan/intermediate/path-depth/memory budget와 cooperative cancellation
- SPARQL vocabulary/property/entity autocomplete
