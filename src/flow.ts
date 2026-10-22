import path from 'node:path'
import type {
  AfterAgentEvent,
  AfterToolEvent,
  AgentOutcome,
  BeforeAgentEvent,
  BeforeToolEvent,
  FlowEnv,
  FlowState,
  HookEvent,
  HookResult,
  PlanLogEntry,
  StepOutput,
  ToolResponse,
} from './flow-types.ts'

export const MARKER = '[nursery-flow]'
export const READ_TOOLS: readonly string[] = ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'google_web_search', 'web_fetch']
export const MCP_READ_VERBS: readonly string[] = ['get', 'search', 'list', 'read', 'describe', 'view', 'query', 'fetch', 'find', 'show', 'comments', 'sites', 'count']
export const FREE_TOOLS: readonly string[] = ['update_topic', 'write_todos', 'activate_skill']
export const READ_AGENTS: readonly string[] = ['researcher', 'analyst', 'architect', 'security', 'code-reviewer', 'sre']
export const WORK_AGENTS: readonly string[] = ['developer', 'devops', 'qa-automation', 'documenter']
export const CHANGE_AGENTS: readonly string[] = ['developer', 'devops', 'documenter']
export const READ_LIMIT = 8
export const READ_LIMIT_AFTER = 3
export const MAX_VALIDATION_RETRIES = 2
export const MIN_PROPOSAL_CHARS = 80

const WRITE_TOOLS: readonly string[] = ['write_file', 'replace']
const SEARCH_TOOL = 'search_file_content'
const ACCEPTANCES = new Set([
  'acepto', 'aceptar', 'aceptado', 'aceptada', 'acepta', 'si', 'si acepto', 'dale', 'adelante', 'si adelante',
  'ok', 'okay', 'va', 'de acuerdo', 'aprobado', 'apruebo', 'procede', 'hazlo',
])

const Q = 'con ask_user (header "Propuesta", opciones "Aceptar" y "Corregir")'
const TAG = '[nursery] '

export const CONTEXT = {
  start: (p: string) => `${TAG}Flujo iniciado. Fase: explorar. Te quedan 8 lecturas propias. Siguiente: invoca al researcher si el pedido no es trivial; después pregunta tus dudas y presenta la propuesta ${Q}. Plan: ${p}`,
  explore: (n: number, p: string) => `${TAG}Fase: explorar. Te quedan ${n} lecturas propias. Siguiente: pregunta tus dudas o presenta la propuesta ${Q}. Plan: ${p}`,
  noProposal: (p: string) => `${TAG}Fase: explorar. Aún no hay una propuesta pendiente: preséntala ${Q} para que el usuario la acepte. Plan: ${p}`,
  accepted: (p: string) => `${TAG}Plan aceptado. Ejecuta cada paso con su agente (invoke_agent), en paralelo los independientes, y termina con qa-automation y code-reviewer. Tú solo escribes archivos .md. Plan: ${p}`,
  correctedText: (p: string) => `${TAG}El usuario corrigió la propuesta con este mensaje. Fase: explorar, te quedan 3 lecturas propias. Ajusta la propuesta y vuelve a preguntar ${Q}. Plan: ${p}`,
  acceptedTurn: (qa: boolean, review: boolean, p: string) => `${TAG}Fase: plan aceptado. Ejecuta los pasos con su agente (invoke_agent); tú solo escribes .md. Validación: qa-automation ${done(qa)}, code-reviewer ${done(review)}. Plan: ${p}`,
  researched: (n: number) => `${TAG}Entrega del researcher recibida: es tu base, no releas lo que reportó. Te quedan ${n} lecturas propias. Siguiente: pregunta tus dudas o presenta la propuesta ${Q}.`,
  agentFailed: (agent: string, detail: string) => `${TAG}${agent} no terminó (${truncate(detail, 120)}). Vuelve a invocarlo con el encargo ajustado o déjalo como pendiente en el resumen.`,
  validation: (qa: boolean, review: boolean) => `${TAG}Validación: qa-automation ${done(qa)}, code-reviewer ${done(review)}.`,
  corrected: (text: string) => `${TAG}El usuario corrigió: «${text.slice(0, 500)}». Ajusta la propuesta y vuelve a preguntar ${Q}. Te quedan 3 lecturas propias.`,
  correctAsk: () => `${TAG}El usuario quiere corregir la propuesta. Pregúntale qué cambiar con ask_user (type "text") y después vuelve a proponer ${Q}.`,
  dismissed: () => `${TAG}El usuario cerró la propuesta sin responder. No ejecutes nada: termina el turno y espera su respuesta.`,
}

