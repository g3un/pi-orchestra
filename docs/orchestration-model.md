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

If a parent prompt settles with an active direct child, it remains `running` with health phase `waiting`, including after provider errors. A child completion waits for a tracked, non-streaming prompt task only when the parent has finished or its health phase is `waiting`, then rechecks the run. The first message to resume an idle parent starts the next prompt. Concurrent messages steer once Pi is streaming or compacting; messages arriving during non-streaming prompt setup or settlement wait for a later normal prompt. Once that runtime FIFO is non-empty, later messages stay behind it even if the next prompt is streaming. The prompt-starting path still runs child input handlers; `handled` counts as delivery and acknowledges attached bus context. Closed runs are not resumed. After delivery, a message call reads the run from the store again, so a `success`, `blocked`, `failed`, or `closed` transition during the send does not come back as the earlier `running` snapshot.

Raw steering bypasses input handlers, extension commands, and skill/template expansion, preserving appended `<bus_reference_context>` through streaming, retry, and compaction. It uses Pi's low-level agent queue, so it is not reflected in `AgentSession` pending-message bookkeeping. Settlement-time messages instead use a runtime-owned FIFO queue, and each starts exactly once through `AgentSession.prompt()` after the preceding prompt task ends. A preflight-rejected runtime message stays at the front of the FIFO while a direct child is active. An already queued message grants one immediate retry; otherwise the queue parks until the parent is next messaged. Without an active child, the run fails rather than skipping its unaccepted content. A rejected internal finish-required prompt yields to any message queued during its preflight. A `finish` result deferred by the queue is retained on close. After the queue drains and active direct children finish, the agent gets one finish-required turn to confirm or replace it. Only that later `finish` commits a result; without confirmation, the run fails and keeps the deferred payload in failure data. Attached bus context is acknowledged only after its runtime delivery succeeds. If a message is discarded after a delivery failure, its in-memory reservation is released so a later message can carry the same bus messages again.

Without an active child, a provider error becomes the failure result after Pi finishes retry or compaction recovery. Otherwise, a run that stops without `finish` gets one finish-required prompt and fails if that prompt also ends without `finish`.

## Monitor

The TUI monitor shows at most three active top-level scopes and one overflow line. Workflow rows aggregate their coordinator and child workgroups, workgroup rows aggregate members on the group bus, and unrelated active subagents get their own rows.

Health is read live from child Pi sessions and is not persisted. Normal activity is implied by the agent counts. The monitor only calls out `waiting`, `retrying`, or `compacting`, plus bounded errors, failure counts, and context usage. Health observation never cancels a run.
