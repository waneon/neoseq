# Step 3 검증 보고서

상태: 통과  
검증 완료: 2026-08-03T11:59:35+09:00  
호스트: Apple Silicon macOS (`aarch64-darwin`, Darwin 24.6.0)  
기준 revision: `1a9c53dcc519` 이후 작업 트리

## 결론

SQLite와 IndexedDB에 동일한 local repository 계약을 구현하고, 재시작·부분
실패·손상 tail 복구를 검증했다. CorePort v1의 다섯 operation과 13개 안정 오류
code는 Rust/TypeScript 생성 타입 및 golden fixture로 고정했다. Native는 SQLite
WAL runtime을 in-process로 열고, browser는 같은 Wasm core와 IndexedDB를 dedicated
Worker 안에서 실행한다.

저장 성공 전에 `saved_locally` event가 나타나지 않으며, 실패한 exact update
bytes는 dirty 상태로 보존되어 retry된다. 복구는 newest valid checkpoint와 연속된
checksum-valid tail만 적용하고, 손상 record와 그 이후 record를 삭제하지 않은 채
export 가능한 quarantine에 둔다.

## 검증 gate

| Gate | 결과 | 핵심 증거 |
| --- | --- | --- |
| `nix run .#test-persistence -- --adapter sqlite` | 통과 | restart, append/checkpoint/storage fault, corrupt tail, delete 6 tests |
| `nix run .#test-persistence -- --adapter indexeddb` | 통과 | repository restart와 browser fault corpus 2 tests |
| `nix run .#test-core-port -- --adapter native` | 통과 | golden transcript, overflow, unsupported schema 3 tests |
| `nix run .#test-core-port -- --adapter web-worker` | 통과 | Worker adapter golden contract 1 test |
| `nix run .#test-recovery` | 통과 | native recovery 2 tests와 browser recovery 1 test |
| `nix build .#core-native` | 통과 | SQLite/CorePort를 포함한 native 산출물 생성 |
| `nix build .#core-wasm` | 통과 | Worker에서 사용하는 Wasm core 산출물 생성 |
| `nix flake check` | 통과 | fmt, strict Clippy, 27 Rust tests, license, generated drift, web |

Darwin browser gate는 browser host service가 필요한 실행을 Nix로 조립한
self-contained harness에 담은 뒤 host에서 실행한다. `test-persistence`,
`test-core-port`, `test-recovery` 명령은 이 플랫폼 경계를 내부에서 처리하며,
local-only Playwright scenario는 외부 hostname으로 나간 request가 없음을 함께
검사한다.

## 고정된 계약

| 항목 | 값 |
| --- | --- |
| CorePort contract version | 1 |
| Operations | 5 (`open_graph`, `execute`, `read`, `subscribe`, `close_graph`) |
| Stable error codes | 13 |
| SQLite schema | version 1, 6 tables |
| IndexedDB schema | version 1, 6 object stores |
| Rust workspace tests | 27 |
| CorePort contract SHA-256 | `288724814ecefa810f325602b19a3566ba2939e57bd13e483c38b5477b5138e5` |
| CorePort golden SHA-256 | `ab5a2cc7126fd2efc211e7478fb0bc69af4c56ee9f811e94cce3df1f5b49525a` |

## Fault와 recovery 증거

- Append before-commit failure는 runtime을 dirty로 남기고 saved event를 내지
  않는다. After-commit failure의 retry는 checksum deduplication으로 같은 local
  sequence를 반환한다.
- Abrupt runtime/Worker 종료 뒤 acknowledged update를 다시 열면 동일 snapshot을
  얻는다.
- Truncated update와 checksum mismatch는 마지막 valid state까지 복구되고 stable
  export handle과 원본 bytes를 quarantine에 남긴다.
- Checkpoint publish 전/후 실패를 각각 주입하며, after-commit retry에도 valid
  checkpoint가 중복되지 않는다.
- SQLite busy/disk-full과 IndexedDB abort/quota는 stable typed error로 노출된다.
- Unsupported repository schema, subscription overflow, command timeout,
  dirty-unsaved 상태를 CorePort error code로 구분한다.
- Diagnostic binary export는 transferable `ArrayBuffer`로 Worker 경계를 넘는다.

## 재현 방법

```sh
nix run .#test-persistence -- --adapter sqlite
nix run .#test-persistence -- --adapter indexeddb
nix run .#test-core-port -- --adapter native
nix run .#test-core-port -- --adapter web-worker
nix run .#test-recovery
nix build .#core-native
nix build .#core-wasm
nix flake check
```
