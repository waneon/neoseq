# Step 5 검증 보고서

상태: 통과
검증 완료: 2026-08-05T13:26:22+09:00
호스트: Apple Silicon macOS (`aarch64-darwin`, Darwin 24.6.0)
기준 revision: `bd99eb77dec8` 이후 작업 트리

## 결론

LoroDoc을 유일한 canonical source of truth로 유지하면서, graph-wide read를 위한
재생산 가능한 RDF/SPARQL index를 구현했다. 각 native/Web graph runtime은
Oxigraph 기반 in-memory index를 소유하며 open 시 snapshot에서 rebuild하고,
validated edit/import 뒤 entity triple diff를 transaction으로 반영한다. query
result에는 index revision과 실제 Loro frontier가 함께 반환된다.

사용자 query 언어는 `sparql-1.1/neoseq-v1` read-only profile로 고정했다.
`SELECT`/`ASK`와 typed RDF binding을 versioned CorePort v4로 제공하고 graph 생성,
named/federated dataset, update form은 실행 전에 거부한다. source/algebra/binding/
row 예산은 요청자가 runtime ceiling보다 높일 수 없고, 초과는 partial row가 아닌
typed error가 된다. Web에서는 SPARQL이 graph
Worker 안에서 실행된다.

제품 UI에는 ordinary `query.source` property로 동작하는 inline query block,
SPARQL 기반 global search, ordinary `task.*` property를 편집하는 task projection을
추가했다. unknown task status/priority도 손실 없이 유지한다. query result는
CRDT에 저장하지 않고 session revision에 따라 debounce 재실행하며 stale generation을
폐기한다.

## 검증 gate

| Gate | 결과 | 핵심 증거 |
| --- | --- | --- |
| `nix run path:.#test-query-projection` | 통과 | entity/relation/property/tag/default RDF projection |
| `nix run path:.#test-query-rebuild` | 통과 | refreshed index와 clean rebuild triple equality |
| `nix run path:.#test-query-conformance` | 통과 | typed binding/metadata, 허용·거부 profile |
| `nix run path:.#test-query-differential` | 통과 | refreshed/rebuilt query result equality |
| `nix run path:.#test-query-budget` | 통과 | typed budget error, partial row 없음 |
| `NEOSEQ_PLAYWRIGHT_PORT=4185 nix run path:.#test-e2e-web -- --grep query-task` | 통과 | 실제 Wasm Worker/IndexedDB, desktop + mobile 2 tests |
| `nix develop -c pnpm --filter @neoseq/client check` | 통과 | TypeScript contract/UI type check |
| `nix flake check path:.` | 통과 | fmt, clippy, Rust 32 tests, generated drift, licenses, Web/component/bundle gates |

Browser 수동 확인에서는 query block의 live SELECT 결과, task native controls,
SPARQL global search, narrow viewport layout을 확인했다. `#page-content` axe 검사에서
accessibility violation은 0건이었다.

## 고정된 계약과 예산

| 항목 | 값 |
| --- | --- |
| Query language/profile | `sparql-1.1/neoseq-v1` |
| Projection/profile/analyzer version | `1` / `1` / `1` |
| CorePort contract version | 4 |
| Canonical graph store | LoroDoc only |
| Derived index | per-open-graph Oxigraph in-memory store |
| Rust workspace tests | 32 |
| Client component tests | 35 |
| Focused Web E2E | 2 (desktop + mobile) |
| JS bundle gzip | 176,470 / 262,144 bytes |
| CSS bundle gzip | 10,467 / 32,768 bytes |
| Wasm raw | 3,917,214 / 4,194,304 bytes |
| Wasm gzip | 1,226,871 / 1,468,006 bytes |

## 설계 확인 사항

- RDF entity IRI는 graph와 entity ID를 percent-encoded component로 포함하며 blank
  node를 만들지 않는다. page/block/tag, hierarchy, tags, ordinary/default property와
  다섯 value type을 한 default graph에 투영한다.
- binding은 query string interpolation이 아니라 SPARQL algebra의 initial `VALUES`
  row로 주입한다. result의 IRI/literal/unbound 형태와 entity metadata는 CorePort
  JSON contract에 명시되어 있다.
- index는 Step 5에서 의도적으로 영속화하지 않는다. 따라서 cache가 canonical
  graph와 어긋나는 상태 자체를 만들지 않으며, 매 open마다 동일 rebuild 경로를
  사용한다.
- current reactive path는 정확성을 우선해 visible query를 session revision마다
  보수적으로 invalidate한다. predicate-level subscription은 결과 계약을 바꾸지
  않는 후속 최적화다.
- text posting, hierarchy reachability, field-level projection, persisted cache와
  time/scan/intermediate/path-depth/memory/cancellation budget은 Step 10 hardening
  범위로 명시했다.

## 재현 방법

```sh
nix run .#test-query-projection
nix run .#test-query-rebuild
nix run .#test-query-conformance
nix run .#test-query-differential
nix run .#test-query-budget
NEOSEQ_PLAYWRIGHT_PORT=4185 nix run .#test-e2e-web -- --grep query-task
nix build .#web
nix flake check
```

`path:.`는 커밋 전 새 fixture까지 Nix source에 포함하기 위해 사용했다. 커밋 뒤에는
일반 `.` flake reference로 같은 gate를 실행할 수 있다.
