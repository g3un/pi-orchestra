# Prompt engineering

Best practices for writing prompts, system prompts, and agent-profile instructions for LLM agents across providers. In this repo, the main surfaces are agent profile system prompts (`src/profiles/`) and the task/instruction strings threaded through the runtime (`buildInitialPrompt` in `src/adapters/pi-runtime.ts`).

For _what goes into the context window_ over a long task, such as compaction, note taking, and retrieval, see [context-engineering.md](./context-engineering.md).

## 1. Lead with an output contract

State what "done" looks like and how it will be judged up front.

- Specify format, length, tone, and required sections. Make it testable.
- State scope, assumptions, exclusions, and what to do when uncertain.
- Name the exact output shape and the decision rule for status, such as `success` when useful output exists, `blocked` when context is insufficient, and `failed` when the work cannot be completed.

## 2. Be explicit and literal

- Say exactly what you want in plain language. Do not rely on the model to infer it.
- If behavior is missing, the prompt probably did not ask for it. Add the instruction instead of blaming the model.
- Prefer positive instructions ("do X") over a wall of prohibitions.

## 3. Structure with clear delimiters

Use consistent section labels and delimiters so the model can separate instructions, task input, examples, and external context. XML-like tags are a good default for nested examples or injected data. Markdown headings also work when the structure is shallow and readable.

```xml
<instructions> … </instructions>
<context> … </context>
<example> … </example>
```

- Reserve tags or headings for sections that are truly distinct: instructions, context, examples, or data.
- The runtime already adds light structure with `## System prompt`, `## Task`, and `## Completion` headers in `buildInitialPrompt`. Keep new injected context clearly delimited so the model does not confuse it with instructions. Bus context arrives wrapped in `<bus_reference_context>` and is framed as _supplemental_; use the same discipline for external or peer content.

## 4. Use few-shot examples

- Three to five diverse, canonical examples wrapped in `<example>` tags beat a long list of edge cases.
- Examples show the desired output shape more clearly than abstract prose.
- Curate for variety, not exhaustiveness.

## 5. Give explicit permission to be uncertain

- Tell the model it may say "I don't know" or flag low confidence instead of guessing. This reduces hallucination.
- Make uncertainty visible with a structured signal, such as a `blocked` status plus notes on conflicts and gaps.

## 6. Write system prompts at the right altitude

A good system prompt is specific enough to guide behavior and flexible enough to leave room for judgment. Avoid both extremes:

- ❌ Hardcoded, brittle if/else logic for every case.
- ❌ Vague platitudes with no concrete signal.
- ✅ Strong heuristics plus clear boundaries, such as "treat supplied context as primary evidence; use tools only to verify or fill concrete gaps" instead of listing every allowed action.

Method: start minimal on your best model, then add instructions only after observed failures. Do not pad the prompt in advance.

## 7. Set effort and thinking deliberately

For coding and agentic tasks that need strong reasoning, start at high effort when the selected model or runtime exposes that control. Dial down only if latency or cost demands it and quality holds in evals. Do not under-power a hard task by default.

## Anti-patterns

- Padding length to seem thorough. It dilutes signal; shorter and sharper wins.
- "Be helpful" or "do your best" with no contract. The model needs something testable.
- Negative-only prompts: a pile of "don't" with no positive target behavior.
- Burying the task under preamble. State the task and output early.
- Restating the same instruction three ways. The literal model only needs it once.
