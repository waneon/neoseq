# AI Agent Instructions

## Documentation

### Architecture Documentation

- Use ARCHITECTURE.md to describe repository-wide architecture, and files under architectures/ to describe the architecture of a single focused topic, while avoiding describing implementation details.
- Use DESIGN.md to describe repository-wide frontend design architecture, and files under designs/ to describe the frontend design architecture of a single focused topic, while avoiding describing implementation details.
- Treat these documents as summaries of the implementation, not as fixed constraints. Adopt a better representation when appropriate.

## Verification

- Run the narrowest tier that covers the change: `devenv tasks run gate:check|gate:rust|gate:component`, or `devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test [filters]`.
- Put a regression test in the lowest tier that can express it (Rust > component > browser journey).
- In journeys, wait with `app.saved()` / `app.settled()`; never add sleeps or longer timeouts. If a journey can only pass by waiting for something invisible, fix the application.
- A failure is yours until it reproduces on unmodified main; nondeterministic failures on main are reported and quarantined, not patched in passing.
