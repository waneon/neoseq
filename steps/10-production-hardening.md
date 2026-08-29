# 10. Production hardening

상태: 계획됨

## 목표

기능 완성을 production readiness로 바꾼다. 실제 workload와 공격/장애 조건에서
성능, 보안, 접근성, 관찰 가능성, 복구 가능성을 측정 가능한 budget/SLO 후보로
고정한다.

## 검증 가능한 딜리버러블

release candidate가 공개된 benchmark/security/accessibility/operations gate를
통과하고, 실패 시 어떤 alert와 recovery 절차가 동작하는지 staging drill로 보여
준다. 결과는 source revision과 함께 CI artifact로 보존한다.

## 구현 범위

### 성능과 용량

- small/medium/large graph fixture와 deep/wide outline fixture를 정의한다.
- cold open, journal open, keystroke-to-paint, property edit-to-query-result,
  sync catch-up, room rehydrate, checkpoint 시간/메모리 budget을 정한다.
- Web main thread long task, Wasm/native memory, DB query/connection, queue
  depth를 측정한다.
- profiling 결과가 있는 병목만 최적화하고 index/virtualization/batching 회귀
  test를 추가한다.

### 보안

- threat model을 local storage, Web session, native credential, sync protocol,
  untrusted CRDT/archive/query, supply chain에 대해 갱신한다.
- protocol/archive/query/Loro import boundary를 fuzz한다.
- authorization isolation, revocation, rate/size limit, CSRF/XSS/CSP, Tauri
  capability, secure storage를 점검한다.
- dependency advisory/license, secret scan, SBOM, provenance를 release gate에
  넣는다.
- log/trace/metric content redaction을 automated test한다.

### 접근성과 UX resilience

- outline tree semantics, focus/selection, keyboard navigation, screen reader
  label, contrast, touch target, reduced motion을 검증한다.
- loading/offline/unsaved/auth expired/resync/schema mismatch/quarantine 상태에
  recovery action을 제공한다.
- IME, very long Markdown, deep outline, dynamic query result에서 focus loss와
  input latency를 검증한다.

### 운영

- server SLI/SLO 후보, dashboard, alert, runbook을 만든다.
- deploy, graceful shutdown, DB unavailable, slow consumer, backup restore,
  credential rotation, membership incident drill을 수행한다.
- Web/server exact-version 거부와 matched-artifact rollout/rollback을 staging에서
  검증한다.

## 목표 budget

초기 숫자는 01~09의 측정 결과로 확정한다. 구현 전 임의 숫자를 약속하지 않는다.
다만 RC gate에는 최소한 다음 percentile/fixture별 수치가 반드시 존재해야 한다.

- cold/warm graph open latency와 peak memory
- 10만/100만 block 규모의 viewport/query latency
- local keystroke-to-paint와 property edit-to-result latency
- reconnect catch-up bytes/time과 server room rehydrate time
- concurrent connection/update throughput과 bounded queue memory
- crash recovery와 backup restore 시간

## 수동 데모

1. staging에서 large graph를 Web/macOS/Android로 연다.
2. query가 실행 중인 상태에서 rapid edit, offline/reconnect, server rolling
   restart를 수행한다.
3. screen reader와 keyboard/touch로 핵심 workflow를 완료한다.
4. DB 장애와 slow consumer를 주입해 client가 local edit를 계속하고
   alert/runbook이 동작하는지 본다.
5. security/privacy review checklist에서 note content가 telemetry에 없는지 표본
   검사한다.

## 완료 조건

- [ ] 모든 performance budget이 pinned fixture/runner에서 통과한다.
- [ ] critical/high 미해결 security finding이 없다.
- [ ] 핵심 workflow의 accessibility gate와 수동 보조기술 검증이 통과한다.
- [ ] 장애가 unbounded queue, silent loss, ack 의미 위반으로 이어지지 않는다.
- [ ] dashboard/alert/runbook/restore drill이 staging에서 실제 동작한다.
- [ ] matched release artifact의 rollout/rollback이 staging에서 검증된다.

## 이 단계에서 하지 않는 것

- 검증되지 않은 premature optimization
- scope 밖 platform/iOS 지원
- E2EE를 security hardening이라는 이름으로 암묵적으로 추가하는 것
- 새로운 주요 사용자 기능
