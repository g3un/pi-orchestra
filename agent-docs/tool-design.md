# Designing Agent-Facing Tools

How to shape a tool so an LLM agent uses it correctly and efficiently. This is
about the _interface_ — names, parameters, outputs, errors. For the Pi
mechanics of registering a tool, see [pi-extensions.md](./pi-extensions.md).

The guidance below is grounded in this repo's tools (`src/tools/`).

## Core principle

A tool is not a thin wrapper over an API — it is an **affordance** for the
agent. Design for how an agent reasons, not for API completeness. "More tools
don't always lead to better outcomes."

## 1. Build high-leverage tools, not API mirrors

- Pick tools that expand what the agent can _accomplish_, collapsing a
  multi-step workflow into one meaningful call.
- Example: instead of `list_users` + `list_events` + `create_event`, ship one
  `schedule_event` that finds a slot and books it.
- In this repo, the `workflow` tool drives a whole staged pipeline rather than
  exposing every primitive; the `subagent` tool bundles the full lifecycle.

## 2. Consolidate; use an `action` enum

- Prefer one tool with a discriminated `action` parameter over several
  near-duplicate tools. Our `subagent` tool exposes
  `spawn`/`status`/`message`/`close` through one `action` enum
  (`src/tools/subagent.ts`).
- Fewer tools = fewer ambiguous decision points. If _you_ can't decide which of
  two tools to call, neither can the agent — that's a smell to merge or
  re-scope them.

## 3. Name tools and parameters unambiguously

- Distinct, descriptive tool names prevent mis-selection.
- **Namespace** related tools with consistent prefixes when you have many
  (`asana_projects_search`, `asana_users_search`) so the agent can tell servers
  and domains apart.
- Use specific parameter names: `user_id`, not `user`; `busId`, not `id` when
  the kind matters.

## 4. Write descriptions like onboarding docs

Tool descriptions and parameter descriptions are loaded into the agent's context
and directly drive tool-calling behavior — this is among the highest-ROI things
to get right.

- Make implicit context explicit, as if onboarding a new teammate: what the tool
  is for, when to use it vs. a sibling tool, input format, edge cases,
  boundaries.
- Describe **every** parameter (Typebox `description`). See `AgentProfileParams`
  in `src/tools/subagent.ts`.
- Small wording refinements produce outsized behavior changes — treat
  descriptions as tunable, not fixed.

## 5. Return meaningful context, not raw identifiers

- Return high-signal, human-readable fields (`name`, `file_type`, a status
  summary) over opaque UUIDs and low-level technical data. Agents reason better
  on semantic content.
- Consider a `response_format` enum (e.g. `"concise"` vs `"detailed"`) so the
  agent can ask for only what it needs. Treat vendor examples of token savings
  as directional; measure on this tool's actual transcripts.
- Our tools return a formatted natural-language `message` for the model plus
  structured `details` for the harness (`SubagentOutput`), rather than dumping
  raw run objects into the prompt.

## 6. Be token-efficient

- Paginate, filter, range-select, and truncate with sensible defaults; never
  return unbounded data. Pi's extension docs require truncation and currently
  document a 50 KB / 2000-line built-in limit for extension tool outputs.
- When you truncate, say so and steer the agent toward a narrower next call
  ("use filters to narrow to the last 7 days").
- See the truncation helpers in [pi-extensions.md](./pi-extensions.md)
  §"Output discipline".

## 7. Make errors actionable

- Replace opaque codes/tracebacks with prompt-engineered guidance the agent can
  act on: what went wrong, and the corrected input shape or next step.
- Our input guards model this: `"subagent action=spawn requires task."` tells
  the agent exactly what to fix. Validate early, fail with a sentence.
- In Pi, **throw** to mark failure (don't return an error sentinel) — see
  [pi-extensions.md](./pi-extensions.md).

## 8. Develop against evaluations

- Stand up a quick prototype, then measure with realistic, verifiable tasks that
  require several tool calls. Iterate until performance is strong.
- Track more than accuracy: runtime, **tool-call count**, **token consumption**,
  and error rate. A tool that's "correct" but triggers 10 calls and floods
  context is a regression.
- Read transcripts to find where the agent misused a tool, and fix the
  description/shape — often cheaper than changing the logic.

## Quick checklist

- [ ] Does this tool collapse a real multi-step workflow, or is it an API mirror?
- [ ] Could it merge with a sibling via an `action` enum?
- [ ] Is the name distinct? Are params specifically named and fully described?
- [ ] Does it return semantic, bounded output (with truncation + format options)?
- [ ] Do errors tell the agent how to recover?
- [ ] Is there an eval/test that exercises realistic agent usage?
