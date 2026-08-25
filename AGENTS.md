# AI Agent Instructions

## General Guidelines

Treat programming as art and code as poetry.

Pursue beauty through restraint, clarity, and coherence—not cleverness or novelty. Good code should feel inevitable: simple to understand, easy to change, and difficult to misuse.

Practice good taste. Seek a simpler representation before adding logic. Prefer representations and invariants that make special cases disappear, keep control flow obvious, and reduce the number of states the reader must reason about.

Prefer solutions in this order:
1. Simple — choose the smallest design that fully solves the problem.
2. Elegant — favor clear structure, strong invariants, and abstractions that remove rather than hide complexity.
3. Mature — prefer proven, well-understood technologies and patterns.
4. Modern — adopt newer approaches when they are established and materially improve the design.

## Documents

### Architecture Documentation
- Use ARCHITECTURE.md to describe repository-wide architecture, and files under architectures/ to describe the architecture of a single focused topic.
- Serve as the source of truth for the repository's architecture.
- Focus on the repository's architecture while avoiding implementation details.
- Keep each document concise.
- Write these files in English.

### Design Documentation
- Use DESIGN.md as the source of truth for the repository's design architecture.
- Focus on the repository's design guidelines while avoiding design implementation details.
- Keep this document concise.
- Write this file in English.
