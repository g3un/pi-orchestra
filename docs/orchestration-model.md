# Orchestration Model

pi-orchestra builds delegation in four layers:

1. **Bus** — shared context channel.
2. **Subagent** — isolated child agent subscribed to a bus.
3. **Workgroup** — multiple subagents working on one bus.
4. **Workflow** — ordered workgroup stages with stage synthesis.

## Bus

A `Bus` is the coordination scope for related work. It has an `id`, `name`, `state`, and
ordered `messages`. New buses start `open`; finishing a workgroup closes its bus and removes bus subscriptions.

Bus messages are peer reference context only:

- `publish_bus` sends useful findings to subscribers of the same bus.
- Subagents subscribe to their assigned bus when spawned.
- Subscribed bus context is delivered as supplemental `<bus_reference_context>`.
- Decisions and escalation do not go through the bus; call the `finish` tool with
  `status: "blocked"`.

## Subagent

A subagent is an `AgentRun`: a child agent with a profile, task, bus id, state,
and optional result.

Profiles define the child agent's `systemPrompt`, explicit tool allowlist, and
optional model. The runtime creates a bus subscription for each spawned subagent;
`AgentRun.busId` remains the lifecycle/query scope, not the context delivery
path.

Every subagent must call the `finish` tool with:

- `status`: `success`, `blocked`, or `failed`
- `summary`: concise handoff text
- `data`: optional structured output

While a subagent is working, its state is `running`. Calling `finish` records the
result status and returns the reusable run to `idle`, so the leader can message it
again without recreating the session. `closed` is separate and means the run has
been disposed.

## Workgroup

A workgroup is a set of subagents spawned on a private coordination bus for one shared goal. `workgroup create` creates that bus internally; callers do not create a bus first. Each member is an `AgentRun` with its own task. Persisted workgroup runs keep the bus id, keep the leader as a subagent run id when an agent created the group, or `null` when main created it, keep members as subagent run ids, and record workgroup `state` plus final `result`. The leader id is routing metadata, not a permission boundary.

Main receives finish events instead of blocking on completion calls:

- Standalone subagent completions arrive as `subagent.finished` events.
- Workgroup member completions arrive as `workgroup.member_finished` events with pending run ids while the workgroup is running.
- The workgroup leader decides whether one result is enough, members should be closed, more members should be spawned, active members should be steered, or more context should be published.
- The leader ends the group with `workgroup action=finish`, providing `status`, `summary`, and optional `data`. Finishing moves the workgroup through `closing` to `closed`, closes all member runs, closes the bus, suppresses cleanup-only member finish events, and emits `workgroup.finished` with the final output.

## Workflow

A workflow runs ordered stages. Each stage defines a goal and leader.

For each stage:

1. Create a fresh private bus for the stage.
2. Create a persisted stage workgroup on that bus.
3. Spawn the stage leader and attach it to the workgroup as `leaderRunId`.
4. The leader uses `workgroup add_members` to create member subagents as needed.
5. The leader normally calls `workgroup finish` with the stage's final output; the workflow stores that workgroup result as the canonical stage output and closes the leader. If the leader's own `finish` payload arrives first, the workflow can still use that as a fallback stage output.

Workflow-internal member and leader completions are not sent to main as member events. Workflow-internal `workgroup.finished` outputs are consumed as stage outputs. Main receives a single `workflow.finished` event when the whole workflow reaches `success`, `blocked`, `failed`, or `closed`.

The next stage receives the previous stage output, not raw member transcripts. Each stage specifies its leader explicitly; the leader decides how many members to create and when the stage has enough evidence to finish.
