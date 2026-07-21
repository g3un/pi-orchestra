# Failure handling

Use the existing run first. A message can retry or steer an open child without discarding its context.

## Retry a failed child

If a run is `failed` but not `closed`, send `subagent action=message` to that run. The runtime changes it back to
`running` and continues the same in-memory session context.

```json
{
  "action": "message",
  "id": "agent-auth-security-reviewer",
  "message": "Retry the failed step using the evidence already gathered."
}
```

Do not close and respawn a child just to retry it. Closing disposes the session; a replacement starts without the
previous context.

## Hand off large results

Pi-Orchestra truncates `finish` result data at 4,000 characters when it formats the handoff. For large results, have
the child write the full data to a file in the shared cwd and return its path in the result. Keep the summary short and
put the path in `data`, for example `{ "path": "reports/auth-review.md" }`.

## Steer or close a stuck child

If a child stalls or follows the wrong path, send `subagent action=message` with a concrete correction and the next
expected handoff. If it cannot recover, clean up any active descendants, led workgroup, or coordinated workflow, then
use `subagent action=close`. Closing disposes the in-memory session, so it cannot be retried afterward.
