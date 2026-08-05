# AI Agent Instructions

## Coding Guidelines
- Prefer modern approaches and established best practices.
- Favor a minimal architecture that meets the requirements while allowing room for future expansion.

## Documents

### README.md / DEVELOPMENT.md
- Agents are responsible for updating and maintaining these files, while avoiding unnecessary expansion, duplication, or excessive detail.
- Write for human readers in clear, human-readable language, and keep only the essential information concise.

### ARCHITECTURE.md
- Presents a high-level overview of this repo's code architecture.
- Describes high-level boundaries, contracts, and architecture rather than code details.
- Kept concise, under 300 lines; the more detailed architecture of each component is captured in documents under architectures/.
- Treated as the source of truth: whenever the code changes, this document is kept up to date as well.
- This file must be written in English.

### architectures/
- Describes the architecture of each component.
- Like ARCHITECTURE.md, covers the slightly more detailed architecture of each component rather than implementation details.
- Kept concise, under 300 lines.
- These files must be written in English.

### DESIGN.md
* Treat this document as the source of truth when implementing the frontend in this repository.
* Always take this document into account and design and implement the UI/UX at a production-quality level.
