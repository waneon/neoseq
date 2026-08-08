# AI Agent Instructions

## Coding Guidelines
- Prefer modern approaches and established best practices.
- Favor a minimal architecture that meets the requirements while allowing room for future expansion.

## Documents

### README.md / DEVELOPMENT.md
- Agents are responsible for updating and maintaining these files, while avoiding unnecessary expansion, duplication, or excessive detail.
- Write for human readers in clear, human-readable language, and keep only the essential information concise.

### ARCHITECTURE.md
- Serves as the source of truth for the repository-wide architecture.
- Describe system boundaries, component responsibilities, dependencies, data flows, and important contracts---not implementation details.
- Keep it concise and normally within 200 lines. Treat 300 lines as a soft limit, not a completeness target.  Do not omit important architectural information solely to satisfy a line limit.
- If it approaches 300 lines, move component-specific or lower-level architectural context to focused documents under architectures/.
- Write this file in English.

### architectures/
- Serves as the source of truth for the repository-wide architecture.
- Describe responsibilities, boundaries, dependencies, contracts, and significant internal structure without duplicating ARCHITECTURE.md or documenting code-level details.
- Keep each document concise and normally within 250 lines. If a document approaches 300 lines, consider splitting it by independently understandable responsibility or boundary.
- Exceed the soft limit only when splitting would reduce clarity or obscure important relationships.
- Write these files in English.

### DESIGN.md
* Treat this document as the source of truth when implementing the frontend in this repository.
* Always take this document into account and design and implement the UI/UX at a production-quality level.
