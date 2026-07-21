---
name: pi-orchestra
description: "Use whenever using Pi-Orchestra: bus, subagent, workgroup, workflow, child agents, or model overrides."
---

# Pi-Orchestra

Use Pi-Orchestra to parallelize or structure work without losing the main thread.
Do not delegate trivial tasks that you can finish faster yourself.

## Tool choice

- Use `subagent` for one focused, isolated task such as review, research, planning, or an independent implementation attempt.
- Use `workgroup` when one leader should coordinate multiple members toward one shared goal. The workgroup creates its private bus internally; the leader adds members, consumes member finish events, and calls `workgroup finish`.
- Use `workflow` when a coordinator should run workgroups sequentially and decide the next workgroup from prior results. The workflow creates `flow-{name}`, `bus-flow-{name}`, and `agent-flow-{name}-coordinator` internally.
- Use `bus` for standalone subagent shared context. Buses are reference context, not a blocking queue or decision channel.

## Default flow

1. Decide the smallest useful delegation unit and expected final output.
2. For standalone subagents, omit `busId` for the default private bus. Provide `busId` only to reuse an existing shared bus. Workgroups and workflows create their own private buses internally.
3. Put stable shared context in the initial task/goal. Use `bus action=publish` only for useful new facts, constraints, artifacts, blockers, or course corrections.
4. Give every child agent a specific profile, assignment, success criteria, handoff shape, and explicit tool allowlist. Do not include `bus`; child agents get `publish_bus` automatically.
5. After starting delegated work, continue useful main-thread work. When none remains, yield and wait for the matching completion event instead of polling status.
6. Consume `subagent.finished`, `workgroup.member_finished`, `workgroup.finished`, `workflow.workgroup_finished`, and `workflow.finished` events.

## References

- `references/subagent.md` for standalone bus + subagent calls.
- `references/failure-handling.md` for retrying or steering child runs and handing off large results.
- `references/workgroup.md` for workgroup create/add_members/finish/cancel calls.
- `references/workflow.md` for workflow create/add_workgroup/finish/cancel calls.

## Things to avoid

- Do not create buses manually for workgroups or workflows; they create private buses internally.
- Reuse the same standalone bus only for agents working on the same delegated work item.
- Do not poll `subagent status`, `workgroup status`, or `workflow status` to detect completion. Use status only for explicit inspection or debugging.
- Do not wait on or poll buses; use `bus status` only to inspect shared messages.
- Do not finish a scope you do not own: subagents finish themselves, workgroup leaders finish workgroups, workflow coordinators finish workflows.
- Prefer fewer, better-briefed agents over many vague agents.
