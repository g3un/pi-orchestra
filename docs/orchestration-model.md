# Orchestration Model

pi-orchestra builds delegation in four layers:

1. **Bus** — shared context channel.
2. **Subagent** — isolated child agent attached to a bus.
3. **Workgroup** — multiple subagents working on one bus.
4. **Workflow** — ordered workgroup stages with stage synthesis.

## Bus

A `Bus` is the coordination scope for related work. It has an `id`, `name`, and
ordered `messages`.

Bus messages are peer reference context only:

- `publish_bus` sends useful findings to sibling agents on the same bus.
- Bus context is injected as supplemental `<bus_reference_context>`.
- Decisions and escalation do not go through the bus; call the `finish` tool with
  `status: "blocked"`.

## Subagent

A subagent is an `AgentRun`: a child agent with a profile, task, bus id, state,
and optional result.

Profiles define the child agent's `systemPrompt`, optional tool allowlist, and
optional model. The runtime attaches each subagent to exactly one bus.

Every subagent must call the `finish` tool with:

- `status`: `success`, `blocked`, or `failed`
- `summary`: concise handoff text
- `data`: optional structured output

State follows the result status. `closed` is separate and means the run has been
disposed.

## Workgroup

A workgroup is a set of subagents spawned on the same bus for one shared goal.
Each member has a profile and may add a member-specific assignment.

Strategies:

- `compete`: one successful member can be enough.
- `synthesize`: collect complementary findings and combine them.

Leaders collect results with bus wait actions:

- `wait_next`: handle terminal runs as they finish.
- `wait_settled`: wait until every attached run is terminal.

## Workflow

A workflow runs ordered stages. Each stage defines a goal, strategy, workers,
and optional leader.

For each stage:

1. Create a fresh bus.
2. Spawn the worker workgroup.
3. Collect worker results.
4. Spawn a restricted stage leader.
5. Store the leader's canonical output as the stage output.

The next stage receives the previous stage output, not raw worker transcripts.
If no leader is provided, `createStageLeaderProfile` supplies a restricted
leader with no tools.
