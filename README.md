# Pi-Orchestra

Subagent orchestration tools for Pi.

## Install

```bash
pi install npm:@g3un/pi-orchestra
```

For a one-off run without installing:

```bash
pi -e npm:@g3un/pi-orchestra
```

## Usage

Pi-Orchestra registers four tools: `bus`, `subagent`, `workgroup`, and
`workflow`.

- Use the smallest orchestration primitive that fits the task.
- Completion events are delivered back to the main conversation, so delegated
  work can continue without polling.
- Active workflows appear in a TUI widget as `workflow [uptime] | workgroups
(done/total) | agents (done/total) | status`. Reopen it with
  `/orchestra-workflows`.
- Use `/orchestra-recovery` after a restart to inspect persisted active records
  before explicitly cancelling or closing abandoned scopes.
- Use `/orchestra-models` to list available Pi model ids. Omit `profile.model`
  to inherit the current model; see
  [model-selection.md](skills/pi-orchestra/references/model-selection.md) before
  overriding it.
- Child profiles can use presets such as `source-code-qa`,
  `external-researcher`, and `code-reviewer`, or provide a custom role prompt.

## Development

Use the Nix flake for local development and CI parity:

```bash
nix develop
corepack pnpm install
nix flake check
```

The devcontainer also enters the flake shell and installs dependencies with
Corepack/pnpm after creation. Forgejo CI and publishing run the same
`nix flake check` entrypoint.

## Core concepts

Implementation hardening trade-offs that affect recovery and compatibility are
recorded in [docs/hardening-decisions.md](docs/hardening-decisions.md).

### Bus

A bus is shared reference context for standalone subagents. Create one when
multiple standalone agents need the same evolving context. Workgroups and
workflows create their own private buses internally. `bus action=compact` removes
messages already delivered to all current subscribers.

### Subagent

A subagent is one isolated child agent with a role, task, explicit tool allowlist,
and optional model. Use it for a focused independent task such as review,
research, planning, or an alternative implementation attempt.

### Workgroup

A workgroup is a private-bus coordination scope for one shared goal. A leader can
add member agents, consume `workgroup.member_finished` events, then call
`workgroup finish` with one canonical result. A supervising parent can use
`workgroup cancel` to abort and clean up the group.

### Workflow

A workflow is led by one flow leader agent. The flow leader creates child
workgroups, uses their `workgroup.finished` results to decide the next step, and
calls `workflow finish` with the final result. It may run child workgroups in
parallel when the goal has independent tracks; otherwise prefer adaptive
one-at-a-time spawning.