export const REASON = {
  writeBefore: `Aún no hay plan aceptado: no escribas archivos. Presenta la propuesta ${Q}.`,
  shell: 'Antes de aceptar no se usa el shell. Lee con read_file, grep_search o glob, o delega al researcher.',
  workAgent: (agent: string) => `${agent} trabaja solo con el plan aceptado. Presenta la propuesta ${Q}.`,
  toolBefore: `Antes de aceptar el plan solo se lee, se pregunta y se delega a agentes de lectura. Presenta la propuesta ${Q}.`,
  otherAgent: 'Antes de aceptar solo puedes invocar a researcher, analyst, architect, security, code-reviewer o sre.',
  readsExplore: `Llegaste al tope de 8 lecturas. Delega lo que falte al researcher, o pregunta tus dudas y presenta la propuesta ${Q}.`,
  readsResearched: `Ya tienes la entrega del researcher. Pregunta tus dudas y presenta la propuesta ${Q}.`,
  readsCorrection: `Ya usaste las 3 lecturas de la corrección. Ajusta la propuesta y vuelve a preguntar ${Q}.`,
  readsProposed: `La propuesta está en revisión. Espera la respuesta del usuario o vuelve a proponer ${Q}.`,
  format: 'Propuesta con formato inválido. Usa ask_user con una sola pregunta header "Propuesta", type "choice", sin multiSelect, la propuesta completa en question (80 caracteres o más) y las opciones "Aceptar" y "Corregir".',
  writeAccepted: 'Plan aceptado: el código lo escriben developer o devops con invoke_agent. Tú solo puedes escribir archivos .md.',
  validate: (qa: boolean, review: boolean) => `Falta validar: lanza ${missing(qa, review)} con invoke_agent sobre los cambios y corrige lo que reporten antes de cerrar.`,
}

function done(flag: boolean): string {
  return flag ? 'hecha' : 'pendiente'
}

function missing(qa: boolean, review: boolean): string {
  if (!qa && !review) return 'qa-automation y code-reviewer'
  return qa ? 'code-reviewer' : 'qa-automation'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function isMcpRead(tool: string): boolean {
  if (!tool.startsWith('mcp_')) return false
  const last = tool.split('_').filter(Boolean).at(-1) ?? ''
  const lower = last.toLowerCase()
  return MCP_READ_VERBS.some((verb) => lower.startsWith(verb) && !/[a-z]/.test(last.charAt(verb.length)))
}

function isReadTool(tool: string): boolean {
  return READ_TOOLS.includes(tool) || tool === SEARCH_TOOL || isMcpRead(tool)
}

export function isFlowStart(prompt: string): boolean {
  return prompt.trimStart().startsWith(MARKER)
}

export function extractRequest(prompt: string): string {
  const match = /<pedido>\s*([\s\S]*?)\s*<\/pedido>/.exec(prompt)
  if (match) return match[1] ?? ''
  return prompt.replace(MARKER, '').trim()
}

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isAcceptance(text: string): boolean {
  return ACCEPTANCES.has(normalize(text))
}

export function slugify(text: string): string {
  const words = normalize(text).split(' ').filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 40) {
      if (!slug) slug = word.slice(0, 40)
      break
    }
    slug = next
  }
  return slug || 'pedido'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function planPath(env: FlowEnv, request: string, now: Date): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return path.join(env.plansDir, env.project, `${stamp}-${slugify(request)}.md`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function labels(question: Record<string, unknown>): string[] {
  const options = Array.isArray(question['options']) ? question['options'] : []
  return options.map((option) => normalize(isRecord(option) ? asString(option['label']) : asString(option)))
}

export function findProposal(toolInput: Record<string, unknown>): { index: number; text: string } | 'invalid' | null {
  const questions = (Array.isArray(toolInput['questions']) ? toolInput['questions'] : []).map((q) => (isRecord(q) ? q : {}))
  const candidates = questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => {
      const header = normalize(asString(question['header']))
      return header === 'propuesta' || header.startsWith('propuesta ')
    })
  if (candidates.length > 1) return 'invalid'
  const candidate = candidates[0]
  if (!candidate) return questions.some((question) => labels(question).includes('aceptar')) ? 'invalid' : null
  const { question, index } = candidate
  const options = labels(question)
  const text = asString(question['question'])
  const valid = question['type'] === 'choice'
    && question['multiSelect'] !== true
    && options.includes('aceptar')
    && options.includes('corregir')
    && text.trim().length >= MIN_PROPOSAL_CHARS
  return valid ? { index, text } : 'invalid'
}

