# Workgroup Calls

Use a workgroup when one leader should coordinate multiple member agents toward
one shared result.

## Basic flow

1. `workgroup create` creates the private bus.
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

Members can share the same role/profile preset, but each member needs its own run
`name`.

```json
{
  "action": "add_members",
  "id": "review-workgroup",
  "members": [
    {
      "name": "security-reviewer",
      "profile": {
        "preset": "code-reviewer",
        "tools": ["read", "bash"]
      },
      "task": "Review security risks in the auth refactor."
    },
    {
      "name": "api-reviewer",
      "profile": {
        "preset": "code-reviewer",
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

- Do not create a bus manually for a workgroup.
- Do not finish a workgroup from outside its leader; cancel instead when a parent
  needs cleanup.
- Prefer 2-4 well-briefed members over many vague members.
