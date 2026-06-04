# Writing Pi Extensions

Best practices for authoring extensions on the Pi coding agent
(`@earendil-works/pi-coding-agent`). This is the framework pi-orchestra builds
on — see `src/extension/index.ts` for our entry point and `src/tools/*.ts` for
tool definitions.

For the _shape_ of a good tool (names, params, outputs), pair this with
[tool-design.md](./tool-design.md).

## Extension shape

An extension is a default-exported factory that receives an `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  pi.registerTool(/* ... */);
}
```

- The factory may be **sync or async**. An async factory resolves before
  `session_start` fires, so it is the right place for one-time setup that needs
  remote config or dynamic model discovery.
- Register tools/commands/event handlers inside the factory.
- Discovery paths: `~/.pi/agent/extensions/*.ts` (global),
  `.pi/extensions/*.ts` (project-local), `index.ts` inside subdirectories of
  those, and any paths under `"extensions"` in `settings.json`. This repo
  registers its entry via the `pi.extensions` field in `package.json`.

> **Security:** Extensions run with full system permissions and can execute
> arbitrary code. Only load extensions you trust.

## Registering tools

Two equivalent paths exist; this repo uses **both** deliberately:

- `defineTool({ ... })` builds a tool definition object (see
  `defineSubagentPiTool` in `src/tools/subagent.ts`).
- `pi.registerTool(definition)` registers it (see `src/extension/index.ts`).

Keep that split: a `defineXPiTool(resolve)` factory in the tool module, wired up
in the extension entry point. It keeps tools unit-testable in isolation.

A tool definition's fields:

```typescript
defineTool({
  name: "subagent", // unique, snake_case, distinct from others
  label: "Subagent", // human label for the TUI
  description: "Create and manage isolated subagents.",
  promptSnippet: "Spawn a subagent on an existing bus, then status/message/close it later.",
  promptGuidelines: [
    // bullets injected into the system prompt
    "Create a bus first; spawn attaches the subagent via busId.",
    "Use returned run id/name for status, message, or close.",
  ],
  parameters: SubagentToolParams, // Typebox schema
  executionMode: "parallel", // or "sequential"; omit for the default
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: "..." }],
      details: {
        /* ... */
      },
    };
  },
});
```

Field rules that matter:

- **`promptSnippet`** is the one line that appears in the system prompt's tool
  listing. Make it action-oriented and specific.
- **`promptGuidelines`** bullets must name the tool explicitly — write
  `"Use subagent to…"`, **not** `"Use this tool to…"`. They are read out of
  context where "this tool" is ambiguous.
- **`executionMode: "parallel"`** lets the runtime run this tool concurrently
  with others. Only set it when the tool is safe to interleave (no shared
  mutable state without guarding). Our `subagent` tool is parallel; default to
  `"sequential"` or omit the override when unsure.
- Prefer a single tool with an `action` enum over many near-duplicate tools
  (our `subagent` tool does `spawn`/`status`/`message`/`close`). See
  [tool-design.md](./tool-design.md) on consolidation.

## Parameters: Typebox schemas

