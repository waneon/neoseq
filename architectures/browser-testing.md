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

Remote collaboration uses the real synchronization service on a throwaway
PostgreSQL cluster owned by the run, and each scenario owns its accounts and
graph.

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

Completion is the application's fact, not the test's inference. The client
counts its outstanding work — unsaved editor input, debounced saves, and graph
work queued or running in the core — and marks the document `data-busy` while
any remains. Work is registered by the code path that starts it, so a gesture
is busy before its handler returns. Journeys therefore act, wait until the
application has settled, and assert visible outcomes with retrying assertions;
they never need to know which gesture saves, how often, or after which
debounce. Durable outcomes must survive reopening. Scheduled refreshes of
derived views are not the reader's work and are observed through their visible
result instead.

When a journey can only pass by waiting on something the reader could not
see, the defect is in the application: input must survive reconciliation and
controls must stay stable under the pointer. Tests do not use arbitrary sleeps
or retry failed mutations, and Playwright retries are disabled. CI repeats every
scenario twice with fresh contexts.

## Execution and Evidence

Playwright owns a run end to end. Its web servers, started in order before any
test, build the development Wasm core and both client artifacts, serve them, and
run the synchronization server on a PostgreSQL cluster that listens only on a
private socket. Ports are chosen per run, so concurrent runs in other checkouts
never collide, and everything is removed when the run ends. The same command
serves agents, local iteration, and CI:
`devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test`
(add `--project`, `-g`, or file filters for focused runs).

The HTML report records the executed scenarios. Failed tests retain traces,
screenshots, and assertion context. Suite and assertion timeouts are failure
budgets, not synchronization mechanisms.
