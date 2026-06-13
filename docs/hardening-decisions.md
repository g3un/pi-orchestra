# Hardening Decisions

This note records review findings that are intentionally accepted rather than fixed in code.

## UUID/name shadowing by inactive entity ids

Pi-orchestra rejects new entity names that match any persisted entity id in the same kind. This avoids permanent id-first lookup shadowing for newly created entities. Existing stores are not scanned or migrated to rewrite historical inactive ids/names; schema upgrades continue to use the recreate-store path.

## Recovery report includes current-session runs

`/orchestra-recovery` reports persisted active records from the local store and labels records tied to the current runtime with `session=current` when live run ids are available. It still does not auto-clean those records or treat current-session ownership as exclusive, because multiple Pi sessions can share a project cwd. The command text warns that active records may belong to another live session and requires explicit user action for cleanup.
