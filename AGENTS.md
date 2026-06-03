# Pi-Orchestra: Agent Guide

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
