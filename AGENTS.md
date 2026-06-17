# Pi-Orchestra: Agent Guide

## Coding guidelines

- Do not introduce unnecessary code duplication; reuse existing data, helpers, types, and patterns where they already fit.
- Do not keep compatibility aliases, wrappers, or deprecated exports unless the user explicitly asks for backward compatibility.
- Do not implement features, behaviors, or abstractions that were not requested by the user.
- Do not add, change, or rely on environment variables unless the user explicitly asks for them.
- Do not mark data as optional just to provide defaults. Use required fields when the caller must make an explicit choice.
- Prefer explicit inputs over implicit defaults when behavior affects runtime capabilities, tools, permissions, or public API contracts.
- Treat LLM-facing tool parameter schemas as a boundary exception: when complex `anyOf`/`oneOf` unions would hurt provider/tool-calling compatibility or model usability, use a simple input shape with actionable runtime validation, then normalize immediately into strict core/runtime types.

## Project Structure

- `src/` contains all TypeScript source for the package and Pi extension.
- `src/core/` holds the orchestration domain model and runtime-independent logic: subagents, workgroups, workflows, the event bus, store/runtime contracts, and core tests.
- `src/adapters/` bridges core abstractions to concrete implementations, including the in-memory store and Pi runtime integration.
- `src/tools/` contains tool implementations exposed to agents, plus their Pi tool definitions and colocated tests.
- `src/extension/` is the Pi extension entry point; it wires stores, runtime adapters, the orchestra, and registered tools together.
- `src/profiles/` contains reusable agent profile presets used by orchestration flows.
- `docs/` holds project architecture notes.
- `agent-docs/` holds agent-facing implementation notes.
- Root-level configuration files define package metadata, TypeScript, linting, formatting, and test setup.

## Agent Docs

- Start from `agent-docs/README.md` before making agent-facing changes; it maps the detailed guidance to the codebase.

## Development Tools

- Use `corepack pnpm` to manage dependencies and run scripts
- Use `oxlint` for linting and type checking
- Use `oxfmt` for formatting
- Use `vitest` for tests

## Commits

- Do not create commits unless the user explicitly asks
- Do not bump `package.json` for every code change; bump only for release/publish work or when the user asks
- Use CalVer release versions without leading zeroes: stable `YYYY.M.D` (`2026.6.17`), prerelease `YYYY.M.D-N` (`2026.6.17-0`)
- Release tags are only for publish releases and must be `v${package.version}`; no hyphen publishes to npm `latest`, hyphenated prereleases publish to `next`
- Do not create release tags unless the user explicitly asks, and keep npm versions SemVer-compatible; avoid forms like `2026.06.17`, `2026.06.17.00`, or `2026.6.17-00`
- One logical change per commit
- Use Conventional Commits, such as `feat(tool): add subagent tool`
- Avoid overly granular scopes unless they clarify ownership or impact
- Use `!` or `BREAKING CHANGE:` for breaking public API changes
