# 08. macOS와 Android client

상태: 계획됨

## 목표

동일 React UI와 Rust core를 Tauri 2 native application으로 제공한다. native
client가 Web과 같은 domain/query/sync 결과를 내면서 각 platform의 저장소,
lifecycle, keyboard/touch 기대를 충족함을 실제 설치 artifact로 검증한다.

## 검증 가능한 딜리버러블

- macOS에서 설치·실행 가능한 app bundle
- Android emulator와 지원 device에 설치 가능한 debug APK
- 두 platform에서 local/remote graph, journal, editor, property, task, query,
  offline/reconnect workflow 동작
- Web/native 공통 fixture의 canonical state와 query result 일치

## 구현 범위

### Tauri/native CorePort

- Tauri command와 bounded event channel로 `CorePort` version 1을 구현한다.
- native Rust process에 GraphRuntime, SQLite repository, WebSocket transport를
  둔다.
- Tauri capability는 필요한 command와 resource로 최소화한다.
- panic/native error가 webview를 종료하지 않고 typed CorePort error로 변환되게
  한다.

### macOS integration

- app storage, window lifecycle, menu, keyboard shortcut, deep link 기본 동작을
  구현한다.
- quit/suspend 시 bounded flush와 dirty-unsaved 확인을 제공한다.
- credential은 Keychain-compatible secure storage adapter에 저장한다.
- unsigned development bundle과 CI signing seam을 분리한다.

### Android integration

- app-private SQLite/storage, secure credential, back navigation, safe area,
  soft keyboard, share intent adapter를 구현한다.
- pause 시 local flush하고 foreground에서 sync를 재개한다.
- background socket에 correctness를 의존하지 않는다.
- touch target, long press/drag, accessibility semantics를 모바일 viewport에서
  검증한다.

### Cross-platform UX parity

- feature detection과 adapter를 제외한 domain interaction은 shared component를
  사용한다.
- desktop keyboard와 mobile gesture가 같은 core command를 생성하게 한다.
- platform-specific presentation state를 graph property로 저장하지 않는다.

## 자동 검증 gate

```text
nix build .#macos-app
nix build .#android-debug
nix run .#test-core-port -- --adapter tauri
nix run .#test-platform-parity
nix run .#test-e2e-macos
nix run .#test-e2e-android
nix flake check
```

CI는 macOS runner에서 bundle launch test, Android emulator에서 install/launch/
pause-resume test를 실행한다. parity suite는 동일 archive를
Web/macOS/Android에서 열고 command/query corpus 후 canonical hash를 비교한다.

## 수동 데모

### macOS

1. app bundle을 설치하고 local journal/task/query workflow를 수행한다.
2. remote graph에서 Web client와 concurrent edit한다.
3. network를 끄고 app을 종료/재실행한 뒤 edit가 유지되는지 본다.
4. keyboard-only outline editing과 quit flush를 확인한다.

### Android

1. APK를 실제 device 또는 emulator에 설치한다.
2. touch/keyboard로 journal과 nested outline을 편집한다.
3. app을 background로 보내고 process reclaim을 유도한 뒤 다시 연다.
4. local state가 유지되고 foreground sync로 Web client와 수렴하는지 본다.

## 완료 조건

- [ ] macOS/Android artifact가 문서화된 target에서 설치·실행된다.
- [ ] platform parity corpus의 graph/query 결과가 Web과 같다.
- [ ] suspend/quit/process reclaim 이후 locally saved data가 유지된다.
- [ ] credential이 graph CRDT, log, 평문 app preference에 저장되지 않는다.
- [ ] Android correctness가 background network execution에 의존하지 않는다.
- [ ] keyboard/touch/accessibility로 핵심 workflow를 완료할 수 있다.

## 이 단계에서 하지 않는 것

- App Store/Google Play production signing과 제출
- native 전용 canonical data 또는 forked domain behavior
- background notification/reminder service
- iOS/Windows/Linux 지원
