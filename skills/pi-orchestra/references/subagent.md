# Subagent Calls

Use a standalone subagent for one focused task that can run independently while
the main agent continues working.

## Basic flow

1. Create or choose a standalone bus.
2. Spawn the subagent on that bus.
3. Continue main-thread work until `subagent.finished` arrives.
4. Use `subagent message` only for meaningful new guidance.
5. Use `subagent close` when the supervising parent no longer needs the run.

## Example: create a bus

```json
{
  "action": "create",
  "name": "auth-review-bus"
}
```

## Example: spawn with a preset profile

The top-level `name` is the run name for this specific agent instance. The preset
provides the role/profile name unless you override it inside `profile`.

```json
{
  "action": "spawn",
  "name": "auth-security-reviewer",
  "busId": "auth-review-bus",
  "profile": {
    "preset": "code-reviewer",
    "tools": ["read", "bash"]
  },
  "task": "Review the auth refactor for security regressions. Finish with findings, evidence, and risk level."
}
```

## Example: spawn with a custom profile

Custom profiles need a readable role/profile `name` and a `systemPrompt`.

```json
{
  "action": "spawn",
  "name": "auth-api-compat-reviewer",
  "busId": "auth-review-bus",
  "profile": {
    "name": "API Compatibility Reviewer",
    "systemPrompt": "Review API changes for compatibility risks and migration issues.",
    "tools": ["read", "bash"]
  },
  "task": "Check whether the auth refactor changes public API behavior. Finish with compatibility findings."
}
```

## Example: message or close

```json
{
  "action": "message",
  "id": "auth-security-reviewer",
  "message": "Also check token refresh edge cases before finishing."
}
```

```json
{
  "action": "close",
  "id": "auth-security-reviewer"
}
```

## Notes

- Use a globally unique run `name` for each spawned agent.
- Reuse a bus only for agents working on the same delegated work item.
- Child agents receive `finish` and `publish_bus` automatically; do not include
  `bus` in profile tools.
