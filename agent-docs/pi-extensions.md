# Writing Pi extensions

Best practices for extensions on the Pi coding agent (`@earendil-works/pi-coding-agent`). Pi-orchestra builds on this framework; see `src/extension/index.ts` for the entry point and `src/tools/*.ts` for tool definitions.

For tool shape (names, params, outputs), pair this with [tool-design.md](./tool-design.md).

## Extension shape

An extension is a default-exported factory that receives an `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piOrchestraExtension(pi: ExtensionAPI): void {
  pi.registerTool(/* ... */);
}
```

- The factory can be sync or async. An async factory resolves before `session_start` fires, so use it for one-time setup that needs remote config or dynamic model discovery.
- Do not start timers, processes, sockets, or file watchers in the factory; Pi may load it without starting a session. Start long-lived resources on `session_start` or lazily, then close them with an idempotent `session_shutdown` handler.
- Register tools, commands, and event handlers inside the factory.
- Discovery paths: `~/.pi/agent/extensions/*.ts` (global), `.pi/extensions/*.ts` (project-local), `index.ts` inside subdirectories of those paths, and any paths under `"extensions"` in `settings.json`. This repo registers its entry through the `pi.extensions` field in `package.json`.

Security note: extensions run with full system permissions and can execute arbitrary code. Only load extensions you trust.

## Registering tools

This repo uses both pieces of Pi's tool API:

- `defineTool({ ... })` builds a tool definition object. See `defineSubagentPiTool` in `src/tools/subagent.ts`.
- `pi.registerTool(definition)` registers it. See `src/extension/index.ts`.

Keep that split: a `defineXPiTool(resolve)` factory in the tool module, wired up in the extension entry point. It keeps tools easy to unit-test in isolation.

A tool definition's fields:

```typescript
defineTool({
  name: "subagent", // unique, snake_case, distinct from others
  label: "Subagent", // human label for the TUI
  description: "Create and manage isolated subagents.",
  promptSnippet: "Spawn a subagent with an automatic private bus, then status/message/close it later.",
  promptGuidelines: [
    // bullets injected into the system prompt
    "Use subagent without busId for a private bus; pass busId only to share an existing bus.",
    "Use subagent with the returned run name for status, message, or close.",
  ],
  parameters: SubagentToolParams, // Typebox schema
  executionMode: "parallel", // or "sequential"; omission defaults to parallel
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

- `promptSnippet` is the one line that appears in the system prompt's tool listing. Make it specific and action-oriented.
- `promptGuidelines` bullets must name the tool explicitly. Write `"Use subagent to..."`, not `"Use this tool to..."`; those bullets are read out of context, where "this tool" is ambiguous.
- Pi runs tools in parallel by default. Set `executionMode: "sequential"` explicitly when calls must not interleave. This repo marks `subagent` as parallel and `bus`, `workgroup`, and `workflow` as sequential.
- Prefer one tool with an `action` enum over many near-duplicate tools. `subagent` does `spawn`/`status`/`message`/`close`. See [tool-design.md](./tool-design.md) on consolidation.

## Parameters: Typebox schemas

Parameters are [Typebox](https://github.com/sinclairzx81/typebox) schemas (`import { Type } from "typebox"`).

- Add a `description` to every field. The model reads these. Look at `AgentProfileParams` and `SubagentToolParams` in `src/tools/subagent.ts`.
- Make conditionally required fields `Type.Optional(...)` in the schema, then validate the real requirement in code and throw a clear message such as `"subagent action=spawn requires task."`. Schema-level enums plus a hand-written guard usually give better errors than a large union schema.
- Set `additionalProperties: false` on the top-level object to reject typos.
- Use a flat string enum with `Type.String({ enum: [...] })` or `StringEnum(...)` from `@earendil-works/pi-ai`. Avoid `Type.Union`/`Type.Literal` for Google compatibility.

## The `execute` callback

Signature: `(toolCallId, params, signal, onUpdate, ctx) => Promise<Result>`.

- Return shape: `{ content: [{ type: "text", text }], details? }`. `content` is what the model sees. `details` is structured data for the TUI and session branching, and Pi does not force it into the model context.
- Throw on failure instead of returning an error status string. That is how Pi marks a tool call failed.
- Honor cancellation. Forward `signal` (`AbortSignal | undefined`) to long async work.
- Stream progress with `onUpdate?.({ content: [...] })` for slow tools; omit it for fire-and-forget tools.
- Set `terminate: true` to request skipping the automatic follow-up LLM call. It takes effect only when every finalized tool result in the batch is terminating. The child `finish` tool does this; see `src/adapters/pi-runtime.ts`.
- Read environment from `ctx`: `ctx.cwd`, `ctx.model`, `ctx.modelRegistry`, `ctx.mode` (`"tui" | "rpc" | "json" | "print"`), `ctx.hasUI`, and `ctx.signal`.

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

- Default cap is about 50 KB / 2000 lines. Truncate and tell the model it was truncated, including where the full output lives if there is one.
- Use `truncateHead` when the beginning matters, such as file reads or search results. Use `truncateTail` when the end matters, such as logs.
- Return concise, useful text. See [tool-design.md](./tool-design.md) §"Return useful context".

## Concurrency safety

When tools mutate the same file in parallel, serialize through the mutation queue:

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

return withFileMutationQueue(absolutePath, async () => {
  /* read-modify-write */
});
```