function responseText(resp: ToolResponse): string {
  const content = resp.llmContent
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) ? asString(part['text']) : '')).join('')
  return ''
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error['message'] === 'string') return error['message']
  return String(error)
}

function agentResult(resp: ToolResponse): { outcome: AgentOutcome; detail: string } {
  if (resp.error !== undefined && resp.error !== null && resp.error !== false) return { outcome: 'failed', detail: errorText(resp.error) }
  const text = responseText(resp)
  if (!/^Subagent '[^']*' finished\./.test(text)) return { outcome: 'failed', detail: text.trim().split('\n')[0] ?? '' }
  const reason = /Termination Reason:\s*(\S+)/.exec(text)?.[1]
  if (reason === undefined || reason === 'GOAL') return { outcome: 'goal', detail: '' }
  return { outcome: 'partial', detail: reason }
}

export function agentOutcome(resp: ToolResponse): AgentOutcome {
  return agentResult(resp).outcome
}

export function taskOf(prompt: string): string {
  return truncate(prompt.trim().split('\n')[0] ?? '', 120)
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function patch(state: FlowState, changes: Partial<FlowState>, now: Date): FlowState {
  const keys = Object.keys(changes) as (keyof FlowState)[]
  if (keys.every((key) => same(state[key], changes[key]))) return state
  return { ...state, ...changes, updatedAt: now.toISOString() }
}

function context(hookEventName: 'BeforeAgent' | 'AfterTool', additionalContext: string): HookResult {
  return { hookSpecificOutput: { hookEventName, additionalContext } }
}

function deny(reason: string): HookResult {
  return { decision: 'deny', reason }
}

const NONE: HookResult = {}

function out(state: FlowState | null, result: HookResult = NONE, log: PlanLogEntry[] = []): StepOutput {
  return { state, result, log }
}

const ACCEPT_CHANGES: Partial<FlowState> = { phase: 'accepted', activeAgents: 0, changed: false, validation: { qa: false, review: false } }

function correction(state: FlowState): Partial<FlowState> {
  return { phase: 'explore', reads: { used: 0, limit: READ_LIMIT_AFTER }, corrections: state.corrections + 1 }
}

function start(prev: FlowState | null, event: BeforeAgentEvent, now: Date, env: FlowEnv): StepOutput {
  const at = now.toISOString()
  const request = extractRequest(event.prompt)
  const file = planPath(env, request, now)
  const state: FlowState = {
    version: 1,
    sessionId: event.session_id,
    cwd: event.cwd,
    request,
    planPath: file,
    phase: 'explore',
    startedAt: at,
    updatedAt: at,
    activeAgents: 0,
    researched: false,
    reads: { used: 0, limit: READ_LIMIT },
    proposals: 0,
    corrections: 0,
    changed: false,
    validation: { qa: false, review: false },
    retries: { validation: 0, gaveUp: false },
  }
  const log: PlanLogEntry[] = []
  if (prev && prev.phase !== 'done') {
    log.push({ kind: 'replaced', file: prev.planPath, at }, { kind: 'phase', file: prev.planPath, phase: 'replaced' })
  }
  log.push({ kind: 'create', file, at, request, cwd: event.cwd, sessionId: event.session_id })
  return out(state, context('BeforeAgent', CONTEXT.start(file)), log)
}

function beforeAgent(state: FlowState, event: BeforeAgentEvent, now: Date): StepOutput {
  const at = now.toISOString()
  const p = state.planPath
  if (state.phase === 'explore') {
    const next = patch(state, { activeAgents: 0 }, now)
    const remaining = Math.max(0, next.reads.limit - next.reads.used)
    return out(next, context('BeforeAgent', isAcceptance(event.prompt) ? CONTEXT.noProposal(p) : CONTEXT.explore(remaining, p)))
  }
  if (state.phase === 'proposed') {
    if (isAcceptance(event.prompt)) {
      return out(patch(state, ACCEPT_CHANGES, now), context('BeforeAgent', CONTEXT.accepted(p)), [
        { kind: 'accepted', file: p, at, via: 'text' },
        { kind: 'phase', file: p, phase: 'accepted' },
      ])
    }
    return out(patch(state, { ...correction(state), activeAgents: 0 }, now), context('BeforeAgent', CONTEXT.correctedText(p)), [
      { kind: 'correction', file: p, at, via: 'text', text: event.prompt.trim().slice(0, 2000) },
      { kind: 'phase', file: p, phase: 'explore' },
    ])
  }
  const next = patch(state, { activeAgents: 0 }, now)
  return out(next, context('BeforeAgent', CONTEXT.acceptedTurn(next.validation.qa, next.validation.review, p)))
}

function proposal(state: FlowState, event: BeforeToolEvent, now: Date): StepOutput {
  const found = findProposal(event.tool_input)
  if (found === null) return out(state)
  if (found === 'invalid') return out(state, deny(REASON.format))
  const proposals = state.proposals + 1
  const next = patch(state, { phase: 'proposed', proposals, reads: { used: 0, limit: READ_LIMIT_AFTER } }, now)
  return out(next, NONE, [
    { kind: 'proposal', file: state.planPath, at: now.toISOString(), version: proposals, text: found.text },
    { kind: 'phase', file: state.planPath, phase: 'proposed' },
  ])
}

function readsReason(state: FlowState): string {
  if (state.phase === 'proposed') return REASON.readsProposed
  if (state.corrections > 0) return REASON.readsCorrection
  if (state.researched) return REASON.readsResearched
  return REASON.readsExplore
}

function beforeToolExplore(state: FlowState, event: BeforeToolEvent, now: Date): StepOutput {
  const tool = event.tool_name
  const agents = state.activeAgents
  if (tool === 'invoke_agent') {
    const agent = asString(event.tool_input['agent_name'])
    if (READ_AGENTS.includes(agent)) return out(patch(state, { activeAgents: agents + 1 }, now))
    if (WORK_AGENTS.includes(agent)) return out(state, deny(REASON.workAgent(agent)))
    return out(state, deny(REASON.otherAgent))
  }
  if (tool === 'ask_user') return proposal(state, event, now)
  if (WRITE_TOOLS.includes(tool)) return out(state, deny(REASON.writeBefore))
  if (tool === 'run_shell_command') return out(state, deny(REASON.shell))
  if (isReadTool(tool)) {
    if (agents > 0) return out(state)
    if (state.reads.used < state.reads.limit) return out(patch(state, { reads: { ...state.reads, used: state.reads.used + 1 } }, now))
    return out(state, deny(readsReason(state)))
  }
  if (FREE_TOOLS.includes(tool)) return out(state)
  return out(state, deny(REASON.toolBefore))
}

function beforeToolAccepted(state: FlowState, event: BeforeToolEvent, now: Date): StepOutput {
  const tool = event.tool_name
  if (tool === 'invoke_agent') {
    const agent = asString(event.tool_input['agent_name'])
    const changes: Partial<FlowState> = CHANGE_AGENTS.includes(agent)
      ? { activeAgents: state.activeAgents + 1, changed: true, validation: { qa: false, review: false } }
      : { activeAgents: state.activeAgents + 1 }
    return out(patch(state, changes, now))
  }
  if (WRITE_TOOLS.includes(tool) && state.activeAgents === 0) {
    const file = asString(event.tool_input['file_path'])
    if (!file.toLowerCase().endsWith('.md')) return out(state, deny(REASON.writeAccepted))
    return out(state)
  }
  if (tool === 'ask_user') return proposal(state, event, now)
  return out(state)
}

function afterAgentTool(state: FlowState, event: AfterToolEvent, now: Date): StepOutput {
  const agent = asString(event.tool_input['agent_name'])
  const { outcome, detail } = agentResult(event.tool_response ?? {})
  const log: PlanLogEntry[] = [
    { kind: 'agent', file: state.planPath, at: now.toISOString(), agent, task: taskOf(asString(event.tool_input['prompt'])), outcome, detail },
  ]
  const changes: Partial<FlowState> = { activeAgents: Math.max(0, state.activeAgents - 1) }
  let message: string | null = null
  if (outcome === 'failed') {
    message = CONTEXT.agentFailed(agent, detail)
  } else if (agent === 'researcher' && state.phase !== 'accepted') {
    const limit = Math.min(state.reads.limit, state.reads.used + READ_LIMIT_AFTER)
    changes.researched = true
    changes.reads = { used: state.reads.used, limit }
    message = CONTEXT.researched(Math.max(0, limit - state.reads.used))
  } else if (state.phase === 'accepted') {
    const validation = {
      qa: state.validation.qa || (agent === 'qa-automation' && outcome === 'goal'),
      review: state.validation.review || (agent === 'code-reviewer' && outcome === 'goal'),
    }
    changes.validation = validation
    message = CONTEXT.validation(validation.qa, validation.review)
  }
  const next = patch(state, changes, now)
  return out(next, message === null ? NONE : context('AfterTool', message), log)
}

function answerOf(resp: ToolResponse, index: number): { kind: 'dismissed'; logged: boolean } | { kind: 'answer'; text: string } {
  if (resp.error !== undefined && resp.error !== null && resp.error !== false) return { kind: 'dismissed', logged: false }
  const text = responseText(resp)
  if (text.trimStart().startsWith('User dismissed')) return { kind: 'dismissed', logged: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'dismissed', logged: false }
  }
  const answers = isRecord(parsed) ? parsed['answers'] : undefined
  const answer = isRecord(answers) ? answers[String(index)] : undefined
  if (Array.isArray(answer)) return { kind: 'answer', text: answer.map(String).join(', ') }
  if (typeof answer === 'string') return { kind: 'answer', text: answer }
  return { kind: 'dismissed', logged: false }
}

