import { dirname, join } from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tool, type Plugin } from "@opencode-ai/plugin"

/**
 * Global goal enforcer + `goal` tool (installed under ~/.config/opencode/plugin/,
 * applies to every project).
 *
 * Goals are scoped PER SESSION, not per project: each session gets its own
 * state file at `<project>/.opencode/goal/<sessionID>.json`. Two sessions
 * open in the same project therefore run two completely independent goals
 * -- setting, pausing, or completing one never touches the other.
 *
 * - The `goal` tool (set/show/pause/resume/clear/complete) is what the
 *   `/goal` command (~/.config/opencode/command/goal.md) calls. It reads
 *   `context.sessionID`, which is the only reliable way to know "which
 *   session is this" from inside a slash-command prompt -- a plain prompt
 *   template has no way to introspect its own session id, so all state
 *   access must go through this tool instead of ad hoc Read/Write calls.
 * - The `event` hook listens for `session.idle` and, whenever that specific
 *   session's own goal is "active", sends one continuation message back
 *   into that same session so the agent keeps working instead of stopping.
 *
 * Loop protection: at most MAX_NUDGES continuations are sent per session for
 * the *same* goal (same goal text + start timestamp). Setting a new goal
 * resets the budget; pausing/resuming an unchanged goal does not.
 */

const DEFAULT_MAX_NUDGES = 8

/** Allows overriding the loop-protection ceiling without editing this file. */
function resolveMaxNudges(): number {
  const raw = Number(process.env["GOAL_ENFORCER_MAX_NUDGES"])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_NUDGES
}

type GoalStatus = "active" | "paused" | "done"

type GoalState = {
  readonly goal: string
  readonly status: GoalStatus
  readonly started: string
}

type NudgeRecord = {
  /** Identifies "the same goal" so pause/resume doesn't reset the budget, but a brand new goal does. */
  readonly goalKey: string
  count: number
}

function goalFilePath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "goal", `${encodeURIComponent(sessionID)}.json`)
}

function isGoalState(value: unknown): value is GoalState {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record["goal"] === "string" &&
    typeof record["started"] === "string" &&
    (record["status"] === "active" || record["status"] === "paused" || record["status"] === "done")
  )
}

function readGoalState(filePath: string): GoalState | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return isGoalState(parsed) ? parsed : null
  } catch {
    // Malformed state file: treat exactly like "no goal" instead of throwing
    // out of a tool call or the idle hook.
    return null
  }
}

/** Atomic-ish write: write to a sibling temp file, then rename over the target. */
function writeGoalState(filePath: string, state: GoalState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  renameSync(tmpPath, filePath)
}

function deleteGoalState(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  rmSync(filePath, { force: true })
  return true
}

function buildContinuationPrompt(goal: GoalState): string {
  return [
    "The active session goal is still in progress. Continue working toward it.",
    "",
    "<goal>",
    goal.goal,
    "</goal>",
    "",
    `Started: ${goal.started}`,
    "",
    "Do not repeat work that is already finished. If the goal has genuinely",
    'been achieved, call the `goal` tool with `{ action: "complete" }` (do not',
    "edit any file directly), then report completion to the user instead of",
    "continuing.",
  ].join("\n")
}

export const GoalEnforcerPlugin: Plugin = async ({ client, directory }) => {
  const maxNudges = resolveMaxNudges()

  // Per-session nudge bookkeeping, kept in memory for the plugin's lifetime.
  const nudgeCounters = new Map<string, NudgeRecord>()
  // Guards against a session firing session.idle again before our own
  // continuation prompt has finished dispatching.
  const inFlightSessions = new Set<string>()

  return {
    tool: {
      goal: tool({
        description:
          "Manage THIS session's own persistent goal (independent from other sessions in the same project). " +
          "Actions: 'set' (requires 'text') starts/replaces the goal and activates idle-continuation nudges; " +
          "'show' returns the current goal/status/started time, or that none exists; " +
          "'pause' stops idle-continuation nudges without losing the goal; 'resume' re-activates it; " +
          "'clear' deletes the goal entirely; 'complete' marks it done once the work is verifiably finished.",
        args: {
          action: tool.schema.enum(["set", "show", "pause", "resume", "clear", "complete"]),
          text: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const filePath = goalFilePath(context.directory, context.sessionID)

          if (args.action === "show") {
            const goal = readGoalState(filePath)
            return goal
              ? `Goal: ${goal.goal}\nStatus: ${goal.status}\nStarted: ${goal.started}`
              : "No goal set for this session."
          }

          if (args.action === "set") {
            const text = args.text?.trim()
            if (!text) throw new Error("action 'set' requires non-empty 'text'")
            const state: GoalState = { goal: text, status: "active", started: new Date().toISOString() }
            writeGoalState(filePath, state)
            return `Goal set for this session: ${state.goal}`
          }

          const existing = readGoalState(filePath)

          if (args.action === "pause") {
            if (!existing) return "No active goal to pause for this session."
            writeGoalState(filePath, { ...existing, status: "paused" })
            return "Goal paused for this session. Idle-continuation nudges stopped."
          }

          if (args.action === "resume") {
            if (!existing) return "No goal to resume for this session."
            writeGoalState(filePath, { ...existing, status: "active" })
            return "Goal resumed for this session."
          }

          if (args.action === "clear") {
            const existed = deleteGoalState(filePath)
            return existed ? "Goal cleared for this session." : "No goal existed for this session."
          }

          // args.action === "complete"
          if (!existing) return "No goal to complete for this session."
          writeGoalState(filePath, { ...existing, status: "done" })
          return "Goal marked done for this session."
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
      if (!sessionID || inFlightSessions.has(sessionID)) return

      const goal = readGoalState(goalFilePath(directory, sessionID))
      if (goal === null || goal.status !== "active") {
        // No goal, paused, or done: nothing to enforce. Drop any stale
        // counter so a future goal always starts with a clean budget.
        nudgeCounters.delete(sessionID)
        return
      }

      const goalKey = `${goal.started}::${goal.goal}`
      const existing = nudgeCounters.get(sessionID)
      const record: NudgeRecord = existing && existing.goalKey === goalKey ? existing : { goalKey, count: 0 }

      if (record.count >= maxNudges) {
        // Loop protection tripped for this goal: stop nudging silently.
        nudgeCounters.set(sessionID, record)
        return
      }

      inFlightSessions.add(sessionID)
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: buildContinuationPrompt(goal) }],
          },
        })
        record.count += 1
        nudgeCounters.set(sessionID, record)
      } catch (error) {
        console.error("[goal-enforcer] failed to dispatch continuation prompt", error)
      } finally {
        inFlightSessions.delete(sessionID)
      }
    },
  }
}

export default GoalEnforcerPlugin
