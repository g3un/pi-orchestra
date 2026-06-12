# Hardening Decisions

This note records review findings that are intentionally accepted rather than fixed in code.

## UUID/name shadowing by inactive entity ids

Pi-orchestra rejects new entity names that match any persisted entity id in the same kind. This avoids permanent id-first lookup shadowing for newly created entities. Existing stores are not scanned or migrated to rewrite historical inactive ids/names; schema upgrades continue to use the recreate-store path.

## Recovery report includes current-session runs

`/orchestra-recovery` reports persisted active records from the local store only. It does not attempt to distinguish records owned by the current live Pi session from records left by an abandoned session, because multiple Pi sessions can share a project cwd. The command text warns that active records may belong to another live session and requires explicit user action for cleanup.
