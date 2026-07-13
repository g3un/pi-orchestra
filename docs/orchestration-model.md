# Orchestration model

pi-orchestra builds delegation in four layers. Persisted entities use opaque ids and readable unique `name` values for tool prompts and user-visible output. Automatically named orchestration records use `agent-{name}`, `bus-{name}`, `group-{name}`, and `flow-{name}` prefixes. Internal private bus names preserve the owning scope prefix to avoid cross-scope collisions: standalone subagent `agent-review` uses `bus-agent-review`, workgroup `group-review` uses `bus-group-review`, and workflow `flow-review` uses `bus-flow-review`.

1. Bus: shared context channel.
2. Subagent: isolated child agent subscribed to a bus.
3. Workgroup: multiple subagents working on one bus.
4. Workflow: a coordinator agent that creates sequential workgroups dynamically.

The TUI monitor shows active top-level scopes below the editor. Workflow rows
aggregate their child workgroups and agents, workgroup rows aggregate their
agents, and only otherwise-standalone subagents get their own rows. The widget
shows at most three scopes plus one overflow line and disappears when no scope
is active.

## Bus

A `Bus` coordinates related work. It has an `id`, `name`, `state`, ordered `messages`, and optional lifecycle metadata. New buses start `open`; finishing a workgroup or finishing/closing a marked standalone private subagent bus closes the relevant bus and removes bus subscriptions. Closed bus names may be reused; open bus names still conflict.

Bus messages are peer reference context only:

- `publish_bus` sends useful findings to subscribers of the same bus.
- Subagents subscribe to their assigned bus when spawned.
- Subscribed bus context is delivered as supplemental `<bus_reference_context>`.
- `bus status` is a retrieval view over stored messages: it returns a bounded latest-message window.
- Decisions and escalation do not go through the bus. Call the `finish` tool with `status: "blocked"`.

## Subagent

A subagent is an `AgentRun`: a child agent with a profile, task, bus id, state, and optional result. Standalone `subagent spawn` accepts an optional `busId`; when omitted, the tool spawns the run as `agent-{name}`, creates a private `bus-agent-{name}` bus, marks it for standalone auto-close, and subscribes the owning scope. When that standalone run finishes or is closed, the marked private bus closes once no active runs still use it.

Profiles define the child agent's `systemPrompt`, explicit tool allowlist, and optional model. Set `profile.model` to an exact `provider/model` id, or omit it to inherit the current Pi model.

Every subagent owns its own run result and must call `finish` with `status`, `summary`, and optional `data`. A parent may steer or close a child run, but should not finish it for the child.

## Workgroup

A workgroup is a set of subagents spawned on a private coordination bus for one shared goal. `workgroup create` stores the group as `group-{name}` and creates `bus-group-{name}` internally. Persisted workgroup runs keep the bus id, leader run id, member run ids, state, and final result.

Ownership is scoped. The effective owner of a workgroup result is its leader: the leader receives member completion events and is the only actor that should call `workgroup finish`. A parent scope observes the final `workgroup.finished` output. If the parent needs to abort a scope, use `workgroup cancel`.

Main receives finish events instead of blocking on completion calls:

- Standalone subagent completions arrive as `subagent.finished` events.
- Workgroup member completions arrive as `workgroup.member_finished` events while the workgroup is running.
- The leader ends the group with `workgroup finish`, providing `status`, `summary`, and optional `data`.
- Finishing moves the workgroup through `closing` to `closed`, closes member runs, closes the bus, and emits `workgroup.finished`.

A supervising parent may use `workgroup cancel` to abort an unfinished group. `cancel` applies a default blocked result when no result exists, closes the group, closes member runs and the leader if one is present, closes the bus, and emits `workgroup.finished`.

## Workflow

A workflow is a native orchestration record for chaining workgroups. `workflow create` stores the workflow as `flow-{name}`, creates `bus-flow-{name}`, and spawns `agent-flow-{name}-coordinator`. The public tool/action names stay `workflow`; only persisted/generated entity names use the shorter `flow` prefix.

The coordinator is the only actor that may call `workflow add_workgroup` and `workflow finish`. Its tool allowlist is limited to `workflow` and `publish_bus`, so every child workgroup is tracked through the workflow record. `workflow add_workgroup` reuses the workgroup launch path and records the created workgroup id in `workflow.workgroupIds`.

When a workflow-owned workgroup closes, the coordinator receives a `workflow.workgroup_finished` event and decides whether to add another workgroup or finish. Finishing requires all child workgroups to be closed, then closes the workflow bus and emits `workflow.finished`. A supervising parent may use `workflow cancel` to close child workgroups, close the coordinator, close the workflow bus, and record a blocked result when no result exists.
