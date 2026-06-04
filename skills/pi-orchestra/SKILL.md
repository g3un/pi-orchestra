---
name: pi-orchestra
description: "Use when delegating work with Pi-Orchestra tools: bus, subagent, workgroup, or workflow. Helps choose the right orchestration primitive, create buses, brief child agents, use compete vs synthesize strategies, react to completion events, and avoid polling or over-delegation."
---

# Pi-Orchestra

Use Pi-Orchestra to parallelize or structure work without losing the main thread. Do not delegate trivial tasks that you can finish faster yourself.

## Tool choice

- Use `subagent` for one focused, isolated task such as review, research, planning, or an independent implementation attempt.
- Use `workgroup` when multiple agents should start together on the same goal.
  - `compete`: agents try alternative solutions; one successful result may be enough.
  - `synthesize`: agents cover complementary angles; collect and combine all useful findings.
- Use `workflow` for ordered, linear stages where later stages should consume canonical outputs from earlier stages.
- Use `bus` as the shared context scope for related subagents/workgroups. Buses are reference context, not a blocking queue or decision channel.

## Default workflow

1. Decide the smallest useful delegation unit and expected final output.
2. Create one named bus per delegated work item before `subagent` or `workgroup`.
3. Put stable shared context in the initial task/goal. Use `bus action=publish` only for new facts, constraints, artifacts, blockers, or course corrections useful to attached agents.
4. Give every child agent a specific profile, assignment, success criteria, handoff shape, and explicit tool allowlist.
5. Continue main-thread work while waiting. Pi-Orchestra completion events arrive automatically.
6. On completion:
   - For standalone subagents, consume the `subagent.finished` summary/data.
   - For `workgroup compete`, use the first clearly successful result when sufficient; close pending losers if extra work is wasteful.
   - For `workgroup synthesize`, combine complementary results and note gaps, conflicts, and confidence.
   - For `workflow`, wait for `workflow.finished` or use `workflow status` only when you need progress.

## Briefing child agents

Prefer concise, outcome-oriented tasks:

```text
Role: <specialist role>
Objective: <specific result needed>
Context: <files, commands, constraints, prior findings>
Do: <steps or focus areas>
Do not: <boundaries, destructive actions, scope exclusions>
Finish with: status success/blocked/failed, a concise summary, evidence, risks, and structured data if useful.
```

Profile defaults:

- `name`: short role name, e.g. `reviewer`, `planner`, `doc-researcher`.
- `systemPrompt`: one paragraph describing expertise, constraints, and output discipline.
- `tools`: always inject an explicit allowlist from the tools available to the main agent. Include only tools the child needs, including installed extension tool names for research/browser work. Use `[]` for supplied-context-only roles.
- `model`: omit unless the task needs a specific provider/model.

## Patterns

### Single specialist

1. `bus create` with a short name.
2. `subagent spawn` with the bus id/name, specialist profile, and focused task.
3. Incorporate the finish event. Use `subagent message` only for meaningful new guidance; avoid micromanagement.

### Alternative solution race

1. `bus create`.
2. `workgroup` with `strategy: "compete"` and 2-4 members with distinct approaches.
3. When a strong success arrives, close remaining active runs unless their outputs are still valuable.

### Multi-angle review

1. `bus create`.
2. `workgroup` with `strategy: "synthesize"` and members for complementary lenses, e.g. correctness, tests, UX/docs, risk/security.
3. Synthesize results yourself; call out disagreements and unresolved blockers.

### Linear pipeline

Use `workflow action=start` when there are explicit stages such as discover → design → implement → review. Keep stages linear; do not model branching/DAG work as a workflow.

## Gotchas

- Always create a bus before spawning related agents.
- Reuse the same bus only for agents working on the same delegated work item.
- Do not wait on or poll buses; use `bus status` only to inspect shared messages.
- Do not rely on bus messages for leader-only decisions or urgent escalation; child agents should finish with `blocked` for that.
- Keep child context bounded. Publish summaries and artifact paths, not long transcripts.
- Prefer fewer, better-briefed agents over many vague agents.

## Final response checklist

- State which orchestration primitive was used and why, if relevant.
- Include the winning/synthesized answer, not raw child transcripts.
- Mention important blockers, risks, and follow-up actions.
- Close or cancel unnecessary active runs/workflows when the task is done.
