# Skill writing

Guidance for writing concise, reusable agent skills.

Use this doc when adding or revising a `SKILL.md` instruction package. For tool API shape, also read [tool-design.md](./tool-design.md).

## 1. Start from real work

A skill should capture a repeatable class of work, not a one-off answer.

- Extract skills from successful task runs, runbooks, issue threads, review comments, incident fixes, or user corrections.
- Add a skill only when the base agent gets the task wrong, slow, or inconsistent without reusable guidance.
- Keep each skill to one coherent unit of work. If activation boundaries or tool needs diverge, split it.

## 2. Make activation obvious

Most skill systems expose only the name and description until the skill is loaded, so the description has to carry the trigger logic.

- Prefer names that are short, lowercase, hyphenated, and specific to an action or domain.
- Write the description as "Use when..." guidance. Include user intent, task types, and near-miss boundaries.
- Keep descriptions short; they often live in every agent run's context.
- Test with realistic should-trigger and should-not-trigger prompts, including casual phrasing, file paths, partial context, and near misses.

## 3. Keep `SKILL.md` lean

Put only the core instructions in the main file:

- Goal and expected output shape.
- Core workflow, in order when order matters.
- Opinionated defaults, with short escape hatches.
- Gotchas the agent would reasonably miss.
- Short examples or templates for required formats.
- Validation steps before final output.

Move bulky material to progressive resources:

- `references/` for detailed docs, schemas, examples, and policies.
- `scripts/` for deterministic or repeatedly rewritten operations.
- `assets/` for templates or files used in outputs.

Link resources from `SKILL.md` with clear load conditions. Example: "Read `references/api-errors.md` if the API returns a non-2xx response."

## 4. Calibrate control

Match instruction detail to task risk.

- Use exact commands or scripts for fragile, destructive, or compliance-sensitive steps.
- Use heuristics when several approaches are valid and judgment matters.
- Provide defaults, not long menus of equivalent options.
- Explain non-obvious reasons when they help the agent generalize.
- Prefer reusable procedures over answers for a single case.

## 5. Validate and iterate

Treat a skill like a behavioral component.

- Compare runs with and without the skill to confirm it helps.
- Inspect traces, not only final answers. Look for false triggers, missed triggers, wasted steps, and tool confusion.
- Run bundled scripts directly and give them helpful errors.
- Add gotchas or validation steps only after seeing real failures.

## 6. Keep skills portable and safe

- Avoid provider-specific product names, model behavior, and SDK-only fields unless the skill depends on them.
- State environment requirements only when they affect execution.
- Do not store secrets in skills.
- Treat project-local skills as instructions with authority. Review them before trusting them, especially if they can steer tool use.
- Use runtime permission gates for sensitive actions; a prompt instruction is not a security boundary.

## Checklist

- [ ] The skill comes from real recurring work.
- [ ] The name and description make activation precise.
- [ ] `SKILL.md` contains only core workflow, defaults, gotchas, examples, and validation.
- [ ] Large details live in clearly referenced resources.
- [ ] Fragile steps use tested scripts or exact commands.
- [ ] Trigger and output behavior were tested on realistic examples.
- [ ] Provider-specific details were removed or isolated behind compatibility notes.
