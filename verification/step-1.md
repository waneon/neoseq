# Step 1 검증 보고서

상태: 통과  
검증 완료: 2026-08-03T00:40:11+09:00  
호스트: Apple Silicon macOS (`aarch64-darwin`, Darwin 25.5.0)  
기준 revision: `c104e5202fdb` 이후 작업 트리 (`source_revision: dirty`)

## 결론

Step 1의 재현 가능한 workspace와 기술 위험 spike를 구현하고 실제 target에서
검증했다. native와 Wasm은 같은 Loro 문서 의미 상태를 만들고, SQLite와
IndexedDB는 재시작 경계를 통과하며, WebSocket relay가 update를 역순·중복
전달해도 두 runtime은 수렴한다. 같은 frontend와 Rust core를 포함한 macOS
bundle 및 Android APK도 실제로 시작됐다.

## 검증 gate

| Gate | 결과 | 핵심 증거 |
| --- | --- | --- |
| `nix flake check path:.` | 통과 | fmt, strict Clippy, Rust tests, license, generated drift, web build, Playwright |
| `nix build path:.#core-native` | 통과 | native fixture 및 SQLite 실행 파일 생성 |
| `nix build path:.#core-wasm` | 통과 | `wasm32-unknown-unknown` Loro core 생성 |
| `nix build path:.#web` | 통과 | React/Vite production bundle과 Worker/Wasm 생성 |
| `nix run path:.#spike-cross-runtime` | 통과 | native/Wasm fixture hash 동일 |
| `nix run path:.#spike-persistence` | 통과 | SQLite WAL update 1개 replay, IndexedDB Worker 재시작 |
| `nix run path:.#spike-sync` | 통과 | 실제 WebSocket relay의 역순·중복 frame 이후 수렴 |
| `nix build path:.#macos-smoke` | 통과 | unsigned `.app` 생성 및 프로세스 3초 생존 확인 |
| `nix build path:.#android-debug` | 통과 | 순수 Nix sandbox와 Gradle replay cache에서 APK 생성 |
| `nix run path:.#android-emulator-smoke` | 통과 | Android 36 ARM64 부팅, streamed install, `MainActivity` 시작 |
| `scripts/check-macos-host.sh` | 통과 | CLT, SDK, Clang host input 확인 |

로컬 `nix flake check`는 현재 호스트인 `aarch64-darwin` checks를 실행했다.
Linux checks와 Android APK build를 실행하는 GitHub Actions job도 별도로 정의했다.

## 결과 값

| 항목 | 값 |
| --- | --- |
| Loro native/Wasm fixture SHA-256 | `b5432be2f430f0d1a16ea9600ff1fc4653995bc2d84a4a95ff56637c5d5ff23f` |
| WebSocket 수렴 SHA-256 | `d9a6ce3bdc7fcb0eadbb46e5a818c3055afc150dd15a8bfb201ca5124e2b8970` |
| SQLite replay state SHA-256 | `33312a8e286a3437f75b7a8249d6d8d3840edd73562708085037e73428701b45` |
| 최종 Android APK SHA-256 | `71d420d31038b465c892bbf560564c33757142c66a8affea360c70b92b6eaae7` |
| 최종 macOS executable SHA-256 | `12092f20954ab13eb640e81d2f0e6c938fa2c724af8b275669192029f30dde0e` |
| Android package/activity | `dev.neoseq.step1` / `.MainActivity` |
| Android ABI / compile SDK | `arm64-v8a` / 36 |

브라우저 검증은 실제 production Worker/Wasm을 로드해 binary snapshot을
transferable `ArrayBuffer`로 넘기고 IndexedDB에 저장한 뒤, Worker와 page를
재시작해 같은 hash를 확인했다. Playwright 결과는 1 test passed다.

## 확인된 아키텍처 가정

- Loro 1.13.7의 text, map, movable tree, snapshot 및 update import/export가
  native와 Wasm에서 동일한 의미 상태를 만든다.
- SQLite adapter는 WAL checkpoint와 미반영 update를 구분해 재개 시 update를
  replay할 수 있다. 브라우저 adapter는 Worker와 IndexedDB 경계에서 binary를
  보존한다.
- spike relay는 Loro payload를 해석하지 않고 binary frame을 relay한다. frame의
  역순 및 중복 전달은 최종 상태 수렴을 깨지 않는다.
- `CorePort` schema에서 Rust와 TypeScript 계약을 생성하고 drift를 자동 검사한다.
  Tauri command와 Wasm Worker는 같은 contract version을 노출한다.
- spike 전용 hello/update/ack와 fixture 타입은 `sync-protocol` 및 테스트 실행
  경계에 머물며 제품 domain 모델로 승격되지 않았다.

실패한 제품 아키텍처 가정은 없었다. 구현 중 발견한 build adapter 제약은 flake에
반영했다. Android Gradle Plugin은 preference root 변수를 하나만 허용하므로
`ANDROID_USER_HOME`만 설정한다. Gradle과 Maven 입력은 해시가 기록된 replay
cache로 sandbox에 공급한다. VCS metadata(`.git`, `.jj`)와 로컬 환경 디렉터리는
Nix source에서 제외했다. Cargo source 역시 이 filtered source에서 파생하며,
`jj status` 전후 Android/macOS derivation 경로가 동일함을 확인했다.

## 재현성 경계

flake, Cargo, pnpm lock과 Gradle dependency hash가 Rust/Node/Wasm/Android 도구 및
의존성을 고정한다. 각 산출물에는 JSON toolchain manifest가 포함된다. 이번 작업은
commit 전 작업 트리에서 검증했으므로 manifest의 source revision은 `dirty`다.
깨끗한 checkout/CI에서는 실제 commit revision이 기록된다.

Nix 밖의 입력은 다음뿐이다.

- macOS Command Line Tools: `/Library/Developer/CommandLineTools`
- macOS SDK: 26.2
- Apple Clang: 17.0.0 (`clang-1700.6.3.2`)
- Android emulator 실행을 위한 Apple M3 Pro 하드웨어 가상화/GPU

Apple signing/notarization, Android release signing, 실제 기기, secret은 이 단계의
재현성 범위 밖이다.

## 알려진 제약

- macOS 산출물은 unsigned smoke bundle이고 Android 산출물은 ARM64 debug APK다.
- Tauri 2.11.5 생성 Android 코드와 Gradle 8.14.3에는 deprecated API 경고가 있다.
  프로젝트 코드의 lint/test gate는 통과했으며 이 경고는 packaging 실패가 아니다.
- Android plugin의 analytics 경로는 sandbox에서 쓸 수 없어 metrics 초기화 경고가
  나지만 metrics는 build output에 필요하지 않다.
- emulator smoke runner는 Activity 시작 성공 후 임시 emulator를 종료한다.

## 재현 방법

깨끗한 checkout에서는 문서의 명령에서 `path:.` 대신 `.`을 사용해도 된다.

```sh
nix flake check
nix build .#core-native .#core-wasm .#web
nix run .#spike-cross-runtime
nix run .#spike-persistence
nix run .#spike-sync
nix build .#macos-smoke
nix build .#android-debug
nix run .#android-emulator-smoke
```

Web spike를 직접 보려면 다음 한 명령을 실행하고 출력된 local URL을 연다.

```sh
nix develop -c pnpm --filter @neoseq/client dev
```
