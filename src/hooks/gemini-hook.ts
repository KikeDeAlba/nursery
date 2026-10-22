import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { isFlowStart, step } from '../flow.ts'
import { flowDir, loadState, saveState, statePath, withSessionLock } from '../flow-store.ts'
import { HOOK_EVENTS, type FlowEnv, type HookEvent, type HookEventName, type HookResult } from '../flow-types.ts'
import { applyPlanLog, defaultPlansDir, projectName } from '../plan-log.ts'

export interface GeminiHookDeps {
  env: NodeJS.ProcessEnv
  now: () => Date
  geminiHome: string
}

function defaultDeps(): GeminiHookDeps {
  return { env: process.env, now: () => new Date(), geminiHome: agents.agentHomes(platformContext()).gemini }
}

function isHookEvent(event: string): event is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(event)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flowOff(env: NodeJS.ProcessEnv): boolean {
  return (env['NURSERY_FLOW'] ?? '').toLowerCase() === 'off'
}

function parseEvent(name: HookEventName, raw: string): HookEvent | null {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) return null
  if (typeof value['session_id'] !== 'string' || typeof value['cwd'] !== 'string') return null
  return {
    ...value,
    hook_event_name: name,
    prompt: typeof value['prompt'] === 'string' ? value['prompt'] : '',
    prompt_response: typeof value['prompt_response'] === 'string' ? value['prompt_response'] : '',
    tool_input: isRecord(value['tool_input']) ? value['tool_input'] : {},
    tool_response: isRecord(value['tool_response']) ? value['tool_response'] : {},
  } as unknown as HookEvent
}

export async function runGeminiHook(event: string, raw: string, deps: GeminiHookDeps = defaultDeps()): Promise<HookResult> {
  if (!isHookEvent(event)) return {}
  if (flowOff(deps.env)) return {}
  try {
    const parsed = parseEvent(event, raw)
    if (!parsed) return {}
    const file = statePath(flowDir(deps.geminiHome), parsed.session_id)
    const starts = parsed.hook_event_name === 'BeforeAgent' && isFlowStart(parsed.prompt)
    if (!existsSync(file) && !starts) return {}
    const env: FlowEnv = { off: false, plansDir: defaultPlansDir(deps.env, deps.geminiHome), project: projectName(parsed.cwd) }
    return await withSessionLock(file, async () => {
      const prev = await loadState(file)
      const out = step(prev, parsed, deps.now(), env)
      if (out.state !== prev) {
        if (out.state) await saveState(file, out.state)
        else await rm(file, { force: true })
      }
      await applyPlanLog(out.log)
      return out.result
    })
  } catch (error) {
    process.stderr.write(`nursery gemini-hook: ${error instanceof Error ? error.message : String(error)}\n`)
    return {}
  }
}