Parameters are [Typebox](https://github.com/sinclairzx81/typebox) schemas
(`import { Type } from "typebox"`).

- Add a `description` to **every** field — the model reads these. Look at
  `AgentProfileParams` and `SubagentToolParams` in `src/tools/subagent.ts`.
- Make conditionally-required fields `Type.Optional(...)` in the schema, then
  validate the real requirement in code and throw a clear message
  (`"subagent action=spawn requires task."`). Schema-level enums + a hand-rolled
  guard give better error messages than a sprawling union schema.
- Set `additionalProperties: false` on the top-level object to reject typos.
- For string enums that must be sent to Google-family models, use `StringEnum`
  from `@earendil-works/pi-ai` instead of raw `Type.String({ enum })` for
  cross-provider compatibility.

## The `execute` callback

Signature: `(toolCallId, params, signal, onUpdate, ctx) => Promise<Result>`.

- Return shape: `{ content: [{ type: "text", text }], details? }`. `content` is
  what the model sees; `details` is structured data for the TUI / session
  branching and is not forced into the model's context.
- **Throw on failure** — don't return an error status string. A thrown error is
  how Pi marks a tool call failed.
- Honor cancellation: check `signal` (an `AbortSignal`) in long async work.
- Stream progress with `onUpdate?.({ content: [...] })` for slow tools; omit it
  for fire-and-forget.
- Set `terminate: true` in the result to skip the automatic follow-up LLM call
  (our child `finish` tool does this — see `src/adapters/pi-runtime.ts`).
- Read environment from `ctx`: `ctx.cwd`, `ctx.model`, `ctx.modelRegistry`,
  `ctx.mode` (`"tui" | "rpc" | "json" | "print"`), `ctx.hasUI`, `ctx.signal`.

## Output discipline

Tools must not flood the context window. Pi ships truncation helpers:

```typescript
import {
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
```

- Default cap is ~50 KB / ~2000 lines. Truncate, and **tell the model** it was
  truncated (and where the full output lives, if anywhere).
- `truncateHead` when the beginning matters (file reads, search results);
  `truncateTail` when the end matters (logs).
- Return high-signal text. See [tool-design.md](./tool-design.md) §"Return
  meaningful context".

## Concurrency safety

When tools mutate the same file in parallel, serialize through the mutation
queue:

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

return withFileMutationQueue(absolutePath, async () => {
  /* read-modify-write */
});
```

In this repo, the analogous concern is shared in-memory orchestration state. The
runtime guards open/closed agent state with `assertOpenRun` and tracks
in-flight prompt tasks per entry (`src/adapters/pi-runtime.ts`); keep new
parallel actions equally guarded.

## Per-context state isolation

`src/extension/index.ts` keys a `ToolBundle` (store + runtime + orchestra +
tools) by `ctx.cwd`, building it lazily once per working directory. Follow this
pattern: don't share orchestration state across unrelated workspaces, and build
lazily so unused contexts cost nothing.

## Beyond tools (when you need them)

The same `pi` object exposes more surface area. Reach for these only when a
tool genuinely cannot do the job:

- `pi.registerCommand("name", { description, handler, getArgumentCompletions })`
  — slash commands.
- `pi.registerShortcut(...)`, `pi.registerFlag(...)` — keybindings and CLI flags.
- `pi.on("session_start" | "before_agent_start" | "tool_call" | "tool_result" |
"input" | "session_shutdown", handler)` — lifecycle hooks. `tool_call` can
  `{ block: true, reason }` to veto a call; `before_agent_start` can rewrite the
  system prompt.
- `pi.appendEntry(type, data)` — persist custom state across restarts without
  putting it in the LLM context; restore by scanning
  `ctx.sessionManager.getEntries()` on `session_start`.
- `ctx.ui.*` (`select`, `confirm`, `input`, `editor`, `notify`, `custom`) —
  guard all of it behind `ctx.hasUI` / `ctx.mode === "tui"`.
- `ctx.reload()` — call **only** from a command handler and treat it as
  terminal; never call it from inside a tool. State captured before a reload (or
  a `newSession`/`fork`/`switchSession`) is stale — use only the fresh `ctx`
  handed to the replacement callback.

## Checklist

- [ ] Tool registered via a `defineXPiTool(resolve)` factory, wired in the entry point.
- [ ] Every parameter has a `description`; top-level object is `additionalProperties: false`.
- [ ] Conditionally-required params are optional in schema + guarded in code with clear errors.
- [ ] `promptSnippet` set; `promptGuidelines` name the tool explicitly.
- [ ] `execute` throws on failure, honors `signal`, truncates large output.
- [ ] `executionMode: "parallel"` only if the tool is interleave-safe.
- [ ] Shared mutable state is guarded; per-`cwd` state is isolated.
- [ ] Unit test colocated next to the tool (see `src/tools/*.test.ts`).
