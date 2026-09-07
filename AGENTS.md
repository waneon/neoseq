# AI Agent Instructions

## Engineering Taste

- Seek the simplest representation that fully expresses the intent. Prefer better data models and invariants over additional logic.
- Keep naming, hierarchy, and interfaces consistent. Similar concepts should look and behave similarly.
- Organize around domain concepts and ownership. Keep things that change together close together.
- Give each fact one authoritative home and each responsibility a clear owner. Avoid parallel representations that must be kept in sync.
- Prefer standard language and ecosystem mechanisms. Add abstractions only when they simplify the whole design.
- Make control flow, dependencies, and state transitions explicit. Reduce special cases and unnecessary configuration.
- Fit changes into the existing architecture. If the fit is awkward, improve the representation before adding exceptions.
- Keep documentation concise: explain intent, boundaries, and non-obvious decisions. Keep it aligned with the code.

## Documentation

- Use ARCHITECTURE.md to describe repository-wide architecture, and files under architectures/ to describe the architecture of a single focused topic, while avoiding describing implementation details.
- Use DESIGN.md to describe repository-wide frontend design architecture, and files under designs/ to describe the frontend design architecture of a single focused topic, while avoiding describing implementation details.
- Keep README.md concise and include only what users need to know.
- Treat the high-level requirements in INTENT.md as invariants for the repository and do not modify this document.
