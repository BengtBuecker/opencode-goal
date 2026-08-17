---
description: Set, show, pause, resume, or clear THIS session's own goal (independent from every other session in the same project) via the `goal` tool.
---

The raw arguments the user typed after `/goal` are:

<arguments>
$ARGUMENTS
</arguments>

Trim the arguments, then call the `goal` tool **exactly once** with the
right parameters, and follow the matching instructions below. This
session's goal is completely independent from any other session's goal in
this project -- the tool scopes everything to the calling session
automatically, so you never need to know or reference a session id
yourself.

Never read or write `.opencode/goal/*.json` files directly with your own
Read/Write/Bash tools -- only ever go through the `goal` tool. It is what
correctly scopes state to this session.

## 1. Trimmed arguments are empty

Call `goal` with `{ "action": "show" }`.

- If the tool reports no goal exists: ask the user what goal they want to
  set. Do not call the tool again yet.
- If it reports a goal: relay the goal text, status, and start time to the
  user exactly as returned. Do nothing else.

## 2. Trimmed arguments start with "pause" (case-insensitive)

Call `goal` with `{ "action": "pause" }`. Relay the tool's response to the
user.

## 3. Trimmed arguments start with "resume" (case-insensitive)

Call `goal` with `{ "action": "resume" }`. Confirm to the user, then
immediately continue working toward the goal in this same turn (same as
step 5 below).

## 4. Trimmed arguments start with "clear" (case-insensitive)

Call `goal` with `{ "action": "clear" }`. Relay the tool's response to the
user.

## 5. Anything else (non-empty, does not match 2-4)

Call `goal` with `{ "action": "set", "text": "<the full trimmed argument
string>" }`.

Confirm the goal was set, then **immediately start working on it in this
same turn** -- do not wait for another user message. Keep working until
the goal is genuinely, verifiably done. Only then call `goal` with
`{ "action": "complete" }`, and report completion to the user.

## Rules for every branch

- Never guess or fabricate the current goal, status, or start time --
  always take them from the tool's response.
- Exactly one `goal` tool call per invocation of this command (plus,
  separately, one more `{ "action": "complete" }` call later once the work
  from step 5 is actually finished).
