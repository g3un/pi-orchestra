# Workflow Calls

Use a workflow when a coordinator should run workgroups sequentially and decide
the next workgroup from previous results.

Public tool/action names use `workflow`. Generated entity names use the shorter
`flow` prefix.

## Basic flow

1. `workflow create` stores the workflow as `flow-{name}`, creates `bus-flow-{name}`, and spawns `agent-flow-{name}-coordinator`.
2. The workflow coordinator calls `workflow add_workgroup` to create one child workgroup at a time.
3. The coordinator consumes `workflow.workgroup_finished` events.
4. The coordinator calls `workflow finish` after all child workgroups are closed.
5. A supervising parent may call `workflow cancel` to abort and clean up.

The coordinator's tools are only `workflow` and `publish_bus`. Do not use
`workgroup` or `subagent` directly inside a workflow; `workflow add_workgroup`
tracks child workgroups for cleanup and events.

## Example: create a workflow

```json
{
  "action": "create",
  "name": "review-flow",
  "goal": "Review the auth refactor in phases, adapting later reviews from earlier findings."
}
```

This creates names like:

- workflow: `flow-review-flow`
- bus: `bus-flow-review-flow`
- coordinator: `agent-flow-review-flow-coordinator`

## Example: coordinator adds a workgroup

Only the workflow coordinator should call this.

```json
{
  "action": "add_workgroup",
  "id": "review-flow",
  "name": "security-phase",
  "goal": "Review security risks in the auth refactor.",
  "members": [
    {
      "name": "token-reviewer",
      "profile": {
        "name": "Token Security Reviewer",
        "systemPrompt": "Review token handling for security regressions. Report findings with evidence.",
        "tools": ["read", "bash"],
        "thinkingLevel": "high"
      },
      "task": "Check token refresh, storage, expiry, and revocation edge cases."
    }
  ]
}
```

Child workgroups still use workgroup naming:

- workgroup: `group-security-phase`
- members: `agent-token-reviewer`

## Example: finish the workflow

Only the workflow coordinator should finish, and only after child workgroups are
closed.

```json
{
  "action": "finish",
  "id": "review-flow",
  "status": "success",
  "summary": "Security and compatibility phases completed; one medium-risk token issue found.",
  "data": {
    "phases": 2,
    "risk": "medium"
  }
}
```

## Example: cancel from a supervising parent

```json
{
  "action": "cancel",
  "id": "review-flow"
}
```

## Notes

- Use workflow for sequential, adaptive workgroup chains; use workgroup directly
  for one shared goal.
- Do not create workflow buses manually.
- Do not use nested workflows.
- Direct workflow subagents are not supported; create workgroups instead.
- Optional member `profile.thinkingLevel` uses Pi's native levels:
  `off|minimal|low|medium|high|xhigh|max`. Omit it to keep Pi's normal child-session behavior.
- Prefer one workgroup at a time unless the next phase truly does not depend on
  previous results.
