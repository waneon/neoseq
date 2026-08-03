# Step 2 검증 보고서

상태: 통과  
검증 완료: 2026-08-03T11:30:07+09:00  
호스트: Apple Silicon macOS (`aarch64-darwin`, Darwin 24.6.0)  
기준 revision: `3289c4b38b5f` 이후 작업 트리

## 결론

UI와 영속 저장소에 의존하지 않는 domain/CRDT core를 구현했다. Schema v1은
page map, movable outline tree, Markdown text, uniform `PropertyBag`으로 고정되며,
raw Loro container는 public domain API 밖으로 노출되지 않는다. YAML scenario의
두 offline peer는 update를 역순·중복 import한 뒤 같은 canonical snapshot과
fingerprint로 수렴했다.

## 검증 gate

| Gate | 결과 | 핵심 증거 |
| --- | --- | --- |
| `nix build path:.#core-native path:.#core-wasm` | 통과 | 두 target의 schema v1 core 산출물 생성 |
| `nix run path:.#test-domain` | 통과 | opaque ID/date와 registry/fixture 계약 6 tests |
| `nix run path:.#test-core-model` | 통과 | round-trip, undo, quarantine, runtime/scenario 6 tests |
| `nix run path:.#test-core-convergence` | 통과 | 저장 seed 5개와 생성 seed 48개 |
| `nix run path:.#core-scenario -- fixtures/core/basic.yaml` | 통과 | 2 peers, 4 pages, 33 events, quarantine 0 |
| `nix run path:.#spike-cross-runtime` | 통과 | native/Wasm canonical scenario bytes 동일 |
| `nix flake check path:.` | 통과 | fmt, strict Clippy, 16 Rust tests, license, generated drift, web |
| Darwin host Playwright | 통과 | IndexedDB/Worker restart 1 test passed |

Playwright browser process는 macOS의 Nix build sandbox 안에서 필수 host service에
접근하지 못해 `SIGTRAP`으로 종료된다. 따라서 Linux CI는 이를 sandboxed flake
check로 유지하고, Darwin은 같은 테스트를 `nix develop` devShell에서 실행한다.
이 플랫폼 경계는 `architectures/build.md`에 명시했다.

## 결과 값

| 항목 | 값 |
| --- | --- |
| Canonical graph fingerprint | `56ae202f64b975920393e1dd0da3b413d82d5bbf0111a9edb769c627be2836ac` |
| Native/Wasm scenario SHA-256 | `e1dd61458b8c9b5e2437f834b9bc96e0c0c9227da27bb67cfd9ca2edece28092` |
| Saved convergence seeds | `0x0200000001`, `0x0200000002`, `0x0200000042`, `0x02c0decafe`, `0x02deadbeef` |
| Generated convergence seeds | 48 (deterministic LCG from `0x025eedf00d`) |
| Scenario | 2 peers, 4 pages, 33 semantic events, 0 quarantined entries |

## 검증된 계약

- The five property value types and single/repeated/unknown entries survive
  canonical round-trips without loss.
- Well-known task, query, page, journal, block, tag, and system contracts match
  `fixtures/core/property-definitions-v1.json`.
- Tag defaults materialize atomically, never overwrite existing values, and do
  not change retroactively.
- Local undo grouping does not undo imported remote work; bounded event cursors
  return `ResyncRequired` after history eviction.
- Projection rejects or deterministically quarantines invalid properties,
  dangling page roots, cycles, and invalid root ownership.
- Randomized tests cover concurrent Markdown edits, moves, delete/move races,
  single and repeated property races, journal ensure, tag defaults, reordered
  delivery, and duplicate imports.

## 재현 방법

```sh
nix build .#core-native .#core-wasm
nix run .#test-domain
nix run .#test-core-model
nix run .#test-core-convergence
nix run .#core-scenario -- fixtures/core/basic.yaml
nix run .#spike-cross-runtime
nix flake check
# Darwin only: browser execution requires host services outside the Nix sandbox.
nix develop -c pnpm --filter @neoseq/client test:indexeddb
```
