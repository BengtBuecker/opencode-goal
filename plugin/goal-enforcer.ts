import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * Global goal enforcer (installed under ~/.config/opencode/plugin/, applies
 * to every project).
 *
 * Reads the state file written by the global `/goal` command
 * (~/.config/opencode/command/goal.md) and, whenever a session goes idle
 * while the goal is "active", sends one continuation message into that same
 * session so the agent keeps working instead of stopping. Anything other
 * than "active" (paused / done / no file at all) is a no-op.
 *
 * The state file itself stays per-project: it is resolved relative to the
 * `directory` OpenCode hands the plugin at runtime (the project currently
 * open), i.e. `<project>/.opencode/goal-state.json`. Only the plugin code
 * and the command are shared globally; goals never leak between projects.
 *
 * Loop protection: at most MAX_NUDGES continuations are sent per session
 * for the *same* goal (same goal text + start timestamp). Setting a new
 * goal, or pausing/resuming, is observed via the state file on every idle
 * event, so the counter only ever grows for one unchanged goal.
 */

const GOAL_STATE_RELATIVE_PATH = [".opencode", "goal-state.json"] as const

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

function isGoalState(value: unknown): value is GoalState {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record["goal"] === "string" &&
    typeof record["started"] === "string" &&
    (record["status"] === "active" || record["status"] === "paused" || record["status"] === "done")
  )
}

function readGoalState(directory: string): GoalState | null {
  const filePath = join(directory, ...GOAL_STATE_RELATIVE_PATH)
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return isGoalState(parsed) ? parsed : null
  } catch {
    // Malformed state file: treat exactly like "no goal" instead of throwing
    // out of the event hook.
    return null
  }
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
    "been achieved, update `.opencode/goal-state.json` yourself (keep `goal`",
    'and `started` unchanged, set `"status": "done"`), then report completion',
    "to the user instead of continuing.",
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
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
      if (!sessionID || inFlightSessions.has(sessionID)) return

      const goal = readGoalState(directory)
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
