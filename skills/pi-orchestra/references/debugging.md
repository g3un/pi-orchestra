# Pi-Orchestra Debugging

Pi-Orchestra keeps operational state in memory for the current Pi session.
There is no cross-restart resume: once the Pi session ends, active runs,
workgroups, workflows, and buses are gone.

Completion and bus events arrive automatically. Do not poll status during normal operation. Use the Pi-Orchestra tools (`status`, `message`, `finish`, `cancel`) only when you need to inspect or steer live orchestration.

## Debug log

Pi-Orchestra writes a SQLite debug log at `.pi/orchestra/debug.db`. It is
write-only from the orchestra's side: it is appended for post-hoc debugging and
is never read back to restore state. Inspect it only when diagnosing orchestra
behavior after the fact; do not rely on it to recover live orchestration state,
and do not edit it.

## Safety notes

- `.pi/` is normally gitignored and may contain sensitive task context. Do not
  paste raw debug-log contents into final answers unless needed.
- Do not assume the debug log exists in every environment; one-off runs or
  cleaned worktrees may not have one.
