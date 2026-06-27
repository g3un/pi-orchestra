# Workflow Calls

Use a workflow when a flow leader should decide which child workgroups are useful
and synthesize their results.

## Basic flow

1. A supervising parent calls `workflow create` with one flow leader.
2. The flow leader calls `workflow spawn_workgroup` for useful child groups.
3. The flow leader consumes `workgroup.finished` events.
4. The flow leader calls `workflow finish` exactly once.
5. The supervising parent may call `workflow cancel` to abort and clean up.

## Example: create with a custom flow leader

The workflow `name` is the scope name for later lookup. `leader.name` is the run
name for the flow leader agent. `leader.profile.name` is the custom role/profile
name.

```json
{
  "action": "create",
  "name": "research-workflow",
  "goal": "Research and summarize the architecture options.",
  "leader": {
    "name": "research-flow-leader",
    "profile": {
      "name": "Research Flow Leader",
      "systemPrompt": "Coordinate child workgroups and synthesize their results.",
      "tools": ["workflow"]
    },
    "task": "Plan independent tracks, spawn useful workgroups, and finish with the final synthesis."
  }
}
```

## Example: create with a preset flow leader

With presets, omit `profile.name` unless you want to override the preset role
name.

```json
{
  "action": "create",
  "name": "code-review-workflow",
  "goal": "Review the proposed changes and synthesize the risks.",
  "leader": {
    "name": "review-flow-leader",
    "profile": {
      "preset": "source-code-qa",
      "tools": ["workflow", "read", "bash"]
    },
    "task": "Decide useful review tracks, spawn workgroups, and finish with findings."
  }
}
```

## Example: spawn a child workgroup

Give child group leaders the `workgroup` tool. Spawn multiple child workgroups in
parallel only when their outputs do not depend on one another.

```json
{
  "action": "spawn_workgroup",
  "workflowId": "code-review-workflow",
  "name": "security-track",
  "goal": "Review security-sensitive changes.",
  "leader": {
    "name": "security-track-leader",
    "profile": {
      "preset": "source-code-qa",
      "tools": ["workgroup", "read", "bash"]
    },
    "task": "Coordinate security reviewers and finish with the track result."
  }
}
```

## Example: finish or cancel

The flow leader owns `workflow finish`:

```json
{
  "action": "finish",
  "workflowId": "code-review-workflow",
  "status": "success",
  "summary": "The review found two medium-risk issues and no blockers."
}
```

A supervising parent owns `workflow cancel`:

```json
{
  "action": "cancel",
  "workflowId": "code-review-workflow"
}
```

## Notes

- Prefer adaptive one-at-a-time workgroup spawning when later work should depend
  on earlier results.
- Parallel child workgroups are appropriate for independent tracks, not as a
  default way to create every possible group up front.
- Main receives `workflow.finished`; workflow-internal `workgroup.finished`
  events route to the flow leader.
- For flow leader and child group leader `profile.model`, usually omit. The
  supervising parent chooses the flow leader model before `workflow create`; the
  flow leader chooses child group leader models before `workflow spawn_workgroup`.
  See `model-selection.md`.