In this repo, the similar risk is shared in-memory orchestration state. The runtime guards open/closed agent state with `assertOpenRun` and tracks in-flight prompt tasks per entry (`src/adapters/pi-runtime.ts`). Guard new parallel actions the same way.

## Per-context state isolation

`src/extension/index.ts` keys a `ToolBundle` (store + runtime + orchestra + tools) by `ctx.cwd`, building it lazily once per working directory. Follow that pattern: do not share orchestration state across unrelated workspaces, and build lazily so unused contexts cost nothing.

## Beyond tools

The same `pi` object exposes more APIs. Use these only when a tool cannot do the job:

- `pi.registerCommand("name", { description, handler, getArgumentCompletions })`: slash commands.
- `pi.registerShortcut(...)`, `pi.registerFlag(...)`: keybindings and CLI flags.
- `pi.on("session_start" | "before_agent_start" | "tool_call" | "tool_result" | "tool_execution_end" | "input" | "session_shutdown", handler)`: lifecycle hooks. `tool_call` can `{ block: true, reason }` to veto a call; `before_agent_start` can rewrite the system prompt.
- `pi.appendEntry(customType, data)`: persist custom state across restarts without putting it in the LLM context. Restore it by scanning `ctx.sessionManager.getEntries()` on `session_start`.
- `ctx.ui.*`: check `ctx.hasUI` for dialogs and notifications; require `ctx.mode === "tui"` for `custom()`, component factories, terminal input, and direct TUI rendering.
- `ctx.reload()`: call only from a command handler and treat it as terminal. Never call it from inside a tool. State captured before a reload, `newSession`, `fork`, or `switchSession` is stale; use only the fresh `ctx` handed to the replacement callback.

## Checklist

- [ ] Tool registered through a `defineXPiTool(resolve)` factory and wired in the entry point.
- [ ] Every parameter has a `description`; the top-level object is `additionalProperties: false`.
- [ ] Conditionally required params are optional in the schema and guarded in code with clear errors.
- [ ] `promptSnippet` is set; `promptGuidelines` name the tool explicitly.
- [ ] `execute` throws on failure, honors `signal`, and truncates large output.
- [ ] `executionMode` is explicit: use `parallel` only for interleave-safe tools and `sequential` for shared mutable state.
- [ ] Shared mutable state is guarded; per-`cwd` state is isolated.
- [ ] Unit test is colocated next to the tool. See `src/tools/*.test.ts`.
