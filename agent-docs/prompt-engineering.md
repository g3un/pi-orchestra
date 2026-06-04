# Prompt Engineering

Best practices for writing prompts, system prompts, and agent-profile
instructions for LLM agents across providers. In this repo the relevant
surfaces are agent profile system prompts (`src/profiles/`) and the
task/instruction strings threaded through the runtime (`buildInitialPrompt` in
`src/adapters/pi-runtime.ts`).

For _what goes into the context window_ over a long task (compaction,
note-taking, retrieval), see [context-engineering.md](./context-engineering.md).

## 1. Lead with an output contract

The single highest-value practice: state **what "done" looks like** and **how it
will be judged**, up front.

- Specify format, length, tone, and required sections — make it testable.
- State scope, assumptions, exclusions, and what to do when uncertain.
- Name the exact output shape and the decision rule for status — e.g. `success`
  when useful output exists, `blocked` when context is insufficient, `failed`
  when the work cannot be completed.

## 2. Be explicit and literal

- Say exactly what you want in plain language; don't rely on the model to infer.
- If behavior is missing, the prompt probably didn't ask for it — add the
  instruction rather than blaming the model.
- Prefer positive instructions ("do X") over a wall of prohibitions.

## 3. Structure with clear delimiters

Use consistent section labels and delimiters so the model can separate
instructions, task input, examples, and external context. XML-like tags are a
good default for nested examples or injected data. Markdown headings are also
fine when the structure is shallow and readable.

```xml
<instructions> … </instructions>
<context> … </context>
<example> … </example>
```

- Reserve tags or headings for genuinely distinct sections (instructions vs.
  context vs. examples vs. data).
- The runtime already does light structuring with `## System prompt`,
  `## Task`, `## Completion` headers in `buildInitialPrompt`; keep new
  injected context clearly delimited so it can't be confused with instructions.
  Note that bus context arrives wrapped in `<bus_reference_context>` and is
  explicitly framed as _supplemental_ — match that discipline when injecting
  any external/peer content.

## 4. Use few-shot examples (highest ROI after the contract)

- 3–5 **diverse, canonical** examples wrapped in `<example>` tags beat a long
  list of edge cases.
- Examples are "pictures worth a thousand words" — show the desired output
  shape rather than describing it abstractly.
- Curate for variety (cover the distinct cases), not exhaustiveness.

## 5. Give explicit permission to be uncertain

- Tell the model it may say "I don't know" / flag low confidence instead of
  guessing. This measurably reduces hallucination.
- Operationalize it with a structured signal — e.g. a `blocked` status plus an
  instruction to note conflicts and gaps — so uncertainty becomes output, not a
  silent guess.

## 6. Write system prompts at the right altitude

A good system prompt is **specific enough to guide behavior, flexible enough to
leave room for judgment**. Avoid both extremes:

- ❌ Hardcoded, brittle if/else logic for every case.
- ❌ Vague, high-level platitudes with no concrete signal.
- ✅ Strong heuristics + clear boundaries — e.g. "treat supplied context as
  primary evidence; use tools only to verify or fill concrete gaps" rather than
  enumerating every allowed action.

Method: **start minimal on your best model, then add instructions only in
response to observed failure modes.** Don't pre-emptively pad the prompt.

## 7. Set effort/thinking deliberately

For coding and agentic, intelligence-sensitive tasks, start at high effort
(reasoning/thinking level) when the selected model/runtime exposes that control,
then dial down only if latency/cost demands it and quality holds in evals.
Don't under-power a hard task by default.

## Anti-patterns

- Padding length to seem thorough — it dilutes signal. Shorter and sharper wins.
- "Be helpful / do your best" with no contract — gives the model nothing testable.
- Negative-only prompts (a pile of "don't") with no positive target behavior.
- Burying the actual task under preamble — state the task and its output early.
- Restating the same instruction three ways — the literal model only needs once.
