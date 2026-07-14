# Hardening decisions

This note records review findings we chose to accept rather than fix in code.

## UUID/name shadowing by inactive entity ids

Pi-orchestra rejects new entity names that match any persisted entity id of the same kind. That prevents newly created entities from being permanently shadowed by id-first lookups. Existing stores are not scanned or migrated to rewrite historical inactive ids or names; schema upgrades still use the recreate-store path.

## Monitor failure boundaries

Initial monitor render failures are cleaned up and rethrown so Pi can report them. Automatic post-tool rendering relies on Pi's extension-event boundary to isolate and report handler failures. The monitor retries on the next orchestration tool completion rather than using a permanent failure latch, so transient UI/context failures can recover. Add backoff only if retries become measurably expensive.

`AgentStore` subscription cleanup callbacks are required to be idempotent and non-throwing. The monitor therefore releases its run, workflow, and workgroup subscriptions sequentially without per-callback exception handling. A future store adapter must preserve this contract or normalize its cleanup callbacks before returning them.