function afterAsk(state: FlowState, event: AfterToolEvent, now: Date): StepOutput {
  const found = findProposal(event.tool_input)
  if (state.phase !== 'proposed' || found === null || found === 'invalid') return out(state)
  const at = now.toISOString()
  const p = state.planPath
  const answer = answerOf(event.tool_response ?? {}, found.index)
  if (answer.kind === 'dismissed') {
    return out(state, context('AfterTool', CONTEXT.dismissed()), answer.logged ? [{ kind: 'dismissed', file: p, at }] : [])
  }
  if (isAcceptance(answer.text)) {
    return out(patch(state, ACCEPT_CHANGES, now), context('AfterTool', CONTEXT.accepted(p)), [
      { kind: 'accepted', file: p, at, via: 'dialog' },
      { kind: 'phase', file: p, phase: 'accepted' },
    ])
  }
  const next = patch(state, correction(state), now)
  const phase: PlanLogEntry = { kind: 'phase', file: p, phase: 'explore' }
  if (normalize(answer.text) === 'corregir') {
    return out(next, context('AfterTool', CONTEXT.correctAsk()), [{ kind: 'correction', file: p, at, via: 'dialog', text: '' }, phase])
  }
  return out(next, context('AfterTool', CONTEXT.corrected(answer.text)), [
    { kind: 'correction', file: p, at, via: 'dialog', text: answer.text.slice(0, 2000) },
    phase,
  ])
}

