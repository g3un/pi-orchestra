# Designing agent-facing tools

How to shape a tool so an LLM agent uses it correctly. This is about the interface: names, parameters, outputs, and errors. For Pi's registration mechanics, see [pi-extensions.md](./pi-extensions.md).

These notes are based on this repo's tools in `src/tools/`.

## Core idea

A tool is not a thin API wrapper. It is a handle the agent can reason about. Design for the task the agent needs to finish, not for API completeness. More tools do not always produce better results.

## 1. Build useful tools, not API mirrors

- Pick tools that let the agent finish real work, ideally turning several calls into one clear action.
- Example: instead of `list_users` + `list_events` + `create_event`, ship one `schedule_event` that finds a slot and books it.
- In this repo, `subagent` bundles the child-agent lifecycle and `workgroup` bundles leader/member coordination.

## 2. Consolidate with an `action` enum

- Prefer one tool with a discriminated `action` parameter over several near-duplicate tools. `subagent` exposes `spawn`/`status`/`message`/`close` through one `action` enum (`src/tools/subagent.ts`).
- Fewer tools mean fewer ambiguous choices. If you cannot decide which of two tools to call, the agent probably cannot either. Merge or re-scope them.

## 3. Name tools and parameters clearly

- Use distinct, descriptive tool names so the agent does not pick the wrong one.
- Namespace related tools with consistent prefixes when there are many (`asana_projects_search`, `asana_users_search`). That helps the agent tell servers and domains apart.
- Use specific parameter names: `user_id`, not `user`; `busId`, not `id` when the kind matters.

## 4. Write descriptions like onboarding notes

Tool and parameter descriptions land in the agent's context and strongly affect tool calls.

- Make implicit context explicit, as if onboarding a teammate: what the tool is for, when to use it instead of a sibling tool, input format, edge cases, and boundaries.
- For lifecycle tools, document ownership. Subagents call `finish`, workgroup leaders call `workgroup finish`, and workflow coordinators call `workflow finish`. Cancelling a workgroup or workflow belongs to the supervising parent.
- Describe every parameter with a Typebox `description`. See `AgentProfileParams` in `src/tools/subagent.ts`.
- Treat wording as something you tune. Small description changes can change agent behavior.

## 5. Return useful context, not raw identifiers

- Return human-readable fields such as `name`, `file_type`, and a status summary instead of opaque UUIDs or low-level details. Agents handle semantic content better.
- Consider a `response_format` enum, such as `"concise"` vs. `"detailed"`, so the agent can ask for only what it needs. Vendor token-saving examples are only hints; measure on this tool's transcripts.
- Our tools return a formatted natural-language `message` for the model plus structured `details` for the harness (`SubagentOutput`). They do not dump raw run objects into the prompt.

## 6. Keep output bounded

- Paginate, filter, range-select, and truncate with sensible defaults. Never return unbounded data. Pi's extension docs require truncation and currently document a 50 KB / 2000-line built-in limit for extension tool outputs.
- When you truncate, say so and point the agent to a narrower next call, for example "use filters to narrow to the last 7 days".
- See the truncation helpers in [pi-extensions.md](./pi-extensions.md) §"Output discipline".

## 7. Make errors actionable

- Replace opaque codes and tracebacks with guidance the agent can act on: what went wrong and the corrected input shape or next step.
- Our input guards model this: `"subagent action=spawn requires task."` tells the agent what to fix. Validate early and fail with a sentence.
- In Pi, throw to mark failure. Do not return an error sentinel. See [pi-extensions.md](./pi-extensions.md).

## 8. Develop against evaluations

- Build a small prototype, then measure it with realistic tasks that need several tool calls. Iterate until transcripts look clean.
- Track runtime, tool-call count, token use, error rate, and accuracy. A tool that gets the right answer after 10 calls and a flooded context is still a regression.
- Read transcripts to see where the agent misused a tool. Often the fix is the description or shape, not the implementation.

## Checklist

- [ ] Does this tool collapse a real multi-step workflow, or is it an API mirror?
- [ ] Could it merge with a sibling through an `action` enum?
- [ ] Is the name distinct? Are parameters specific and fully described?
- [ ] Does it return semantic, bounded output with truncation or format options?
- [ ] Do errors tell the agent how to recover?
- [ ] Is there an eval or test that covers realistic agent usage?
