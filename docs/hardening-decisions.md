# Hardening decisions

This note records review findings we chose to accept rather than fix in code.

## UUID/name shadowing by inactive entity ids

Pi-orchestra rejects new entity names that match any persisted entity id of the same kind. That prevents newly created entities from being permanently shadowed by id-first lookups. Existing stores are not scanned or migrated to rewrite historical inactive ids or names; schema upgrades still use the recreate-store path.
