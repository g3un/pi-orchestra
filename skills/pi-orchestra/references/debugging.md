# Pi-Orchestra Debugging and Recovery

Pi-Orchestra persists orchestration state in the project directory, so you can
recover context even if the main Pi session is gone or a completion event was
missed.

## Persisted files

- `.pi/orchestra/store.db` — SQLite store for orchestration entities:
  - `runs`: subagent runs, state/result, profile, task, `sessionFile`
  - `buses`: bus state and persisted bus messages
  - `bus_subscriptions`: delivery bookkeeping
  - `workgroups`: workgroup state, members, leader, result
  - `workflows`: workflow state, leader, child workgroups, result
- `.pi/orchestra/sessions/*.jsonl` — child agent conversation transcripts.

These files are local runtime artifacts. Inspect them for debugging/recovery, but
do not edit them unless you intentionally want to repair or reset local state.
Prefer Pi-Orchestra tools (`status`, `message`, `finish`, `cancel`) for live
orchestration changes. Run `/orchestra-recovery` first when you only need an
inventory of persisted active records.

## When to inspect persisted state

Use the store/session files when you need to:

- recover a child agent's final output after the main conversation was lost;
- inspect why a subagent, workgroup, or workflow failed or stopped;
- find the session transcript for a named run;
- reconstruct previous bus messages or workflow/workgroup relationships;
- check for active work after restarting Pi.

## Quick inventory

From the project root:

```bash
sqlite3 .pi/orchestra/store.db ".tables"
```

List runs with state, result status, and session file:

```bash
sqlite3 -header -column .pi/orchestra/store.db '
  SELECT
    name,
    json_extract(payload_json, "$.state") AS state,
    json_extract(payload_json, "$.result.status") AS result_status,
    json_extract(payload_json, "$.sessionFile") AS session_file
  FROM runs
  ORDER BY rowid;
'
```

List workgroups and workflows:

```bash
sqlite3 -header -column .pi/orchestra/store.db '
  SELECT name, json_extract(payload_json, "$.state") AS state,
         json_extract(payload_json, "$.result.status") AS result_status
  FROM workgroups
  ORDER BY rowid;
'

sqlite3 -header -column .pi/orchestra/store.db '
  SELECT name, json_extract(payload_json, "$.state") AS state,
         json_extract(payload_json, "$.result.status") AS result_status
  FROM workflows
  ORDER BY rowid;
'
```

Pretty-print one entity payload. Run names are unique only while runs are not
`closed`; if a name was reused, this query prefers the active/non-closed run and
then the newest closed record:

```bash
sqlite3 -noheader .pi/orchestra/store.db "
  SELECT payload_json
  FROM runs
  WHERE name = 'RUN_NAME'
  ORDER BY CASE WHEN json_extract(payload_json, '$.state') != 'closed' THEN 0 ELSE 1 END,
           rowid DESC
  LIMIT 1;
" | jq .
```

Use `workgroups` or `workflows` instead of `runs` for those entity types.

## Recover a child transcript

Find the run's session file from the store:

```bash
SESSION_FILE=$(sqlite3 -noheader .pi/orchestra/store.db "
  SELECT json_extract(payload_json, '$.sessionFile')
  FROM runs
  WHERE name = 'RUN_NAME'
  ORDER BY CASE WHEN json_extract(payload_json, '$.state') != 'closed' THEN 0 ELSE 1 END,
           rowid DESC
  LIMIT 1;
")

echo "$SESSION_FILE"
tail -n 120 "$SESSION_FILE"
```

The session file is JSONL. Use `rg`, `tail`, or `jq` depending on what you need:

```bash
rg 'finish|error|blocked|failed|summary' "$SESSION_FILE"
```

## Reconstruct scope relationships

A workgroup payload contains `leaderRunId`, `memberRunIds`, `busId`, `state`, and
`result`. A workflow payload contains `leaderRunId`, `workgroupIds`, `busId`,
`state`, and `result`.

```bash
sqlite3 -noheader .pi/orchestra/store.db \
  "SELECT payload_json FROM workgroups WHERE name = 'WORKGROUP_NAME' LIMIT 1;" | jq .

sqlite3 -noheader .pi/orchestra/store.db \
  "SELECT payload_json FROM workflows WHERE name = 'WORKFLOW_NAME' LIMIT 1;" | jq .
```

Then map run ids back to names:

```bash
sqlite3 -header -column .pi/orchestra/store.db \
  'SELECT id, name, json_extract(payload_json, "$.state") AS state FROM runs ORDER BY rowid;'
```

## Common recovery moves

- If a child finished but the event was missed: inspect `runs.result`, then use
  the summary/data in your main answer.
- If a workgroup/workflow is still running after a restart: use
  `workgroup status` or `workflow status`; cancel only from the supervising
  parent scope when cleanup is desired.
- If a run failed without a useful result: inspect its session JSONL for the last
  assistant/tool messages and decide whether to message, respawn, or proceed.
- If bus context matters: inspect `buses.payload_json`; messages are stored on
  the bus payload under `messages`. Use `bus action=compact` to remove messages
  delivered to all current subscribers.

## Safety notes

- `.pi/` is normally gitignored and may contain sensitive task context. Do not
  paste full transcripts into final answers unless needed.
- Do not assume persisted files exist in every environment; one-off runs or
  cleaned worktrees may not have prior state.
- Deleting `.pi/orchestra/store.db` resets orchestration state for the project;
  deleting `.pi/orchestra/sessions/` removes transcript recovery data.
