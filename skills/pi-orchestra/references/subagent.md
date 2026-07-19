# Subagent Calls

Use a standalone subagent for one focused task that can run independently while
the main agent continues working.

## Basic flow

1. Spawn the subagent without `busId` for the default private bus.
2. The tool spawns the run as `agent-{name}`, creates `bus-agent-{name}`, and subscribes the owning scope (main for top-level spawns, or the parent run for nested spawns).
3. Continue main-thread work until `subagent.finished` arrives.
4. Use `subagent message` only for useful new guidance.
5. Use `subagent close` when the supervising parent no longer needs the run. It rejects runs with active descendants or a running led workgroup instead of cascading. On success, an unused auto-created private bus closes; a rejection leaves the run and bus unchanged.

## Example: spawn with a custom profile

The top-level `name` is the unprefixed logical name for this specific agent
instance. Standalone spawns are stored as `agent-{name}` and, when `busId` is
omitted, get a private bus named `bus-agent-{name}`. For example,
`name: "auth-security-reviewer"` creates run `agent-auth-security-reviewer`
on bus `bus-agent-auth-security-reviewer`.

```json
{
  "action": "spawn",
  "name": "auth-security-reviewer",
  "profile": {
    "name": "Security Reviewer",
    "systemPrompt": "Review code changes for security regressions. Report findings with evidence and a risk level.",
    "tools": ["read", "bash"]
  },
  "task": "Review the auth refactor for security regressions. Finish with findings, evidence, and risk level."
}
```

## Example: share an explicit bus

Create or choose a bus only when multiple standalone subagents should share the
same reference context.

```json
{
  "action": "create",
  "name": "bus-auth-review"
}
```

```json
{
  "action": "spawn",
  "name": "auth-api-compat-reviewer",
  "busId": "bus-auth-review",
  "profile": {
    "name": "API Compatibility Reviewer",
    "systemPrompt": "Review API changes for compatibility risks and migration issues.",
    "tools": ["read", "bash"]
  },
  "task": "Check whether the auth refactor changes public API behavior. Finish with compatibility findings."
}
```

## Example: message or close

Use the returned run name, typically `agent-{name}` for standalone spawns.

```json
{
  "action": "message",
  "id": "agent-auth-security-reviewer",
  "message": "Also check token refresh edge cases before finishing."
}
```

```json
{
  "action": "close",
  "id": "agent-auth-security-reviewer"
}
```

## Notes

- Use a globally unique logical `name` for each spawned agent.
- Reuse a bus only for agents working on the same delegated work item.
- Explicit/reused buses are not auto-closed by subagent finish/close; only marked auto-created standalone private buses are.
- A child can close only its direct children. For deeper trees, message the target child to clean up its descendants; if it cannot, main/root must close them bottom-up.
- Use `bus status` to inspect shared messages when needed. It shows a bounded
  latest-message view.
- Child agents receive `finish` and `publish_bus` automatically; do not include
  `bus` in profile tools.
- Omit `profile.model` to inherit the current Pi model; set it only to an exact
  `provider/model` id. The supervising caller chooses before spawn. An unknown id
  fails at spawn.
