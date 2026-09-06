# AI Agent Instructions

## General Guidelines

Practice good taste. Seek a simpler representation before adding logic. Prefer representations and invariants that make special cases disappear, keep control flow obvious, and reduce the number of states the reader must reason about.

## Documents

### Intent Documentation

- Treat the high-level requirements in INTENT.md as invariants for the repository.

### Architecture Documentation

- Use ARCHITECTURE.md to describe repository-wide architecture, and files under architectures/ to describe the architecture of a single focused topic.
- Use DESIGN.md to describe repository-wide frontend design architecture, and files under designs/ to describe the frontend design architecture of a single focused topic.
- Keep each document concise and avoid describing implementation details.
- Build on the existing architecture, but improve it first if it cannot naturally express the requirements.
- Keep these documents in sync whenever the architecture is updated.
- Write these files in English.
