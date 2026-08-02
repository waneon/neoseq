# 04. Local-first Web application

상태: 계획됨

## 목표

03의 browser CorePort 위에 실제 note-taking workflow를 제공한다. 사용자는 계정과
서버 없이 Web app에서 graph를 만들고 journal, outliner, Markdown, uniform
property를 사용할 수 있어야 한다.

## 검증 가능한 딜리버러블

production Web build를 정적 server에서 열어 다음 시나리오를 수행할 수 있다.

- local graph 생성/열기/이름 변경/명시적 삭제
- 오늘 journal 자동 ensure와 날짜별 journal 이동
- root/child block 생성, Markdown 입력, indent/outdent/move/delete, undo/redo
- generic property editor로 다섯 value type 편집
- page autocomplete를 통한 반복 `tag` property 추가/삭제
- page default 설정 후 tag 추가 시 누락 property 자동 복사
- reload와 offline 상태에서도 동일 graph 계속 편집
- local saved 상태와 storage/quota 문제 표시

## 구현 범위

### Application shell

- React/Vite routing, graph picker, page route, journal route, settings shell을
  만든다.
- UI는 `CorePort`만 호출하며 Loro/IndexedDB/Worker를 직접 import하지 않는다.
- Service Worker는 application shell만 cache하고 canonical graph를 소유하지
  않는다.

### Outliner editor

- stable `BlockId` 기반 virtualized tree를 구현한다.
- keyboard와 touch에 공통인 command mapping을 정의한다.
- Markdown 입력과 IME composition boundary를 보존해 core edit command로
  전달한다.
- remote update가 아직 없는 이 단계에서도 authoritative event reconciliation을
  사용해 이후 collaboration과 같은 state path를 탄다.
- focus/selection을 stable ID로 유지하고 undo/redo 상태를 표시한다.

### Generic property experience

- value type별 editor와 validation error를 제공한다.
- single/repeated/unknown property를 같은 list/editor에서 표시한다.
- `tag`는 page reference autocomplete와 chip UI를 제공하지만 generic property
  entry로도 읽고 수정할 수 있다.
- page properties와 default bag을 별도 section으로 보여 주되 같은 component를
  재사용한다.

### Journal과 navigation

- user IANA timezone에서 `LocalDate`를 계산해 `EnsureJournal`을 호출한다.
- route identity는 `PageId`, 제목은 `page.title` property hint로 사용한다.
- deleted/missing page reference는 새 page를 만들지 않고 tombstone UI를 보여
  준다.

## 자동 검증 gate

```text
nix build .#web
nix run .#test-client-components
nix run .#test-e2e-web -- --project chromium
nix run .#test-e2e-web -- --project mobile-chromium
nix flake check
```

Web E2E는 실제 Worker와 IndexedDB를 사용하고 다음을 포함한다.

- graph 생성 → journal 작성 → reload → 동일 내용 확인
- deep outline keyboard 이동과 subtree reorder
- 한글/조합형 IME composition 중 block command가 끼어들지 않음
- 모든 property type 편집과 unknown key fallback
- tag default가 기존 property를 덮어쓰지 않음
- browser offline 전환 후 수정/재시작
- IndexedDB 실패 시 unsaved 상태와 recovery action 표시

## 수동 데모

1. 새 browser profile에서 Web app을 연다.
2. 계정이나 server 설정 없이 local graph와 오늘 journal을 만든다.
3. 3단계 outline과 Markdown note를 입력한다.
4. project page를 만들고 default `task.status: todo`를 설정한다.
5. journal block에 project tag를 붙여 task status가 property로 복사되는지
   확인한다.
6. network를 끄고 reload한 뒤 계속 편집한다.

## 완료 조건

- [ ] 사용자 시나리오가 browser UI만으로 끝까지 가능하다.
- [ ] UI state store에 canonical page/block/property 복제본이 생기지 않는다.
- [ ] Markdown 외 기능 데이터가 generic property inspector에서 모두 보인다.
- [ ] keyboard-only로 outline과 property editor의 주요 기능을 사용할 수 있다.
- [ ] reload/offline 후 acknowledged local state가 유지된다.
- [ ] production bundle budget과 basic accessibility audit가 통과한다.

## 이 단계에서 하지 않는 것

- query 실행과 task 전용 renderer
- remote graph, login, presence
- macOS/Android package와 platform integration
- 최종 visual polish와 전체 WCAG audit