function afterTool(state: FlowState, event: AfterToolEvent, now: Date): StepOutput {
  if (event.tool_name === 'invoke_agent') return afterAgentTool(state, event, now)
  if (event.tool_name === 'ask_user') return afterAsk(state, event, now)
  return out(state)
}

function afterAgent(state: FlowState, _event: AfterAgentEvent, now: Date): StepOutput {
  const base = patch(state, { activeAgents: 0 }, now)
  if (state.phase !== 'accepted' || !state.changed) return out(base)
  const { qa, review } = state.validation
  const at = now.toISOString()
  const file = state.planPath
  const attempt = state.retries.validation
  if (qa && review) {
    return out(patch(base, { phase: 'done' }, now), NONE, [
      { kind: 'validation', file, at, qa, review, result: 'done', attempt },
      { kind: 'phase', file, phase: 'done' },
    ])
  }
  if (attempt < MAX_VALIDATION_RETRIES) {
    return out(patch(base, { retries: { ...state.retries, validation: attempt + 1 } }, now), deny(REASON.validate(qa, review)), [
      { kind: 'validation', file, at, qa, review, result: 'retry', attempt: attempt + 1 },
    ])
  }
  if (!state.retries.gaveUp) {
    return out(patch(base, { retries: { ...state.retries, gaveUp: true } }, now), NONE, [
      { kind: 'validation', file, at, qa, review, result: 'gave-up', attempt },
    ])
  }
  return out(base)
}

export function step(state: FlowState | null, event: HookEvent, now: Date, env: FlowEnv): StepOutput {
  try {
    if (env.off) return out(state)
    if (event.hook_event_name === 'BeforeAgent' && isFlowStart(event.prompt)) return start(state, event, now, env)
    if (!state || state.phase === 'done') return out(state)
    switch (event.hook_event_name) {
      case 'BeforeAgent':
        return beforeAgent(state, event, now)
      case 'BeforeTool':
        return state.phase === 'accepted' ? beforeToolAccepted(state, event, now) : beforeToolExplore(state, event, now)
      case 'AfterTool':
        return afterTool(state, event, now)
      case 'AfterAgent':
        return afterAgent(state, event, now)
      default:
        return out(state)
    }
  } catch {
    return out(state)
  }
}
