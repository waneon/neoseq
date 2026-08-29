# 11. Release candidate와 배포

상태: 계획됨

## 목표

검증된 source revision을 재현 가능한 Web/server artifact와 설치 가능한
macOS/Android artifact로 승격한다. build, signing, deployment, rollout, rollback,
artifact provenance를 한 release manifest로 연결한다.

## 검증 가능한 딜리버러블

- immutable Web static artifact와 배포 manifest
- versioned sync server image, DB baseline schema, SBOM, provenance
- 서명/notarize된 macOS application artifact
- 서명된 Android AAB와 설치 검증용 APK
- protocol/schema/CorePort/query/property-definition version이 포함된 release
  manifest
- staging 배포, smoke test, rollback 결과
- 사용자용 data/export/privacy/known-limit 문서

## 구현 범위

### Version과 artifact

- application/source revision, target, Rust/Node/Loro version, CRDT schema
  version, CorePort, sync protocol, RDF projection, SPARQL profile, text analyzer,
  property registry version을 embed한다.
- build output과 platform signing 결과를 checksum으로 연결한다.
- SBOM, dependency license, provenance attestation을 생성한다.
- release artifact는 다시 build하지 않고 검증된 CI output을 승격한다.

### Platform delivery

- Web asset에 content hash, CSP, cache/rollback 전략을 적용한다.
- server image와 새 PostgreSQL baseline 적용 순서를 정의한다.
- macOS codesign/notarization과 update metadata를 검증한다.
- Android release signing, AAB validation, supported SDK/ABI manifest를
  검증한다.
- credential은 CI secret store에서만 주입하고 log나 build output에 남기지 않는다.

### Rollout

- 정확히 일치하는 server/Web/native artifact를 한 release 단위로 배포한다.
- protocol/schema 불일치는 명시적으로 거부하고 사용자에게 upgrade action을 제공한다.
- canary/staging smoke에서 create/edit/query/offline/reconnect/export/restore를
  실행한다.
- rollback이 DB/schema를 손상시키지 않는 범위를 명시하고 실제 연습한다.

### 사용자 문서

- local/remote graph 차이, offline/sync indicator, export/backup,
  account/membership, data deletion, known limits를 문서화한다.
- v1이 end-to-end encrypted가 아니라는 점과 server data boundary를 명시한다.
- 지원 OS/browser/device와 upgrade policy를 공개한다.

## 수동 데모

1. staging에 release artifact 그대로 server/Web을 배포한다.
2. clean browser, macOS, Android에 client를 설치한다.
3. local graph와 remote graph에서 Local MVP 및 Remote beta 시나리오를 반복한다.
4. protocol/schema가 일치하지 않는 client가 명시적으로 거부되는지 확인한다.
5. canary rollback 후 local edit와 remote sync가 계속 가능한지 확인한다.
6. archive export/import와 account/membership revoke/delete 문서를 따라
   검증한다.

## 완료 조건

- [ ] 모든 artifact가 하나의 source revision과 release manifest로 추적된다.
- [ ] 서명, notarization, package validation이 지원 platform에서 통과한다.
- [ ] staging smoke/rollback과 exact-version 검증이 통과한다.
- [ ] DB baseline 적용 실패 시 서비스가 listen하지 않고 recovery 절차가 동작한다.
- [ ] release artifact에 credential/debug endpoint/test issuer가 포함되지
      않는다.
- [ ] privacy/data/export/known-limit 문서가 제품 동작과 일치한다.
- [ ] 출시 후 관찰 dashboard, alert owner, rollback authority가 지정된다.

## v1 이후로 명시적으로 미루는 항목

- end-to-end encryption과 client-managed key recovery
- iOS/Windows/Linux native package
- multi-region active-active synchronization
- arbitrary user code/Wasm query extension
- 외부 format/plugin ecosystem과 native background reminder
