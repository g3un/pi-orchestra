# Agent docs

Agent-facing references for working on pi-orchestra. These notes collect local conventions and rules for this codebase.

## How to use these docs

- Read the doc that matches your task before writing code or prompts. They capture decisions we want applied consistently.
- These are guidelines, not law. If a doc conflicts with [AGENTS.md](../AGENTS.md) or the code, the repo wins. Fix the doc too.
- When you learn something durable, such as an API change or a pattern that caused trouble, update the relevant doc in the same change.

## Index

- [pi-extensions.md](./pi-extensions.md): Authoring or changing a Pi extension, tool registration, or the extension entry point.
- [tool-design.md](./tool-design.md): Designing an agent-facing tool: name, parameters, outputs, and errors.
- [prompt-engineering.md](./prompt-engineering.md): Writing prompts, system prompts, or agent profile instructions.
- [context-engineering.md](./context-engineering.md): Managing what enters an agent's context window for long-running or multi-step work.
- [skill-writing.md](./skill-writing.md): Writing concise, portable reusable agent skills.

## How these map to the codebase

- `src/extension/` → [pi-extensions.md](./pi-extensions.md)
- `src/tools/` → [tool-design.md](./tool-design.md) + [pi-extensions.md](./pi-extensions.md)
- `skills/` → [skill-writing.md](./skill-writing.md) + [tool-design.md](./tool-design.md)
