# Context engineering

Prompt engineering is about _what you say_. Context engineering is about _what stays in the context window_ during a task or agent run. For a long-running orchestrator like pi-orchestra, this is where reliability is won or lost.

## The one principle

> Use the smallest useful set of tokens that makes the desired outcome likely.

Treat context as a finite resource. Every token competes for the model's attention, so curate it at each step.

## Just-in-time retrieval

Don't load everything an agent _might_ need. Instead:

- Keep lightweight identifiers in context: file paths, ids, bus ids, and queries. Load the full payload through tools only when needed.
- Use metadata such as names, folders, and timestamps to help the agent decide what to pull. Progressive disclosure beats a giant upfront dump.
- This matches the repo runtime, which _drains_ subscribed bus messages on demand and injects only unread messages (`drainSubscribedBusMessages` / `withSubscribedBusMessages` in `src/adapters/pi-runtime.ts`) instead of replaying the whole bus every turn.

## Long-horizon techniques

When a task outgrows one context window, use one or more of these:

1. Compaction: near the limit, summarize history into decisions, open threads, and any still-useful facts. Drop repeated tool output. Pi exposes session lifecycle hooks (`session_before_compact`, `session_compact`) for custom compaction.
2. Structured notes: let the agent store notes _outside_ the immediate context window and retrieve them when relevant. In Pi, `pi.appendEntry` stores custom session state that survives restarts without automatically becoming LLM-visible context. See [pi-extensions.md](./pi-extensions.md).
3. Sub-agent architectures: give a focused task to a specialist agent with a clean window, then return only a condensed summary to the coordinator. In pi-orchestra, the `finish` tool's `summary` and `data` are the handoff, so keep them tight.

## Keep injected context labeled and subordinate

- Delimit external or peer context so the model does not mistake it for instructions. The runtime wraps peer content in `<bus_reference_context>` and the initial prompt says to treat it as _supplemental unless told otherwise_. Use the same framing for any new injected context.
- Do not let supplemental context crowd out the task. The task and output contract come first; reference material supports them.

## Summaries are the unit of handoff

In a multi-agent system, handoffs _are_ context engineering. Make them:

- Condensed: synthesized findings, not raw transcripts. Produce concise canonical output, deduplicate and reconcile, and prefer finished results over ambient context.
- Decision-bearing: note conflicts, gaps, and confidence so the workflow coordinator or next workgroup does not have to derive them again.

## Checklist for long-running flows

- [ ] Am I loading data just in time instead of dumping everything up front?
- [ ] Are large or raw tool outputs truncated before they enter context?
- [ ] Is durable state stored _outside_ the window when it is not needed every turn?
- [ ] Is long history compacted instead of replayed verbatim?
- [ ] Is each subagent handoff a condensed summary, not a transcript?
- [ ] Is injected reference context labeled and marked supplemental?
