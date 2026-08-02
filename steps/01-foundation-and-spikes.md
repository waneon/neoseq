# 01. 재현 가능한 기반과 기술 위험 스파이크

상태: 계획됨

## 목표

제품 기능을 본격 구현하기 전에 가장 비싼 아키텍처 가정이 실제 target에서
성립함을 증명한다. 이 단계의 결과는 “Hello World가 실행된다”가 아니라, 이후 모든
단계가 사용할 재현 가능한 workspace와 실패 원인을 식별할 수 있는 feasibility
report다.

## 검증 가능한 딜리버러블

깨끗한 checkout에서 Nix 명령만으로 다음 결과를 만든다.

1. pinned Rust workspace와 React/Vite/Tauri workspace가 build된다.
2. 같은 Rust 함수와 pinned Loro가 native와 `wasm32-unknown-unknown`에서
   실행된다.
3. 최소 Loro document를 SQLite와 IndexedDB에 저장하고 process/page reload 후
   같은 state를 읽는다.
4. native peer와 Wasm peer가 test WebSocket relay를 통해 서로 다른 update를
   교환하고 같은 state로 수렴한다.
5. 동일 frontend/core ping이 macOS app bundle과 Android debug APK에 포함된다.
6. 모든 도구/의존성/version/host exception이 machine-readable manifest에 남는다.

스파이크 코드는 제품 domain API로 승격하지 않는다. 재사용할 코드는 정식 crate
경계와 test로 이동하고, 나머지는 `spikes/` 또는 CI fixture로 격리한다.

## 구현 범위

### Nix와 workspace

- `flake.nix`, `flake.lock`, `Cargo.toml`, `Cargo.lock`, `pnpm-workspace.yaml`,
  `pnpm-lock.yaml`을 생성한다.
- `domain`, `graph-core`, `query`, `platform-native`, `platform-web`,
  `sync-protocol`, `sync-server` crate와 `apps/client` shell을 만든다.
- Rust toolchain, Wasm target/bindgen, Node/pnpm, PostgreSQL client, Tauri CLI,
  JDK/Android SDK/NDK를 pin한다.
- macOS Xcode/SDK는 Nix 외부 host input으로 검사하고 version mismatch를 명확히
  실패시킨다.
- format/lint/license/generated-drift를 포함하는 최소 `nix flake check`를
  만든다.

### 계약 뼈대

- `CorePort` version handshake와 `ping` DTO 하나를 schema에서 Rust/TypeScript로
  생성한다.
- `sync-protocol`에는 spike 전용 hello/update/ack만 두고 정식 protocol로
  간주하지 않는다.
- native와 Web Worker adapter가 동일 contract test를 통과하게 한다.

### 위험 스파이크

- pinned Loro version의 movable tree, text, map, snapshot/update export/import를
  native/Wasm에서 왕복한다.
- browser IndexedDB adapter가 Wasm/Worker 경계를 넘는 binary buffer를 유실 없이
  저장하는지 확인한다.
- SQLite WAL 저장과 crash 직전 update replay를 최소 fixture로 확인한다.
- Tauri 2로 macOS unsigned bundle과 Android debug APK를 실제 생성한다.
- relay가 update를 reorder/duplicate해도 두 Loro peer가 수렴하는지 확인한다.

## 자동 검증 gate

완료 시 다음 명령이 제공되고 성공해야 한다.

```text
nix flake check
nix build .#core-native
nix build .#core-wasm
nix build .#web
nix build .#macos-smoke
nix build .#android-debug
nix run .#spike-cross-runtime
nix run .#spike-persistence
nix run .#spike-sync
```

CI는 Linux fast/Wasm check, macOS bundle check, Android APK check를 별도
runner에서 실행한다. 생성 artifact에는 source revision과 toolchain manifest가
포함되어야 한다.

## 수동 데모

1. 문서에 적힌 한 명령으로 Web spike를 실행한다.
2. browser에서 native와 동일한 fixture hash를 확인한다.
3. page를 reload하고 IndexedDB에 저장한 값이 유지되는지 확인한다.
4. macOS bundle을 실행해 core version을 확인한다.
5. Android emulator에 APK를 설치해 같은 core version을 확인한다.

## 완료 조건

- [ ] native/Wasm state fixture hash가 동일하다.
- [ ] SQLite/IndexedDB 재시작 왕복이 모두 통과한다.
- [ ] reorder/duplicate된 update 교환 후 peer state가 동일하다.
- [ ] macOS bundle과 Android APK가 실제 target에서 시작된다.
- [ ] Nix 외부 입력과 재현성 한계가 report에 기록된다.
- [ ] 실패한 가정이 있다면 adapter 대안과 아키텍처 문서가 함께 갱신된다.
- [ ] spike의 임시 protocol/domain 타입이 정식 API로 누출되지 않는다.

## 이 단계에서 하지 않는 것

- 완전한 domain model과 editor UI
- production authentication 또는 PostgreSQL update log
- production signing/notarization/Play 배포
- 성능 최적화와 최종 디자인 시스템
