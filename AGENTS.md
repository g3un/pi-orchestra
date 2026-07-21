# Pi-Orchestra: agent guide

## Coding guidelines

- Do not introduce unnecessary code duplication; reuse existing data, helpers, types, and patterns where they already fit.
- Do not keep compatibility aliases, wrappers, or deprecated exports unless the user explicitly asks for backward compatibility.
- Do not implement features, behaviors, or abstractions that were not requested by the user.
- Do not add, change, or rely on environment variables unless the user explicitly asks for them.
- Do not mark data as optional just to provide defaults. Use required fields when the caller must make an explicit choice.
- Prefer explicit inputs over implicit defaults when behavior affects runtime capabilities, tools, permissions, or public API contracts.
- Treat LLM-facing tool parameter schemas as a boundary exception: when complex `anyOf`/`oneOf` unions would hurt provider/tool-calling compatibility or model usability, use a simple input shape with actionable runtime validation, then normalize immediately into strict core/runtime types.

## Project structure

- `src/` contains the TypeScript source for the package and Pi extension.
- `src/core/` holds the orchestration domain model and runtime-independent logic: subagents, workgroups, the event bus, store/runtime contracts, and core tests.
- `src/adapters/` bridges core abstractions to concrete implementations, including the in-memory store and Pi runtime integration.
- `src/tools/` contains tool implementations exposed to agents, plus their Pi tool definitions and colocated tests.
- `src/extension/` is the Pi extension entry point; it wires stores, runtime adapters, the orchestra, and registered tools together.
- `agent-docs/` holds agent-facing implementation notes.
- `scripts/` holds repository maintenance scripts.
- Root-level configuration files define package metadata, TypeScript, linting, formatting, and test setup.

## Agent docs

- Start with `agent-docs/README.md` before making agent-facing changes; it maps the detailed guidance to the codebase.

## Development tools

- Run development commands inside the repository's Nix environment with `nix develop` or `nix develop --command <command>`
- Use `nix flake check` for the full CI-equivalent verification
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
