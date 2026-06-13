---
name: pi-orchestra
description: "Use when delegating work with Pi-Orchestra tools: bus, subagent, workgroup, or workflow. Helps choose the right orchestration primitive, brief child agents, coordinate led workgroups, react to completion events, and avoid polling or over-delegation."
---

# Pi-Orchestra

Use Pi-Orchestra to parallelize or structure work without losing the main thread.
Do not delegate trivial tasks that you can finish faster yourself.

## Tool choice

- Use `subagent` for one focused, isolated task such as review, research,
  planning, or an independent implementation attempt.
- Use `workgroup` when one leader should coordinate multiple members toward one
  shared goal. The workgroup creates its private bus internally; the leader adds
  members, consumes member finish events, and calls `workgroup finish`. Only the
  workgroup leader should finish the workgroup result.
- Use `workflow` for adaptive multi-step goals. A flow leader creates child
  workgroups with `workflow spawn_workgroup`, uses each `workgroup.finished`
  result to decide the next group, then calls `workflow finish`. It may run
  multiple child workgroups in parallel when the goal has independent tracks;
  otherwise prefer adaptive one-at-a-time spawning. Only the flow leader should
  finish the workflow result; only its supervising parent/main should cancel the
  workflow.
- Use `bus` for standalone subagent shared context. Buses are reference context,
  not a blocking queue or decision channel.

## Default workflow

1. Decide the smallest useful delegation unit and expected final output.
2. For standalone subagents, create a named bus before `subagent spawn`.
   Workgroups and workflows create their own private buses internally.
3. Put stable shared context in the initial task/goal. Use `bus action=publish`
   only for new facts, constraints, artifacts, blockers, or course corrections
   useful to attached agents.
4. Give every child agent a specific profile, assignment, success criteria,
   handoff shape, and explicit tool allowlist.
5. Continue main-thread work while waiting. Pi-Orchestra completion events arrive
   automatically.
6. On completion:
   - For standalone subagents, consume the `subagent.finished` summary/data.
   - For standalone workgroups, consume `workgroup.member_finished` events while
     running and the final `workgroup.finished` output.
   - For workflows, wait for `workflow.finished` or use `workflow status` only
     when you need progress.
7. If the main session was lost, a completion event was missed, or you need to
   debug a child run, run `/orchestra-recovery` and read
   `references/debugging.md` for the persisted store and session transcript
   recovery workflow.

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

Profile options:

- Prefer a built-in `preset` when it fits: `source-code-qa`,
  `external-researcher`, or `code-reviewer`.
- With a preset, provide `tools` explicitly and optionally override `name` or
  `model`; do not write a duplicate `systemPrompt`.
- For custom roles, provide `name`, `systemPrompt`, `tools`, and optionally
  `model`.
- `tools`: always inject an explicit allowlist from the tools available to the
  main agent. Include only tools the child needs, including installed extension
  tool names for research/browser work. Do not include `bus`; child agents get
  `publish_bus` automatically for shared context. Use `[]` for
  supplied-context-only roles.
- `model`: usually omit so the child inherits the current Pi model. If a task needs a different strength model, first use `/orchestra-models` to see available exact `provider/model` ids. Choose lighter/faster models for simple checks or formatting, standard models for normal coding/review/research, and stronger/deeper models for broad architecture, high-risk review, ambiguous planning, or synthesis-heavy work.

## Detailed call examples

Read the reference that matches the primitive you are about to use:

- `references/subagent.md` for standalone bus + subagent calls.
- `references/workgroup.md` for workgroup create/add_members/finish/cancel calls.
- `references/workflow.md` for workflow create/spawn_workgroup/finish/cancel calls,
  including leader run names vs profile names.

## Patterns

### Single specialist

1. `bus create` with a short name.
2. `subagent spawn` with the bus name, specialist profile, and focused task.
3. Incorporate the finish event. Use `subagent message` only for meaningful new
   guidance; avoid micromanagement.

### Led workgroup

1. `workgroup create` with a short name and goal. It creates a private bus.
2. The leader calls `workgroup add_members` with 2-4 well-briefed members when
   parallel evidence, alternatives, or review lenses are useful.
3. The leader consumes `workgroup.member_finished` events, optionally adds or
   steers members, then calls `workgroup finish` with one canonical output. Do
   not finish a workgroup from outside its leader.

### Adaptive workflow

Use `workflow action=create` when the goal needs a flow leader to decide the next
workgroup based on previous outputs. Give the flow leader the `workflow` tool and
any inspection/search tools it needs.

The flow leader should:

1. Decide whether the next work is dependent or independent.
2. Call `workflow spawn_workgroup` with `workflowId` for one next useful child
   group when the previous result should shape the next step; spawn multiple
   child workgroups in parallel only when their outputs do not depend on one
   another.
3. Give each child group leader the `workgroup` tool.
4. Consume `workgroup.finished` events as they arrive, then decide whether
   another group is needed or the final answer is ready.
5. Call `workflow finish` exactly once with the final status, summary, and data.
   The flow leader owns this finish call; main or a parent scope should wait for
   `workflow.finished` rather than finishing for it.

## Things to avoid

- Do not create buses manually for workgroups or workflows; they create private
  buses internally.
- Reuse the same standalone bus only for agents working on the same delegated
  work item.
- Do not wait on or poll buses; use `bus status` only to inspect shared messages.
  Use `bus action=compact` only when you want to discard messages delivered to
  all current subscribers.
- Do not create all workflow workgroups up front unless the goal has clearly
  independent parallel tracks.
- Do not finish a scope you do not own: subagents finish themselves, workgroup
  leaders finish workgroups, and flow leaders finish workflows.
- Do not rely on bus messages for leader-only decisions or urgent escalation;
  child agents should finish with `blocked` for that.
- Keep child context bounded. Publish summaries and artifact paths, not long
  transcripts.
- Prefer fewer, better-briefed agents over many vague agents.

## Final response checklist

- State which orchestration primitive was used and why, if relevant.
- Include the winning/synthesized answer, not raw child transcripts.
- Mention important blockers, risks, and follow-up actions.
- Close or cancel unnecessary active runs/workflows when the task is done, but
  only from a supervising parent scope. A scope owner should report `blocked` or
  `failed` with `finish` rather than cancelling itself.
