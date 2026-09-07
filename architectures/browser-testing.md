# Browser Verification Architecture

## Boundaries

Browser verification proves assembled product behavior and browser adapter
contracts. Rust tests own domain invariants and query semantics; component tests
own exhaustive control variants and controlled scheduling. Browser tests select
representative user journeys across these boundaries instead of restating their
implementation.

The suite has two artifacts and origins:

- Product journeys run the normal Vite build with the production Worker, real
  Wasm core, IndexedDB, and application-shell Service Worker. They interact with
  visible controls and verify outcomes after navigation or reopening.
- Browser contracts run a separate instrumented artifact. Only this origin
  exposes adapter corpus runners and persistence fault injection. These tests
  exercise recovery and durability without adding test hooks to product journeys.

Remote collaboration uses the real synchronization service and PostgreSQL. Each
run owns an isolated database, and each scenario owns its accounts and graph.
Missing collaboration configuration is a setup failure, so a successful gate
cannot silently omit the assembled remote path.

## Coverage

| Boundary                    | Representative evidence                                                             | Suite                                                  |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Graph lifecycle             | Create, reopen, rename, and remove an independent graph                             | `lifecycle.spec.ts`                                    |
| Outline authoring           | Keyboard structure, editing, undo/redo, and persistence                             | `outline.spec.ts`                                      |
| Native input and rendering  | Browser IME composition and safe Markdown rendering                                 | `input.spec.ts`                                        |
| Properties and tags         | Empty and numeric values, copied defaults, overrides, and detachment                | `properties.spec.ts`                                   |
| Portability                 | Export and import a copy with an independent identity                               | `archive.spec.ts`                                      |
| Local-first operation       | Offline editing and full browser reload                                             | `offline.spec.ts`                                      |
| Discovery and derived views | References, typed task properties, and executable query results                     | `references.spec.ts`, `tasks.spec.ts`, `query.spec.ts` |
| Usability                   | Keyboard access, representative accessibility, mobile reachability, and preferences | `usability.spec.ts`                                    |
| Remote operation            | Real account/repository interactions and multi-profile convergence                  | `remote.spec.ts`, `collaboration.spec.ts`              |
| Browser adapter             | Shared CorePort corpus, IndexedDB restart, and remote outbox                        | `contracts/storage.spec.ts`                            |
| Recovery                    | Injected save failures and durable retry                                            | `contracts/recovery.spec.ts`                           |

Each journey asserts its user-visible result, and persistence journeys reopen
the graph before accepting success. Contracts remain separate so internal
protocol evidence cannot substitute for a working user flow.

Chromium is the browser gate. Product journeys run on the desktop configuration;
the usability suite also runs on a phone viewport, in dark mode, and with reduced
motion. Remote scenarios and browser contracts have their own projects and
fixtures.

Accessibility and viewport checks use representative populated surfaces. They
assert operable controls, focus, and content reachability. Incidental pixel
alignment and every component permutation belong to focused design or component
verification rather than a global browser geometry heuristic.

## Isolation and Synchronization

Every test receives a fresh browser context. Date, locale, timezone, and viewport
are explicit inputs where the scenario depends on them. Tests do not share
browser storage, selected graphs, or reusable authenticated profiles.

Only calendar time is fixed; animation, debounce, networking, and Worker timers
continue normally. Expiration and clock-drift cases belong to the controlled
auth/server tests. Chromium's native composition boundary is exercised, but an
operating-system IME is not emulated. Native clipboard journeys use the pinned
headless browser's process-local clipboard; headed runs are not the CI gate.

Actions are ordered by their relevant observable result. A saved indicator that
was already present before an edit cannot prove that edit was persisted. A
derived result must contain the intended change, and durable outcomes must
survive reopening. Tests do not use arbitrary sleeps or retry failed mutations.
Playwright retries are disabled. CI repeats every scenario twice with fresh
contexts, providing additional schedules without converting an earlier failure
into success.

## Execution and Evidence

`devenv --profile browser test` is the shared local and CI gate. Build tasks
produce the normal and instrumented artifacts before managed service startup.
Playwright runs only after PostgreSQL, the isolated collaboration server, and
both strict-port previews are ready. Compilation never consumes a readiness
deadline. Direct Playwright runs own fresh previews and must satisfy the same
collaboration prerequisites.

The HTML report records the executed scenarios on every CI run. Failed tests
retain traces, screenshots, and assertion context. Suite and assertion timeouts
are failure budgets, not synchronization mechanisms.

## Audit Evidence

The rewrite distinguishes three observed failure classes:

- [September 2 service startup failure](https://github.com/waneon/neoseq/actions/runs/33630851608)
  attempted browser startup while allocated ports were still reserved. The
  post-startup lifecycle is retained to preserve its correction.
- [August 25 browser interaction failure](https://github.com/waneon/neoseq/actions/runs/32826286528)
  lost autocomplete options during a click. Journeys must observe the relevant
  mutation and preserve ordinary browser actionability checks.
- [September 6 component-test failure](https://github.com/waneon/neoseq/actions/runs/34032811899)
  asserted a debounced query save before publication and stopped before
  Playwright ran. Browser coverage does not replace deterministic component
  scheduling tests.

These historical failures identify boundaries to verify; they do not by
themselves establish that the current checkout still contains those defects.
