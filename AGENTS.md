# Pi-Orchestra: Agent Guide

## Project Structure

- `src/` contains all TypeScript source for the package and Pi extension.
- `src/core/` holds the orchestration domain model and runtime-independent logic: subagents, workgroups, workflows, the event bus, store/runtime contracts, and core tests.
- `src/adapters/` bridges core abstractions to concrete implementations, including the in-memory store and Pi runtime integration.
- `src/tools/` contains tool implementations exposed to agents, plus their Pi tool definitions and colocated tests.
- `src/extension/` is the Pi extension entry point; it wires stores, runtime adapters, the orchestra, and registered tools together.
- `src/profiles/` contains reusable agent profile presets used by orchestration flows.
- Root-level configuration files define package metadata, TypeScript, linting, formatting, and test setup.

## Development Tools

- Use `corepack pnpm` to manage dependencies and run scripts
- Use `oxlint` for linting and type checking
- Use `oxfmt` for formatting
- Use `vitest` for tests

## Commits

- Do not create commits unless the user explicitly asks
- One logical change per commit
- Use Conventional Commits, such as `feat(tool): add subagent tool`
- Avoid overly granular scopes unless they clarify ownership or impact
- Use `!` or `BREAKING CHANGE:` for breaking public API changes
