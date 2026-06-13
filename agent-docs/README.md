# Agent Docs

Agent-facing references for working on **pi-orchestra**. These documents collect
local conventions and actionable rules tailored to this codebase.

## How to use these docs

- Read the doc that matches what you are about to do **before** writing code or
  prompts. They encode decisions we want applied consistently.
- These are guidelines, not law. When a doc conflicts with [AGENTS.md](../AGENTS.md)
  or the actual code, the repo wins — and you should fix the doc.
- When you learn something new and durable (an API changed, a pattern bit us),
  update the relevant doc in the same change.

## Index

- [pi-extensions.md](./pi-extensions.md): Authoring or changing a Pi extension, tool registration, or the extension entry point.
- [tool-design.md](./tool-design.md): Designing the _shape_ of an agent-facing tool — its name, parameters, outputs, and errors.
- [prompt-engineering.md](./prompt-engineering.md): Writing prompts, system prompts, or agent profile instructions.
- [context-engineering.md](./context-engineering.md): Managing what goes into an agent's context window for long-running or multi-step work.
- [skill-writing.md](./skill-writing.md): Writing concise, portable reusable agent skills.
- [profile-writing.md](./profile-writing.md): Authoring reusable `AgentProfile` presets in `src/profiles/`.

## How these map to the codebase

- `src/extension/` → [pi-extensions.md](./pi-extensions.md)
- `src/tools/` → [tool-design.md](./tool-design.md) + [pi-extensions.md](./pi-extensions.md)
- `src/profiles/` → [profile-writing.md](./profile-writing.md) + [prompt-engineering.md](./prompt-engineering.md) + [context-engineering.md](./context-engineering.md)
- Future skill packages → [skill-writing.md](./skill-writing.md) + [tool-design.md](./tool-design.md)
- `src/core/` (orchestra, subagent, workgroup, workflow, bus) → [docs/orchestration-model.md](../docs/orchestration-model.md)
- Hardening trade-offs and accepted LOW findings → [docs/hardening-decisions.md](../docs/hardening-decisions.md)
