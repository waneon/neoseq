# Step 4 검증 보고서

상태: 통과  
검증 완료: 2026-08-03T17:23:12+09:00  
호스트: Apple Silicon macOS (`aarch64-darwin`, Darwin 24.6.0)  
기준 revision: `d59b801445bc` 이후 작업 트리

## 결론

03의 browser CorePort 위에 local-first Web app을 구현했다. 사용자는 계정과
서버 없이 graph를 만들고 오늘 journal을 자동으로 얻으며, virtualized outliner,
Markdown 편집, 다섯 value type의 uniform property, page-backed tag와 default
복사를 browser UI만으로 사용한다. UI는 `CorePort`(+ adapter-level worker
operation)만 호출하고, 모든 상태 변화는 command → event drain → 스냅샷 재독의
단일 경로를 탄다. UI state store에 canonical 복제본은 없다.

reload/offline 재시작 후에도 acknowledged local state가 유지된다. Service
Worker는 build 시 생성되어 application shell(HTML/JS/CSS/Wasm)만 precache하고
canonical data는 소유하지 않는다. IndexedDB 실패는 unsaved 상태와 Retry
action으로 표시되고, quota 소진은 typed `storage_full` 상태로 구분된다. 두
번째 탭은 Web Locks lease를 얻지 못하면 read-only로 열린다.

## 검증 gate

| Gate | 결과 | 핵심 증거 |
| --- | --- | --- |
| `nix build .#web` | 통과 | production 정적 번들 + 생성된 `sw.js` |
| `nix run .#test-client-components` | 통과 | fake CorePort 기반 component 19 tests |
| `nix run .#test-e2e-web -- --project chromium` | 통과 | 제품 시나리오 18 tests |
| `nix run .#test-e2e-web -- --project mobile-chromium` | 통과 | 동일 시나리오 17 tests (Pixel 7 프로파일) |
| `nix run .#test-persistence -- --adapter indexeddb` | 통과 | step 3 회귀 |
| `nix run .#test-core-port -- --adapter web-worker` | 통과 | step 3 회귀 |
| `nix run .#test-recovery` | 통과 | step 3 회귀 |
| `nix flake check` | 통과 | fmt, clippy, Rust 27 tests, generated drift, web, client-components, bundle-budget |

Web E2E는 실제 dedicated Worker와 IndexedDB를 사용하며 다음을 포함한다.

- graph 생성 → journal 작성 → reload → 동일 내용 확인, 날짜별 journal 이동
- graph 이름 변경과 명시적 삭제, 두 번째 탭 read-only lease
- 3단계 outline keyboard 구성(Enter/Tab/Shift+Tab), caret split, Alt+Arrow
  subtree reorder, collapse, undo/redo, touch용 block menu 명령
- 한글 조합형 IME composition 중 Enter(keyCode 229)가 block command로
  끼어들지 않고 boundary에서만 core로 전달됨
- 다섯 value type 전부 + unknown key fallback 편집, reload 후 유지, 잘못된
  default에 대한 validation error 표시
- tag default 복사: 누락 key만 복사, 기존 block 값은 덮어쓰지 않음, chip
  제거 후에도 복사된 property는 ordinary property로 유지
- deleted page reference의 tombstone 해석과 복원(대체 page 자동 생성 없음)
- browser offline 전환 후 편집·재시작·재편집, 온라인 복귀 후 동일 상태
- IndexedDB abort → unsaved 상태 + Retry로 정확한 pending bytes 재영속,
  quota → `storage_full` typed 상태
- 모든 시나리오에서 외부 hostname request 0건
- axe(wcag2a/wcag2aa) 기준 serious/critical violation 0건
  (picker/journal/outline/inspector/settings)

## 고정된 계약과 예산

| 항목 | 값 |
| --- | --- |
| CorePort contract version | 1 (변경 없음, drift check 통과) |
| Worker adapter-level operations | 3 (`retry_pending`, `list_graphs`, `delete_graph`) |
| Property registry 소스 | `fixtures/core/property-definitions-v1.json` (client가 직접 import) |
| Component tests | 19 |
| Web E2E tests | chromium 18 + mobile-chromium 17 (+ step 3 corpus 3) |
| JS bundle (gzip) | 122,390 bytes / 예산 262,144 |
| CSS bundle (gzip) | 3,494 bytes / 예산 32,768 |
| Wasm core (gzip) | 1,311,697 bytes / 예산 2,097,152 |

## 설계 확인 사항

- Journal identity는 core가 소유한다: UI는 IANA timezone으로 `LocalDate`를
  계산해 idempotent `EnsureJournal`을 호출하고, page는 `journal.date`
  property로 찾는다. Client는 journal PageId hash를 복제하지 않는다.
- Enter의 block 삽입만 optimistic이다(pending row). inverse(행 제거)가
  알려져 있고, 연쇄 Enter/Tab/타이핑은 실제 BlockId 확정 후 순서대로
  재생된다. 그 외 구조 명령과 모든 텍스트는 authoritative 스냅샷 경로만 탄다.
- 삭제된 page는 core 스냅샷에서 제외되므로 UI tombstone은 "삭제 또는 미존재"
  를 구분하지 않고 복원 시도를 core 판정에 맡긴다(존재하지 않으면 오류 표시).
- 접근성: outline은 tree/treeitem/aria-level/aria-expanded를 노출하고 주요
  기능이 keyboard-only로 동작한다. 전체 WCAG audit는 step 10 범위다.

## 재현 방법

```sh
nix build .#web
nix run .#test-client-components
nix run .#test-e2e-web -- --project chromium
nix run .#test-e2e-web -- --project mobile-chromium
nix run .#test-persistence -- --adapter indexeddb
nix run .#test-core-port -- --adapter web-worker
nix run .#test-recovery
nix flake check
```

수동 데모: `nix build .#web` 결과(`result/share/neoseq-web`)를 임의의 정적
server로 열고 steps/04 문서의 6단계 시나리오를 수행한다. 본 검증에서는 실제
Chromium으로 graph 생성 → journal 작성 → project page default(`task.status:
todo`) 설정 → journal block tag 부착 시 property 복사 → reload/offline 편집을
확인했다.
