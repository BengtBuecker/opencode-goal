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
 *
 * OPTIONAL: independent completion verifier (opt-in via GOAL_VERIFIER_MODEL).
 * When the agent calls `goal` with `{ action: "complete" }`, and a verifier
 * model is configured, a short-lived child session running that (small,
 * cheap) model is asked to judge a completion summary the agent must supply.
 * Only on a "DONE" verdict is the goal actually marked done; on "CONTINUE"
 * the status stays "active" and the tool tells the agent why. This never
 * runs on idle/nudge cycles -- only at the moment the agent itself claims
 * the goal is finished. If the verifier call itself fails for any reason
 * (misconfigured model, provider error, timeout), completion falls back to
 * being accepted without verification -- exactly like today's unverified
 * behavior, never blocking.
 */

const DEFAULT_MAX_NUDGES = 8
const DEFAULT_VERIFIER_TIMEOUT_MS = 45_000

/** Allows overriding the loop-protection ceiling without editing this file. */
function resolveMaxNudges(): number {
  const raw = Number(process.env["GOAL_ENFORCER_MAX_NUDGES"])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_NUDGES
}

type VerifierModel = { readonly providerID: string; readonly modelID: string }

/** Verifier is OFF by default. Set GOAL_VERIFIER_MODEL="providerID/modelID" to enable it. */
function resolveVerifierModel(): VerifierModel | null {
  const raw = process.env["GOAL_VERIFIER_MODEL"]
  if (!raw) return null
  const separatorIndex = raw.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    console.error(`[goal-enforcer] GOAL_VERIFIER_MODEL must look like "providerID/modelID", got: ${raw}`)
    return null
  }
  return { providerID: raw.slice(0, separatorIndex), modelID: raw.slice(separatorIndex + 1) }
}

function resolveVerifierTimeoutMs(): number {
  const raw = Number(process.env["GOAL_VERIFIER_TIMEOUT_MS"])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_VERIFIER_TIMEOUT_MS
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function goalFilePath(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "goal", `${encodeURIComponent(sessionID)}.json`)
}

function isGoalState(value: unknown): value is GoalState {
  if (!isRecord(value)) return false
  return (
    typeof value["goal"] === "string" &&
    typeof value["started"] === "string" &&
    (value["status"] === "active" || value["status"] === "paused" || value["status"] === "done")
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
    'been achieved, call the `goal` tool with `{ action: "complete", summary: "..." }`',
    "(do not edit any file directly), then report completion to the user",
    "instead of continuing.",
  ].join("\n")
}

function buildVerificationPrompt(goal: GoalState, summary: string): string {
  return [
    "You are a strict, independent completion auditor for a coding-agent session goal.",
    "You did not do the work yourself and cannot see the session directly -- judge only",
    "from the objective and the completion summary below.",
    "",
    "<goal>",
    goal.goal,
    "</goal>",
    "",
    "<agent_completion_summary>",
    summary,
    "</agent_completion_summary>",
    "",
    "Decide whether the summary genuinely demonstrates the goal is fully achieved.",
    "Be skeptical: vague claims, partial work, or \"should work\" language without concrete",
    "evidence (specific files changed, commands run, test results, etc.) do NOT count as done.",
    "",
    "Reply with EXACTLY one of these words as the very first line, then one short",
    "sentence of reasoning on the next line:",
    "DONE",
    "or",
    "CONTINUE",
  ].join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractCreatedSessionID(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const data = result["data"]
  if (isRecord(data) && typeof data["id"] === "string") return data["id"]
  if (typeof result["id"] === "string") return result["id"]
  return undefined
}

async function fetchMessageArray(
  client: GoalClient,
  sessionID: string,
  directory: string,
): Promise<unknown[]> {
  const response = await client.session.messages({ path: { id: sessionID }, query: { directory } })
  if (Array.isArray(response)) return response
  if (isRecord(response) && Array.isArray(response["data"])) return response["data"] as unknown[]
  return []
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const info = message["info"]
    if (!isRecord(info) || info["role"] !== "assistant") continue
    const parts = message["parts"]
    if (!Array.isArray(parts)) continue
    const text = parts
      .filter((part): part is Record<string, unknown> => isRecord(part) && part["type"] === "text")
      .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

async function waitForVerifierAnswer(
  client: GoalClient,
  judgeSessionID: string,
  directory: string,
  timeoutMs: number,
): Promise<string | null> {
  const POLL_MS = 400
  const REQUIRED_STABLE_POLLS = 2
  const start = Date.now()
  let lastCount = -1
  let stableStreak = 0

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_MS)
    const messages = await fetchMessageArray(client, judgeSessionID, directory)
    const currentCount = messages.length

    if (currentCount > 0 && currentCount === lastCount) {
      stableStreak += 1
      if (stableStreak >= REQUIRED_STABLE_POLLS) {
        const text = lastAssistantText(messages)
        if (text) return text
      }
    } else {
      stableStreak = 0
      lastCount = currentCount
    }
  }
  return null
}

