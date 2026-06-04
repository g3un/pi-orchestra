# Profile Writing

Guidance for authoring reusable agent profiles in `src/profiles/`.

In this repo, an `AgentProfile` has `name`, `systemPrompt`, explicit `tools`,
and optional `model`. For prompt wording details, also read
[prompt-engineering.md](./prompt-engineering.md). For context policy, read
[context-engineering.md](./context-engineering.md).

## 1. Define the job before the persona

A profile should describe a stable responsibility, not a personality.

- Name the agent's job, scope, and operating mode in the first sentence.
- State what the profile owns and what it must leave to other agents or the
  caller.
- Split profiles when responsibilities, tool sets, or context policies conflict.
- Avoid generic persona filler; it adds tokens without a testable behavior.

## 2. Lead with a contract

Every profile needs a clear answer to "what counts as done?"

- Specify the output shape, required fields, detail level, and tone.
- Define completion states and escalation paths. For pi-orchestra, prefer the
  existing `success`, `blocked`, and `failed` vocabulary when the profile
  produces an `AgentResult`.
- Tell the agent how to report uncertainty, conflicts, missing context, and
  assumptions.
- Keep the contract testable enough that a unit test can assert the critical
  prompt clauses exist.

## 3. Assign tools deliberately

Tools are part of the profile's behavior, not a convenience bucket.

- Give each spawned profile an explicit smallest tool set that can do its job.
- Do not rely on default tools; `tools` must be specified by the caller.
- When using a reusable profile, the main agent must inject the concrete
  installed or active tool names needed for that child task.
- Separate data tools, action tools, and orchestration tools in your reasoning.
- If a profile should not inspect files, run commands, or research, set
  `tools: []` and say that boundary explicitly in the prompt.
- For write actions, destructive actions, or external side effects, rely on
  runtime permission gates and human review. Do not depend only on prompt text.

## 4. Set a context policy

Profiles in an orchestra mostly succeed or fail by how they treat context.

- Say which context sources are authoritative and which are supplemental.
- State whether the agent may retrieve new context or must use only supplied
  context. The `stage-leader` profile is the restrictive example.
- Define handoff behavior: synthesize durable findings, do not pass raw
  transcripts unless the downstream task needs them.
- Keep large reference material out of the system prompt; load it through tools,
  bus messages, or task-specific context when needed.

## 5. Choose model and autonomy last

Start from behavior, then select runtime options.

- Leave `model` undefined unless the profile truly needs an override.
- Establish quality with a capable model/runtime first, then lower cost or
  latency only after evals show the profile still meets its contract.
- Prefer a simpler single profile when instructions and tools stay coherent.
  Add routing, workers, or specialized profiles only when complexity improves
  measured outcomes.
- Include stopping conditions or blocker behavior when the runtime allows
  long-running loops.

## 6. Evaluate profiles as code

- Add or update tests for the factory: default name, optional model override,
  explicit tool policy, and critical prompt clauses.
- Test representative tasks and near misses, including insufficient context.
- Inspect traces for tool misuse, context drift, verbosity, and premature
  success.
- Revise prompts in response to observed failures; do not pad profiles for
  hypothetical edge cases.

## Checklist

- [ ] The profile has one stable responsibility.
- [ ] The system prompt states scope, boundaries, output contract, and
      uncertainty handling.
- [ ] The explicit tool list is minimal and matches the prompt.
- [ ] Context source priority and retrieval rules are explicit.
- [ ] `model` is omitted unless an override is justified.
- [ ] Tests cover defaults, overrides, tool policy, and critical prompt clauses.
