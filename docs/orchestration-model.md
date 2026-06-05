# Orchestration Model

pi-orchestra builds delegation in four layers:

1. **Bus** — shared context channel.
2. **Subagent** — isolated child agent subscribed to a bus.
3. **Workgroup** — multiple subagents working on one bus.
4. **Workflow** — ordered workgroup stages with stage synthesis.

## Bus

A `Bus` is the coordination scope for related work. It has an `id`, `name`, and
ordered `messages`.

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

A workgroup is a set of subagents spawned on the same bus for one shared goal.
Each member has a profile and may add a member-specific assignment.

Strategies:

- `compete`: one successful member can be enough.
- `synthesize`: collect complementary findings and combine them.

Main receives finish events instead of blocking on completion calls:

- Standalone subagent completions arrive as `subagent.finished` events.
- Workgroup member completions arrive as `workgroup.member_finished` events with the strategy and pending run ids.
- For `compete`, a successful member may be enough; close pending losers when appropriate.
- For `synthesize`, use each member event to decide whether to steer active members, spawn follow-up work, publish more context, or continue collecting results.

## Workflow

A workflow runs ordered stages. Each stage defines a goal, strategy, workers,
and a leader.

For each stage:

1. Create a fresh bus.
2. Spawn the worker workgroup; workers subscribe to the stage bus.
3. Collect worker results through store finish-event subscriptions in the background.
4. Spawn the stage leader to synthesize the worker results.
5. Store the leader's canonical output as the stage output.

Workflow-internal worker and leader completions are consumed by the workflow runner. Main receives a single `workflow.finished` event when the whole workflow reaches `success`, `blocked`, `failed`, or `closed`.

The next stage receives the previous stage output, not raw worker transcripts.
Each stage specifies its leader explicitly — the leader synthesizes the workers'
results into that canonical stage output.
