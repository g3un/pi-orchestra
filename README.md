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
Subagent, workgroup-member, and workflow completions are delivered back to the
main agent as pi-orchestra events, so the main conversation stays responsive
while delegated work runs. Active workflows are also shown in a TUI progress
widget with the current stage and agent completion counts. Use
`/orchestra-workflows` to reopen the widget if needed.

## Core concepts

### Subagent

A subagent is an isolated child agent with its own role, task, optional tool allowlist, and optional model. Subagents attach to a bus so they can receive shared reference context while working independently.

Use subagents when you want to delegate a focused task, such as review, research, implementation planning, or an alternative solution attempt.

### Workgroup

A workgroup starts multiple subagents on the same bus for one shared goal. Each member can have a different profile or assignment. Member completions are delivered as `workgroup.member_finished` events with the strategy and pending run ids.

Workgroups support two strategies:

- `compete`: several agents attempt the same goal; one successful result can be enough.
- `synthesize`: agents work on complementary parts; their findings are collected and combined.

### Workflow

A workflow runs ordered workgroup stages. Each stage gets a fresh bus, starts its workers, collects results through internal finish-event subscriptions, and uses a stage leader to produce a canonical stage output. The main agent receives a single `workflow.finished` event for the whole workflow.

Use workflows for multi-step plans where later stages should depend on the summarized output of earlier stages instead of raw worker transcripts.

## Notes

- Create a `bus` before spawning related subagents or workgroups.
- Subagents report completion with `success`, `blocked`, or `failed`; completions are surfaced as pi-orchestra events.
- Use `workflow` for linear staged work, not branching/DAG execution.
