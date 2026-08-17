---
description: Set, show, pause, resume, or clear the active session goal that gets automatically re-enforced on every idle phase.
---

You are handling the `/goal` slash command. The raw arguments the user typed
after `/goal` are:

<arguments>
$ARGUMENTS
</arguments>

The goal state lives in exactly one JSON file, relative to the current
project's root (not this global command file's own location):

```
.opencode/goal-state.json
```

Trim the arguments and follow this decision tree. Only `pause`, `resume`,
and `clear` are keywords (matched case-insensitively against the start of
the trimmed string); everything else is literal goal text.

## 1. Trimmed arguments are empty

- Try to read `.opencode/goal-state.json` with your file tools.
- **File does not exist:** ask the user what goal they want to set. Do
  **not** create the file yet. Stop here and wait for their reply.
- **File exists and is valid:** show a short summary, e.g.
  `Goal: <goal> (status: <status>, started: <started>)`. Do not modify
  the file. Stop here.
- **File exists but is not valid JSON with the expected shape:** tell the
  user the state file is corrupted and treat it as if no goal exists.

## 2. Trimmed arguments start with "pause" (case-insensitive)

- Read `.opencode/goal-state.json`.
- If it does not exist, tell the user there is no active goal to pause
  and stop.
- Otherwise keep the existing `goal` and `started` values unchanged, set
  `"status": "paused"`, and write the file back as pretty-printed JSON
  (2-space indent).
- Confirm to the user that the goal is paused and that automatic
  continuation nudges have stopped.

## 3. Trimmed arguments start with "resume" (case-insensitive)

- Read `.opencode/goal-state.json`.
- If it does not exist, tell the user there is no goal to resume and stop.
- Otherwise keep the existing `goal` and `started` values unchanged, set
  `"status": "active"`, and write the file back as pretty-printed JSON.
- Confirm the goal is active again, then immediately continue working
  toward it in this same turn (same as step 5 below).

## 4. Trimmed arguments start with "clear" (case-insensitive)

- Delete `.opencode/goal-state.json` if it exists. It is not an error if
  it is already missing.
- Confirm to the user that the goal was cleared and that automatic
  continuation nudges are disabled.

## 5. Anything else (non-empty, does not match 2-4)

Treat the **entire** trimmed argument string as the new goal text.

- Create the `.opencode` directory (inside the current project) if it
  does not exist, then write `.opencode/goal-state.json`, completely
  overwriting any previous content, with exactly this shape:

  ```json
  {
    "goal": "<the goal text you were given, JSON-escaped>",
    "status": "active",
    "started": "<current UTC time as an ISO 8601 string>"
  }
  ```

  A new goal always replaces whatever was there before, regardless of
  its previous status.
- Confirm the goal was set, then **immediately start working on it in
  this same turn** — do not wait for another user message. Keep working
  until the goal is genuinely, verifiably done. Only then update
  `.opencode/goal-state.json` yourself (same shape, `goal`/`started`
  unchanged) with `"status": "done"`, and report completion to the user.

## Rules for every branch

- The file must always be valid JSON with exactly the keys `goal`,
  `status`, `started`. `status` is one of `active`, `paused`, `done`.
- Never invent a `goal` or `started` value — read the real file content.
- This command only reads/writes that one JSON file (per-project, under
  the current project's `.opencode/` directory) with your normal file
  tools (Read/Write/Bash). It does not call any plugin or external API
  directly. Even though this command file lives in the global OpenCode
  config directory, the goal state itself never leaves the project you
  are currently working in.
