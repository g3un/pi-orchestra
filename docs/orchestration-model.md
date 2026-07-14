# Orchestration model

pi-orchestra has four orchestration entities:

- A `Bus` carries peer reference context between subscribed agents. Messages are delivered as supplemental `<bus_reference_context>`; decisions and escalation belong in `finish`, not on the bus.
- A subagent is an `AgentRun` with a profile, task, bus, parent, state, and result. Its profile sets the system prompt, tool allowlist, and optional `provider/model`; an omitted model inherits Pi's current model.
- A workgroup owns a private bus and a set of member runs. Its leader receives member results and is the only actor that calls `workgroup finish`; a supervising parent may cancel it.
- A workflow owns a coordinator and child workgroups. Only the coordinator may add workgroups or finish the workflow. Direct workflow subagents are not supported.

Persisted records use opaque ids and unique readable names. Generated names use `agent-`, `bus-`, `group-`, and `flow-`; a private bus keeps its owner's name, such as `agent-review` on `bus-agent-review`.

## Completion and cleanup

Every subagent must call `finish` with `status`, `summary`, and optional `data` after its direct children and led scopes finish. A parent may message or close a child but does not finish on its behalf. Main and parent agents receive completion events instead of polling:

- `subagent.finished`
- `workgroup.member_finished` and `workgroup.finished`
- `workflow.workgroup_finished` and `workflow.finished`

Finishing or cancelling a workgroup closes its members and bus. A workflow can finish after its child workgroups close; cancellation also closes the coordinator and remaining children. Marked standalone private buses close when no active run still uses them.

If a parent prompt settles while it owns an active direct child, the parent remains `running` with health phase `waiting`, even when that prompt ended with a provider error. A child completion message starts the parent's next prompt. Without an active child, an error left after Pi's retry or compaction recovery becomes the failure result. Otherwise, a run that stops without `finish` gets one finish-required prompt and fails if that prompt also ends without `finish`.

## Monitor

The TUI monitor shows at most three active top-level scopes and one overflow line. Workflow rows aggregate their coordinator and child workgroups, workgroup rows aggregate members on the group bus, and unrelated active subagents get their own rows.

Health is read live from child Pi sessions and is not persisted. Normal activity is implied by the agent counts. The monitor only calls out `waiting`, `retrying`, or `compacting`, plus bounded errors, failure counts, and context usage. Health observation never cancels a run.
