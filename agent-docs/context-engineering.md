# Context Engineering

Prompt engineering is about _what you say_; context engineering is about
_what occupies the context window_ across a whole task or agent run. For a
long-running orchestrator like pi-orchestra, this is where reliability is won or
lost.

## The one principle

> Find the **smallest set of high-signal tokens** that maximize the likelihood
> of the desired outcome.

Treat context as a finite, depleting resource. Every token you add competes for
the model's attention; curate at each step.

## Just-in-time retrieval

Don't pre-load everything an agent _might_ need. Instead:

- Keep lightweight **identifiers** in context — file paths, ids, bus ids,
  queries — and load the full payload only when needed, via tools.
- Use metadata (naming conventions, folder structure, timestamps) to let the
  agent decide what to pull. Progressive disclosure beats a giant upfront dump.
- This mirrors how this repo's runtime _drains_ bus messages on demand and
  injects only unread ones (`drainBusMessages` /
  `withBusMessages` in `src/adapters/pi-runtime.ts`) rather than replaying the
  whole bus every turn.

## Long-horizon techniques

When a task outruns a single context window, use one or more of:

1. **Compaction** — when nearing the limit, summarize history into a compact
   form that preserves decisions and open threads while dropping redundant tool
   output. Pi exposes session lifecycle hooks (`session_before_compact`,
   `session_compact`) for custom compaction behavior.
2. **Structured note-taking** — let the agent persist notes _outside_ the
   immediate context window and pull them back when relevant. In Pi,
   `pi.appendEntry` stores custom session state that survives restarts without
   automatically becoming LLM-visible context (see
   [pi-extensions.md](./pi-extensions.md)).
3. **Sub-agent architectures** — hand a focused task to a specialist agent with
   its own clean window; return only a **condensed summary** to the coordinator.
   This is exactly the pi-orchestra model — see
   [orchestration-model.md](../docs/orchestration-model.md). The `finish`
   tool's `summary` + `data` is the condensed handoff; keep it tight.

## Keep injected context labeled and subordinate

- Clearly delimit external/peer context so it can't be mistaken for
  instructions. The runtime wraps peer content in `<bus_reference_context>` and
  the initial prompt tells the agent to treat it as _supplemental unless told
  otherwise_. Preserve that framing for any new injected context.
- Don't let supplemental context crowd out the task. The task and its output
  contract come first; reference material supports it.

## Summaries are the unit of handoff

In a multi-agent system, what one agent passes to the next _is_ context
engineering. Make handoffs:

- **Condensed** — synthesized findings, not raw transcripts. Our `stage-leader`
  profile is built for exactly this: "produce concise canonical output for the
  next stage," "deduplicate and reconcile," "prefer finish results over bus
  context."
- **Decision-bearing** — note conflicts, gaps, and confidence so the next stage
  doesn't re-derive them.

## Checklist for long-running flows

- [ ] Am I loading data just-in-time, or pre-dumping everything?
- [ ] Are large/raw tool outputs truncated before they enter context?
- [ ] Is durable state stored _outside_ the window (notes/entries) when it isn't
      needed every turn?
- [ ] Is long history compacted rather than replayed verbatim?
- [ ] Is each subagent handoff a condensed summary, not a transcript?
- [ ] Is injected reference context labeled and marked supplemental?
