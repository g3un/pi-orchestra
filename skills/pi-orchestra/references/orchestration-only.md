# Orchestration-only mode

Use this mode only when the user explicitly says the main agent must not implement directly or should only orchestrate. It does not change Pi-Orchestra's default behavior.

## Main-agent boundary

The main agent may:

- plan and delegate the work;
- process completion events;
- inspect diffs;
- run final verification commands; and
- create commits only when the user explicitly requests them.

The main agent must not edit or write implementation files. Preserve the user's ownership boundaries throughout the task: brief every delegated agent on those boundaries, do not overwrite or discard user changes, and keep all work within the requested scope.

## Workflow

1. Plan the smallest useful implementation phase without modifying implementation files.
2. Delegate implementation to a subagent with the editing tools it needs, following [Subagent Calls](./subagent.md). Include the user's scope and ownership boundaries in the task.
3. Wait for the matching completion event. Do not poll subagent status or buses.
4. Inspect the resulting diff. For multi-stage work, after every implementation phase delegate verification to a separate agent without `edit` or `write`; it may use `read` and `bash` to inspect the diff and run checks but must not modify implementation files.
5. If verification fails, delegate corrections to an implementation agent, then run independent read-only verification again. Follow [Failure handling](./failure-handling.md) for steering or retrying existing runs rather than duplicating its procedures here.
6. Close completed subagents when they are no longer needed.
7. After all phases pass independent verification, perform the final diff review and run the final verification commands from the main agent.
8. Commit only if the user explicitly requested a commit.

For delegation structures beyond standalone subagents, use the existing [Workgroup Calls](./workgroup.md) and [Workflow Calls](./workflow.md) references instead of recreating their lifecycle rules.
