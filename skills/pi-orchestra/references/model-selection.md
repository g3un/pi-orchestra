# Model Selection

Usually omit `profile.model` so children inherit the current Pi model. Override
only when task difficulty or explicit cost/latency goals make it useful.

## Who chooses

The actor calling `subagent spawn`, `workgroup add_members`, or
`workflow spawn_workgroup` chooses before the child starts:

- Main chooses standalone subagent, main-owned workgroup member, and workflow
  leader models.
- Workflow leaders choose child workgroup leader models.
- Workgroup leaders choose member models.

Do not ask the child being spawned to research or choose its own model.

## How to choose

1. Run `/orchestra-models` and copy an exact `provider/model` id.
2. Use benchmark context only when it is already available or explicitly
   requested. Do not invent rankings.
3. If rankings are unknown, omit `profile.model` or ask the user.
4. Heuristic:
   - Flagship/latest: very difficult or high-risk tasks such as vulnerability
     research, CTF solving leaders, complex reverse-engineering leaders,
     architecture, leadership, high-risk review, synthesis, and unclear
     multi-step work.
   - Mid-tier coding: implementation, tests, refactors, ordinary code review,
     code-oriented pseudocode.
   - Lower-tier cheaper/faster: simple pseudocode, formatting, mechanical checks,
     low-risk fan-out.
5. If flagship/latest is needed but the current best exact id is unclear, use
   current benchmark context such as Artificial Analysis or ask the user; do not
   hardcode guessed model ids.
6. If work loops without improving, try a different available model at a similar
   strength.

Provider note: when choosing an OpenAI-family model, prefer `openai-codex/*`
first if it is available because it is OpenAI subscription-backed. It may hit
session or usage limits, so choose another available provider/model if needed.
Always confirm exact ids with `/orchestra-models <query>`.

When overriding, keep a one-line rationale near the spawn/add call or in your
coordination notes: `profile.model=<provider/model> because <capability/cost/latency reason>`.