type GoalClient = {
  session: {
    create: (input: {
      body: { parentID: string; title: string; model: { id: string; providerID: string } }
      query: { directory: string }
    }) => Promise<unknown>
    prompt: (input: {
      path: { id: string }
      body: { parts: Array<{ type: string; text: string }> }
    }) => Promise<unknown>
    messages: (input: {
      path: { id: string }
      query: { directory: string }
    }) => Promise<unknown>
    abort: (input: { path: { id: string } }) => Promise<unknown>
  }
}

/** Runs only when GOAL_VERIFIER_MODEL is configured; throws on any failure (caller decides the fallback). */
async function runGoalVerifier(
  client: GoalClient,
  model: VerifierModel,
  timeoutMs: number,
  args: { directory: string; parentSessionID: string; goal: GoalState; summary: string },
): Promise<{ verdict: "done" | "continue"; reasoning: string }> {
  const createResult = await client.session.create({
    body: {
      parentID: args.parentSessionID,
      title: "Goal completion verifier",
      model: { id: model.modelID, providerID: model.providerID },
    },
    query: { directory: args.directory },
  })

  const judgeSessionID = extractCreatedSessionID(createResult)
  if (!judgeSessionID) throw new Error("goal verifier: session.create returned no session id")

  try {
    await client.session.prompt({
      path: { id: judgeSessionID },
      body: { parts: [{ type: "text", text: buildVerificationPrompt(args.goal, args.summary) }] },
    })

    const reply = await waitForVerifierAnswer(client, judgeSessionID, args.directory, timeoutMs)
    if (!reply) throw new Error("goal verifier: timed out waiting for a reply")

    const firstLine = reply.split("\n", 1)[0]?.trim().toUpperCase() ?? ""
    const verdict: "done" | "continue" = firstLine.startsWith("DONE") ? "done" : "continue"
    return { verdict, reasoning: reply.trim() }
  } finally {
    try {
      await client.session.abort({ path: { id: judgeSessionID } })
    } catch {
      // Best-effort cleanup only; a leftover idle judge session is harmless.
    }
  }
}

export const GoalEnforcerPlugin: Plugin = async ({ client, directory }) => {
  const maxNudges = resolveMaxNudges()
  const verifierModelAtStartup = resolveVerifierModel()

  // Per-session nudge bookkeeping, kept in memory for the plugin's lifetime.
  const nudgeCounters = new Map<string, NudgeRecord>()
  // Guards against a session firing session.idle again before our own
  // continuation prompt has finished dispatching.
  const inFlightSessions = new Set<string>()

  const goalClient = client as unknown as GoalClient

  return {
    tool: {
      goal: tool({
        description:
          "Manage THIS session's own persistent goal (independent from other sessions in the same project). " +
          "Actions: 'set' (requires 'text') starts/replaces the goal and activates idle-continuation nudges; " +
          "'show' returns the current goal/status/started time, or that none exists; " +
          "'pause' stops idle-continuation nudges without losing the goal; 'resume' re-activates it; " +
          "'clear' deletes the goal entirely; 'complete' marks it done once the work is verifiably finished." +
          (verifierModelAtStartup
            ? " An independent verifier model is configured: 'complete' REQUIRES a concrete 'summary' " +
              "of what was done and how it was verified; a small separate model judges that summary " +
              "before the goal is actually marked done, and may reject it and ask you to keep working."
            : ""),
        args: {
          action: tool.schema.enum(["set", "show", "pause", "resume", "clear", "complete"]),
          text: tool.schema.string().optional(),
          summary: tool.schema.string().optional(),
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

          const verifierModel = resolveVerifierModel()
          if (!verifierModel) {
            writeGoalState(filePath, { ...existing, status: "done" })
            return "Goal marked done for this session."
          }

          const summary = args.summary?.trim()
          if (!summary) {
            throw new Error(
              "action 'complete' requires a non-empty 'summary' while GOAL_VERIFIER_MODEL is configured: " +
                "describe concretely what you did and how you verified the goal is met.",
            )
          }

          try {
            const { verdict, reasoning } = await runGoalVerifier(
              goalClient,
              verifierModel,
              resolveVerifierTimeoutMs(),
              { directory: context.directory, parentSessionID: context.sessionID, goal: existing, summary },
            )

            if (verdict === "done") {
              writeGoalState(filePath, { ...existing, status: "done" })
              return `Goal verified and marked done for this session.\nVerifier: ${reasoning}`
            }

            return [
              "Verifier rejected this completion -- the goal is NOT marked done.",
              `Verifier: ${reasoning}`,
              'Keep working, then call the `goal` tool again with `{ "action": "complete", "summary": "..." }` once it is genuinely finished.',
            ].join("\n")
          } catch (error) {
            console.error("[goal-enforcer] goal verifier failed; accepting completion without verification", error)
            writeGoalState(filePath, { ...existing, status: "done" })
            return "Goal marked done for this session (verifier check failed, so completion was accepted without verification)."
          }
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
