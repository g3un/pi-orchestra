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

Pi-Orchestra registers four tools: `bus`, `subagent`, `workgroup`, and `workflow`.

- Use the smallest orchestration primitive that fits the task.
- Pi sends completion events back to the main conversation, so delegated work
  can continue without polling.
- Active orchestration appears in a compact TUI widget below the editor. It shows
  up to three top-level workflows, workgroups, or subagents without repeating
  nested scopes; reopen it with `/orchestra-monitor`.
- Child profiles are always custom: a `name`, a `systemPrompt`, and a `tools`
  allowlist. Set `profile.model` to an exact `provider/model` id, or omit it to
  inherit the current Pi model. Set `profile.thinkingLevel` to one of
  `off|minimal|low|medium|high|xhigh|max`, or omit it to keep Pi's normal child-session behavior.

## Development

Use the Nix flake for local development and CI parity:

```bash
nix develop
corepack pnpm install
nix flake check
```

The devcontainer also enters the flake shell and installs dependencies with
Corepack/pnpm after creation.

## Core concepts

### Bus

A bus is shared reference context for standalone subagents. Omit `busId` on a standalone `subagent spawn` to create a private bus from the prefixed run name. For example, `name: "review"` creates run `agent-review` on bus `bus-agent-review`, then subscribes the owning scope (main, or the parent run for nested spawns). Create or pass an explicit bus only when multiple standalone agents need the same changing context. Workgroups and workflows create their own private buses internally. `bus status` shows a bounded latest-message view (the latest ~10 messages, with long text truncated).

### Subagent

A subagent is one isolated child agent with a role, task, explicit tool allowlist,
and optional model/thinking level. Use it for a focused independent task such as
review, research, planning, or an alternative implementation attempt.

### Workgroup

A workgroup is stored as `group-{name}` and uses a private bus to coordinate one shared goal. A leader can add member agents, consume `workgroup.member_finished` events, then call `workgroup finish` with one canonical result. A supervising parent can use `workgroup cancel` to abort and clean up the group.

### Workflow

A workflow chains workgroups through a coordinator agent. `workflow create` stores the workflow as `flow-{name}`, creates `bus-flow-{name}`, and spawns `agent-flow-{name}-coordinator`. The coordinator uses `workflow add_workgroup` one step at a time, waits for `workflow.workgroup_finished`, then calls `workflow finish` when done. Direct workflow subagents are intentionally not supported; use child workgroups.
