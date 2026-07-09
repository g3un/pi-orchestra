# Workgroup Calls

Use a workgroup when one leader should coordinate multiple member agents toward
one shared result. Use `workflow` instead when you need a sequence of workgroups
where later groups depend on earlier results.

## Basic flow

1. `workgroup create` stores the group as `group-{name}` and creates the private bus as `bus-group-{name}`.
2. The workgroup leader calls `workgroup add_members` with focused member tasks.
3. The leader consumes `workgroup.member_finished` events.
4. The leader calls `workgroup finish` with the canonical group output.
5. A supervising parent may call `workgroup cancel` to abort and clean up.

## Example: create a workgroup

```json
{
  "action": "create",
  "name": "review-workgroup",
  "goal": "Review the auth refactor from security and API compatibility angles."
}
```

## Example: add members

Each member needs its own custom profile and its own run `name`.

```json
{
  "action": "add_members",
  "id": "review-workgroup",
  "members": [
    {
      "name": "security-reviewer",
      "profile": {
        "name": "Security Reviewer",
        "systemPrompt": "Review code changes for security risks. Report findings with evidence.",
        "tools": ["read", "bash"]
      },
      "task": "Review security risks in the auth refactor."
    },
    {
      "name": "api-reviewer",
      "profile": {
        "name": "API Compatibility Reviewer",
        "systemPrompt": "Review code changes for API compatibility and migration risks. Report findings with evidence.",
        "tools": ["read", "bash"]
      },
      "task": "Review API compatibility risks in the auth refactor."
    }
  ]
}
```

## Example: finish the group

Only the workgroup leader should finish the group result.

```json
{
  "action": "finish",
  "id": "review-workgroup",
  "status": "success",
  "summary": "Security risk is medium; API compatibility looks safe with one migration note.",
  "data": {
    "findings": 3,
    "risk": "medium"
  }
}
```

## Example: cancel from a supervising parent

```json
{
  "action": "cancel",
  "id": "review-workgroup"
}
```

## Notes

- Do not create a bus manually for a workgroup; the private bus name preserves the group prefix, for example `bus-group-review-workgroup`.
- Do not finish a workgroup from outside its leader; cancel instead when a parent
  needs cleanup.
- Prefer 2-4 well-briefed members over many vague members.
- For member `profile.model`, omit to inherit the current Pi model; set it only
  to an exact `provider/model` id. The workgroup leader chooses before
  `add_members`. An unknown id fails at spawn.
