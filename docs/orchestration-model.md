# Orchestration Model

pi-orchestra builds delegation in four layers. Persisted entities use opaque
UUIDv7 `id` values for sortable uniqueness and readable unique `name` values for
tool prompts and user-visible output.

1. **Bus** — shared context channel.
2. **Subagent** — isolated child agent subscribed to a bus.
3. **Workgroup** — multiple subagents working on one bus.
4. **Workflow** — adaptive workgroups coordinated by a flow leader.

## Bus

A `Bus` is the coordination scope for related work. It has an `id`, `name`,
`state`, and ordered `messages`. New buses start `open`; finishing a workgroup
closes its bus and removes bus subscriptions.

Bus messages are peer reference context only:

- `publish_bus` sends useful findings to subscribers of the same bus.
- Subagents subscribe to their assigned bus when spawned.
- Subscribed bus context is delivered as supplemental `<bus_reference_context>`.
- Delivery bookkeeping uses a contiguous watermark plus out-of-order delivered
  ids, so later steered messages do not cause earlier skipped messages to be
  lost.
- `bus action=compact` removes messages that every current subscriber has
  received; it is an explicit retention operation, not automatic cleanup.
- Decisions and escalation do not go through the bus; call the `finish` tool with
  `status: "blocked"`.

## Subagent

A subagent is an `AgentRun`: a child agent with a profile, task, bus id, state,
and optional result.

Profiles define the child agent's `systemPrompt`, explicit tool allowlist, and
optional model. Omit `profile.model` to inherit the current Pi model; when a
child needs a different model strength, use `/orchestra-models` and copy an exact
available `provider/model` id. The runtime creates a bus subscription for each
spawned subagent; `AgentRun.busId` remains the lifecycle/query scope, not the
context delivery path.

Every subagent is the effective owner of its own run result and must call the
`finish` tool with:

- `status`: `success`, `blocked`, or `failed`
- `summary`: concise handoff text
- `data`: optional structured output

A parent may steer, close, or otherwise clean up a child run, but it should not
finish the child run for it. If a child cannot proceed, it should finish with
`blocked` or `failed` so the parent can decide the next higher-level action.

While a subagent is working, its state is `running`. Calling `finish` records the
result status (`success`, `blocked`, or `failed`). `closed` is separate and means
the run has been disposed.

## Workgroup

A workgroup is a set of subagents spawned on a private coordination bus for one shared goal. `workgroup create` creates that bus internally; callers do not create a bus first. Each member is an `AgentRun` with its own task. Persisted workgroup runs keep the bus id, keep the leader as a subagent run id when an agent created the group, or `null` when main created it, keep members as subagent run ids, and record workgroup `state` plus final `result`.

Ownership is scoped. The effective owner of a workgroup result is its leader: the leader receives member completion events and is the only actor that should call `workgroup action=finish`. A parent scope observes the final `workgroup.finished` output; it should not finish the child group for the leader. If the parent needs to abort a scope, use `workgroup action=cancel` as a higher-level cleanup action.

Main receives finish events instead of blocking on completion calls:

- Standalone subagent completions arrive as `subagent.finished` events.
- Workgroup member completions arrive as `workgroup.member_finished` events while the workgroup is running; formatted event text shows pending run names.
- The workgroup leader decides whether one result is enough, members should be closed, more members should be spawned, active members should be steered, or more context should be published.
- The leader ends the group with `workgroup action=finish`, providing `status`, `summary`, and optional `data`. Finishing moves the workgroup through `closing` to `closed`, closes all member runs, closes the bus, suppresses cleanup-only member finish events, and emits `workgroup.finished` with the final output.

A supervising parent may use `workgroup action=cancel` to abort an unfinished group. `cancel` applies a default result `{ status: "blocked", summary: "Workgroup cancelled." }` when no result exists, then moves the workgroup through `closing` to `closed`, closes all member runs (and the leader if one is present), closes the bus, and emits `workgroup.finished`.

## Workflow

A workflow is led by one flow leader subagent. Persisted workflow runs mirror the
workgroup lifecycle shape: they store the workflow bus id, the flow leader run id,
child workgroup ids, flow-leader-authored `statusLine`, `state` (`running`,
`closing`, `closed`), and final `result`. The final success/blocked/failed status
lives in `result.status`, not in workflow state. Child outputs stay on their
`WorkgroupRun.result`; the workflow points to
those runs with `workgroupIds` instead of duplicating a workflow-specific
workgroup result shape. Workflows do not persist a separate leader spec; once
started, the leader is an `AgentRun`.

Workflow flow:

1. `workflow create` creates a private workflow bus and spawns the flow leader.
2. The flow leader uses `workflow update_status` with `workflowId` to maintain a
   one-line current status for monitors. The monitor displays this value as-is
   alongside workflow name, uptime, and derived done/total workgroup and agent
   counts.
3. The flow leader uses `workflow spawn_workgroup` with `workflowId` to create
   the next child workgroup when current evidence shows it is useful, or several
   child workgroups in parallel when the goal has independent tracks whose
   outputs do not depend on one another.
4. Each child workgroup gets its own private bus and its own workgroup leader.
5. The workgroup leader uses `workgroup add_members` and `workgroup finish` to
   coordinate members and produce the group output.
6. Workflow-internal `workgroup.finished` events are routed to the flow leader,
   not main. Workgroup leader run finishes are not separately routed as
   `subagent.finished` to the flow leader. The flow leader uses group outputs to
   decide the next group or final workflow result.
7. The flow leader calls `workflow finish` with `status`, `summary`, and optional
   `data` when the overall goal is complete, blocked, or failed.

Workflow ownership follows the same scoped rule. The flow leader is the effective
owner of the workflow result and is the only actor that should call
`workflow action=finish`. The supervising parent above the flow leader, normally
main, is the only actor that should call `workflow action=cancel`. The flow
leader should not cancel its own workflow; if it cannot proceed, it should finish
with `blocked` or `failed` and let the parent decide whether any broader cleanup
is needed. Parallel child workgroups are a planning choice for independent
tracks, not a requirement to create every possible group up front.

Closing a workflow moves it through `closing`, closes every child workgroup,
closes all child buses, closes the workflow bus, closes child group leaders and
the flow leader, then emits one `workflow.finished` event to main. Standalone
workgroup events still go to main; workflow-internal workgroup events stay inside
the workflow control loop. Child subagents spawned by another subagent route
`subagent.finished` to the active parent run; if that parent is inactive inside a
workflow bus, the event is suppressed rather than leaking to main. Routed child
events are best-effort: a synchronous routing refusal can fall back to main when
that is safe, while asynchronous parent-message failures are swallowed to avoid
crashing store subscribers.
