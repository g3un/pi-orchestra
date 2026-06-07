# Pi-Orchestra

Subagent orchestration tools for Pi.

## Install

```bash
pi install npm:@g3un/pi-orchestra
```

For a one-off run without installing:

```bash
pi -e npm:@g3un/pi-orchestra
```

Pi-Orchestra registers four tools: `bus`, `subagent`, `workgroup`, and `workflow`.
Subagent, workgroup-member, workgroup, and workflow completions are delivered as
pi-orchestra events, so the main conversation stays responsive while delegated
work runs. Active workflows are also shown in a TUI progress widget with active
and done group/agent counts. Use `/orchestra-workflows` to reopen the widget if
needed.

## Core concepts

### Subagent

A subagent is an isolated child agent with its own role, task, explicit tool
allowlist, and optional model. Subagents attach to a bus so they can receive
shared reference context while working independently.

Use subagents when you want to delegate a focused task, such as review, research,
implementation planning, or an alternative solution attempt.

### Workgroup

A workgroup is a private-bus coordination scope for one shared goal. `workgroup
create` creates the bus internally. A leader can add member subagents as needed,
receive `workgroup.member_finished` events, then call `workgroup finish` with the
canonical group output. Finishing closes member runs and the workgroup bus. The
workgroup leader is the effective owner of the workgroup result; parent scopes
consume `workgroup.finished`. Use `workgroup cancel` to abort a workgroup from a
supervising scope; this closes members, the leader if present, and the bus.

Use workgroups when a leader should coordinate competing alternatives,
complementary research, reviews, or follow-ups before producing one result.

### Workflow

A workflow is led by one flow leader subagent. The flow leader creates child
workgroups with `workflow spawn_workgroup`, reviews each `workgroup.finished`
result, and decides whether to create another workgroup or call `workflow finish`.
It may run multiple child workgroups in parallel when the goal has independent
tracks; otherwise it should prefer adaptive one-at-a-time spawning. Each child
workgroup has its own private bus and workgroup leader.

Use workflows for adaptive multi-step goals where the next group should depend on
previous group outputs. Workflow lifecycle state mirrors workgroups
(`running`/`closing`/`closed`); final success/blocked/failed is stored in the
workflow result. Main receives one final `workflow.finished` event for the whole
workflow; workflow-internal workgroup events are routed to the flow leader.

Workflow caller ownership is hierarchical: the flow leader is the effective owner
of the workflow result and is the only actor that should call `workflow finish`.
Only the supervising parent above that owner, normally main, should call
`workflow cancel`. If the flow leader cannot complete the goal, it should finish
with `blocked` or `failed` instead of cancelling its own workflow.

## Reusable profiles

`src/profiles/` exports reusable `AgentProfile` factories:

- `createSourceCodeQaProfile`: answer repository questions from local code, tests, and docs.
- `createExternalResearcherProfile`: gather and synthesize external source material with citations and uncertainty handling.
- `createCodeReviewerProfile`: review local code or changes with findings-first output.

Profile factories require an options object with an explicit `tools` allowlist.
The main agent should inject the installed/active tool names each child actually
needs. Pass `undefined` for `name` or `model` to use the factory default.

Tool calls can use these reusable profiles through `profile.preset` instead of
writing the full system prompt each time. Supported preset names are
`source-code-qa`, `external-researcher`, and `code-reviewer`; each still
requires an explicit `tools` allowlist and may override `name` or `model`.

## Notes

- Create a `bus` only for standalone subagents; workgroups and workflows create
  their own private buses internally.
- Subagents report completion results with `success`, `blocked`, or `failed`;
  `closed` means the run has been disposed.
- `finish` belongs to the effective owner of the current scope: the subagent for
  its own run, the workgroup leader for a workgroup, and the flow leader for a
  workflow. `cancel` belongs to the supervising parent above that owner.
- Use `workflow` for flow-leader-driven adaptive work, not arbitrary DAG
  execution.
