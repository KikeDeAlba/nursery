import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  CHANGE_AGENTS,
  CONTEXT,
  FREE_TOOLS,
  MARKER,
  READ_AGENTS,
  READ_LIMIT,
  READ_TOOLS,
  REASON,
  WORK_AGENTS,
  agentOutcome,
  extractRequest,
  findProposal,
  failResult,
  isAcceptance,
  isFlowStart,
  isMcpRead,
  normalize,
  planPath,
  slugify,
  step,
  taskOf,
} from '../src/flow.ts'
import type { FlowEnv, FlowState, HookEvent, HookResult, StepOutput, ToolResponse } from '../src/flow-types.ts'

const ENV: FlowEnv = { off: false, plansDir: '/plans', project: 'demo' }
const NOW = new Date(2026, 9, 22, 9, 5)
const LATER = new Date(2026, 9, 22, 9, 30)
const AT = LATER.toISOString()
const BASE = { session_id: 's1', cwd: '/repo' }
const Q = 'con ask_user (header "Propuesta", opciones "Aceptar" y "Corregir")'
const PROPOSAL_TEXT = 'Agregar el endpoint de pagos en src/payments con su prueba; riesgo bajo. Pasos: developer, qa-automation, code-reviewer.'

function beforeAgent(prompt: string): HookEvent {
  return { ...BASE, hook_event_name: 'BeforeAgent', prompt }
}

function beforeTool(tool_name: string, tool_input: Record<string, unknown> = {}): HookEvent {
  return { ...BASE, hook_event_name: 'BeforeTool', tool_name, tool_input }
}

function afterTool(tool_name: string, tool_input: Record<string, unknown>, tool_response: ToolResponse): HookEvent {
  return { ...BASE, hook_event_name: 'AfterTool', tool_name, tool_input, tool_response }
}

function afterAgent(): HookEvent {
  return { ...BASE, hook_event_name: 'AfterAgent', prompt: 'x', prompt_response: 'y' }
}

function agentCall(agent_name: string, prompt = 'Investiga el módulo de pagos\nDetalle') {
  return { agent_name, prompt }
}

function finished(agent: string, reason = 'GOAL'): ToolResponse {
  return { llmContent: `Subagent '${agent}' finished.\nTermination Reason: ${reason}\nResult: ok` }
}

function proposalInput(overrides: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []) {
  return {
    questions: [
      ...extra,
      {
        question: PROPOSAL_TEXT,
        header: 'Propuesta',
        type: 'choice',
        options: [{ label: 'Aceptar', description: 'ok' }, { label: 'Corregir', description: 'no' }],
        ...overrides,
      },
    ],
  }
}

function answered(index: number, answer: unknown): ToolResponse {
  return { llmContent: JSON.stringify({ answers: { [String(index)]: answer } }) }
}

function state(overrides: Partial<FlowState> = {}): FlowState {
  return {
    version: 1,
    sessionId: 's1',
    cwd: '/repo',
    request: 'pagos',
    planPath: '/plans/demo/2026-10-22-0905-pagos.md',
    phase: 'explore',
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    activeAgents: 0,
    researched: false,
    reads: { used: 0, limit: READ_LIMIT },
    proposals: 0,
    corrections: 0,
    changed: false,
    validation: { qa: false, review: false },
    retries: { validation: 0, gaveUp: false },
    ...overrides,
  }
}

function run(s: FlowState | null, event: HookEvent, env: FlowEnv = ENV): StepOutput {
  const snapshot = structuredClone(s)
  const result = step(s, event, LATER, env)
  assert.deepEqual(s, snapshot, 'step must not mutate its input')
  return result
}

function ctx(result: HookResult): string | undefined {
  return 'hookSpecificOutput' in result ? result.hookSpecificOutput.additionalContext : undefined
}

function reason(result: HookResult): string | undefined {
  return 'decision' in result ? result.reason : undefined
}

function denied(result: HookResult, expected: string) {
  assert.deepEqual(result, { decision: 'deny', reason: expected })
}

const P = state().planPath

describe('helpers', () => {
  test('normalize strips diacritics, case, punctuation and extra spaces', () => {
    assert.equal(normalize('  ¡Sí,   ADELANTE!  '), 'si adelante')
    assert.equal(normalize('Propuesta: v2'), 'propuesta v2')
    assert.equal(normalize('Corrección'), 'correccion')
  })

  test('isAcceptance only accepts the exact listed phrases', () => {
    for (const text of ['Acepto', '¡Acepto el plan!', 'Aceptar', 'aceptado', 'Aceptada.', 'apruebo', 'APROBADO']) assert.equal(isAcceptance(text), true, text)
    for (const text of ['sí', 'si acepto', 'Sí, adelante.', 'OK!', 'okay', 'va', 'dale', 'adelante', 'procede', 'Hazlo', 'de acuerdo', 'acepta', 'acepto pero cambia X', 'no', 'corregir', '']) assert.equal(isAcceptance(text), false, text)
  })

  test('slugify joins words and cuts on a word boundary', () => {
    assert.equal(slugify('Agrega el Endpoint de pagos!'), 'agrega-el-endpoint-de-pagos')
    const slug = slugify('uno dos tres cuatro cinco seis siete ocho nueve diez')
    assert.ok(slug.length <= 40)
    assert.equal(slug, 'uno-dos-tres-cuatro-cinco-seis-siete')
    assert.equal(slugify('a'.repeat(60)), 'a'.repeat(40))
    assert.equal(slugify('¿?!'), 'pedido')
    assert.equal(slugify(''), 'pedido')
  })

  test('extractRequest reads the pedido tags or strips the marker', () => {
    assert.equal(extractRequest(`${MARKER} Lleva esto\n<pedido>\n  agrega pagos \n</pedido>\n1. paso`), 'agrega pagos')
    assert.equal(extractRequest(`${MARKER}<pedido></pedido>`), '')
    assert.equal(extractRequest(`  ${MARKER}  agrega pagos  `), 'agrega pagos')
  })

  test('isFlowStart requires the marker at the start', () => {
    assert.equal(isFlowStart(`  ${MARKER} x`), true)
    assert.equal(isFlowStart(`hola ${MARKER}`), false)
  })

  test('planPath uses the local timestamp and the slug', () => {
    assert.equal(planPath(ENV, 'Agrega pagos', NOW), path.join('/plans', 'demo', '2026-10-22-0905-agrega-pagos.md'))
  })

  test('agentOutcome reads the termination reason', () => {
    assert.equal(agentOutcome(finished('researcher')), 'goal')
    assert.equal(agentOutcome({ llmContent: "Subagent 'researcher' finished.\nResult: ok" }), 'goal')
    assert.equal(agentOutcome(finished('researcher', 'MAX_TURNS')), 'partial')
    assert.equal(agentOutcome({ llmContent: [{ text: "Subagent 'x' finished." }, { text: '\nTermination Reason: TIMEOUT' }] }), 'partial')
    assert.equal(agentOutcome({ llmContent: 'Error: boom' }), 'failed')
    assert.equal(agentOutcome({ ...finished('researcher'), error: { message: 'boom' } }), 'failed')
    assert.equal(agentOutcome({}), 'failed')
  })

  test('taskOf keeps the first line up to 120 characters', () => {
    assert.equal(taskOf('Investiga\nmás'), 'Investiga')
    const long = taskOf('x'.repeat(200))
    assert.equal(long.length, 120)
    assert.ok(long.endsWith('…'))
  })

  test('the agent lists match the contract', () => {
    assert.deepEqual([...READ_TOOLS], ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'google_web_search', 'web_fetch'])
    assert.deepEqual([...READ_AGENTS], ['researcher', 'analyst', 'architect', 'security', 'code-reviewer', 'sre'])
    assert.deepEqual([...WORK_AGENTS], ['developer', 'devops', 'qa-automation', 'documenter'])
    assert.deepEqual([...CHANGE_AGENTS], ['developer', 'devops', 'documenter'])
  })
})

describe('findProposal', () => {
  test('accepts a valid proposal', () => {
    assert.deepEqual(findProposal(proposalInput()), { index: 0, text: PROPOSAL_TEXT })
    assert.deepEqual(findProposal(proposalInput({}, [{ header: 'Duda', type: 'text', question: '¿Qué base?' }])), { index: 1, text: PROPOSAL_TEXT })
    assert.deepEqual(findProposal(proposalInput({ header: 'Propuesta v2' })), { index: 0, text: PROPOSAL_TEXT })
  })

  test('rejects two candidates', () => {
    assert.equal(findProposal(proposalInput({}, [{ header: 'propuesta', type: 'choice', question: PROPOSAL_TEXT, options: [{ label: 'Aceptar' }, { label: 'Corregir' }] }])), 'invalid')
  })

  test('rejects a candidate without Aceptar or Corregir', () => {
    assert.equal(findProposal(proposalInput({ options: [{ label: 'Aceptar' }, { label: 'Otra' }] })), 'invalid')
    assert.equal(findProposal(proposalInput({ options: [{ label: 'Corregir' }] })), 'invalid')
  })

  test('rejects a short question', () => {
    assert.equal(findProposal(proposalInput({ question: 'Corta' })), 'invalid')
  })

  test('rejects multiSelect and non choice types', () => {
    assert.equal(findProposal(proposalInput({ multiSelect: true })), 'invalid')
    assert.equal(findProposal(proposalInput({ type: 'text' })), 'invalid')
  })

  test('rejects an Aceptar option without the proposal header and ignores other questions', () => {
    assert.equal(findProposal(proposalInput({ header: 'Plan' })), 'invalid')
    assert.equal(findProposal({ questions: [{ header: 'Duda', type: 'choice', question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }] }), null)
    assert.equal(findProposal({}), null)
  })
})

describe('general', () => {
  test('without state nothing happens', () => {
    const out = run(null, beforeTool('write_file', { file_path: 'a.ts' }))
    assert.deepEqual(out, { state: null, result: {}, log: [] })
  })

  test('env.off disables everything, even the marker', () => {
    const s = state()
    assert.equal(run(s, beforeTool('write_file'), { ...ENV, off: true }).state, s)
    assert.deepEqual(run(null, beforeAgent(`${MARKER} x`), { ...ENV, off: true }), { state: null, result: {}, log: [] })
  })

  test('done stays inactive', () => {
    const s = state({ phase: 'done' })
    for (const event of [beforeAgent('hola'), beforeTool('write_file', { file_path: 'a.ts' }), beforeTool('run_shell_command'), afterAgent(), afterTool('invoke_agent', agentCall('developer'), finished('developer'))]) {
      const out = run(s, event)
      assert.equal(out.state, s)
      assert.deepEqual(out.result, {})
      assert.deepEqual(out.log, [])
    }
  })

  test('AfterTool of an unwatched tool does nothing', () => {
    const s = state({ activeAgents: 1 })
    const out = run(s, afterTool('read_file', {}, { llmContent: 'x' }))
    assert.equal(out.state, s)
    assert.deepEqual(out.result, {})
  })

  test('an unchanged step returns the same state reference', () => {
    const s = state({ phase: 'accepted' })
    assert.equal(run(s, beforeAgent('sigue')).state, s)
    assert.equal(run(s, beforeTool('read_file')).state, s)
    assert.equal(run(state(), beforeTool('write_file')).state?.reads.used, 0)
  })

  test('step never throws on malformed input', () => {
    const s = state()
    const bad = { ...BASE, hook_event_name: 'AfterTool', tool_name: 'invoke_agent', tool_input: null } as unknown as HookEvent
    assert.doesNotThrow(() => step(s, bad, LATER, ENV))
  })

  test('failResult denies only risky tools', () => {
    const reasonText = 'El estado del flujo de nursery no se pudo leer. Vuelve a lanzar /nursery o desactívalo con NURSERY_FLOW=off.'
    for (const event of [beforeTool('write_file'), beforeTool('replace'), beforeTool('run_shell_command'), beforeTool('invoke_agent', agentCall('developer')), beforeTool('mcp_jira_createIssue')]) {
      denied(failResult(event), reasonText)
    }
    for (const event of [beforeTool('read_file'), beforeTool('invoke_agent', agentCall('researcher')), beforeTool('mcp_jira_getIssue'), beforeTool('ask_user'), beforeAgent('x'), afterAgent()]) {
      assert.deepEqual(failResult(event), {})
    }
    const malformed = { ...BASE, hook_event_name: 'BeforeTool', tool_name: 'invoke_agent', tool_input: null } as unknown as HookEvent
    assert.deepEqual(failResult(malformed), {})
  })
})

describe('start', () => {
  test('the marker creates a fresh state and the plan', () => {
    const prompt = `${MARKER} Lleva este pedido\n<pedido>\nAgrega pagos\n</pedido>`
    const out = run(null, beforeAgent(prompt))
    const file = path.join('/plans', 'demo', '2026-10-22-0930-agrega-pagos.md')
    assert.deepEqual(out.state, {
      version: 1,
      sessionId: 's1',
      cwd: '/repo',
      request: 'Agrega pagos',
      planPath: file,
      phase: 'explore',
      startedAt: AT,
      updatedAt: AT,
      activeAgents: 0,
      researched: false,
      reads: { used: 0, limit: 8 },
      proposals: 0,
      corrections: 0,
      changed: false,
      validation: { qa: false, review: false },
      retries: { validation: 0, gaveUp: false },
    })
    assert.deepEqual(out.log, [{ kind: 'create', file, at: AT, request: 'Agrega pagos', cwd: '/repo', sessionId: 's1' }])
    assert.equal(ctx(out.result), `[nursery] Flujo iniciado. Fase: explorar. Te quedan 8 lecturas propias. Siguiente: invoca al researcher si el pedido no es trivial; después pregunta tus dudas y presenta la propuesta ${Q}. Plan: ${file}`)
    assert.equal(out.result && 'hookSpecificOutput' in out.result && out.result.hookSpecificOutput.hookEventName, 'BeforeAgent')
  })

  test('the marker replaces an active flow', () => {
    const prev = state({ phase: 'accepted', changed: true, corrections: 2 })
    const out = run(prev, beforeAgent(`${MARKER}<pedido>otra cosa</pedido>`))
    assert.equal(out.state?.phase, 'explore')
    assert.equal(out.state?.corrections, 0)
    assert.deepEqual(out.log.map((e) => e.kind), ['replaced', 'phase', 'create'])
    assert.deepEqual(out.log[0], { kind: 'replaced', file: P, at: AT })
    assert.deepEqual(out.log[1], { kind: 'phase', file: P, phase: 'replaced' })
  })

  test('the marker after done only creates', () => {
    const out = run(state({ phase: 'done' }), beforeAgent(`${MARKER} otra cosa`))
    assert.deepEqual(out.log.map((e) => e.kind), ['create'])
    assert.equal(out.state?.request, 'otra cosa')
  })
})

describe('BeforeAgent', () => {
  test('in explore resets agents and reports the remaining reads', () => {
    const out = run(state({ activeAgents: 2, reads: { used: 3, limit: 8 } }), beforeAgent('una duda'))
    assert.equal(out.state?.activeAgents, 0)
    assert.equal(ctx(out.result), CONTEXT.explore(5, P))
    assert.equal(ctx(out.result), `[nursery] Fase: explorar. Te quedan 5 lecturas propias. Siguiente: pregunta tus dudas o presenta la propuesta ${Q}. Plan: ${P}`)
  })

  test('acceptance in explore says there is no proposal', () => {
    const s = state()
    const out = run(s, beforeAgent('Acepto'))
    assert.equal(out.state, s)
    assert.equal(ctx(out.result), `[nursery] Fase: explorar. Aún no hay una propuesta pendiente: preséntala ${Q} para que el usuario la acepte. Plan: ${P}`)
  })

  test('acceptance by text in proposed accepts the plan', () => {
    const out = run(state({ phase: 'proposed', activeAgents: 1 }), beforeAgent('Acepto'))
    assert.equal(out.state?.phase, 'accepted')
    assert.equal(out.state?.activeAgents, 0)
    assert.equal(out.state?.changed, false)
    assert.deepEqual(out.state?.validation, { qa: false, review: false })
    assert.equal(out.state?.updatedAt, AT)
    assert.equal(ctx(out.result), `[nursery] Plan aceptado. Ejecuta cada paso con su agente (invoke_agent), en paralelo los independientes, y termina con qa-automation y code-reviewer. Tú solo escribes archivos .md. Plan: ${P}`)
    assert.deepEqual(out.log, [{ kind: 'accepted', file: P, at: AT, via: 'text' }, { kind: 'phase', file: P, phase: 'accepted' }])
  })

  test('loose agreement in proposed is a correction, not an acceptance', () => {
    for (const text of ['sí', 'ok', 'dale', 'adelante', 'hazlo']) {
      const out = run(state({ phase: 'proposed' }), beforeAgent(text))
      assert.equal(out.state?.phase, 'explore', text)
      assert.equal(out.state?.corrections, 1, text)
    }
  })

  test('any other text in proposed is a correction', () => {
    const out = run(state({ phase: 'proposed', reads: { used: 3, limit: 3 }, activeAgents: 1 }), beforeAgent('  Cambia la ruta  '))
    assert.equal(out.state?.phase, 'explore')
    assert.deepEqual(out.state?.reads, { used: 0, limit: 3 })
    assert.equal(out.state?.corrections, 1)
    assert.equal(out.state?.activeAgents, 0)
    assert.equal(ctx(out.result), `[nursery] El usuario corrigió la propuesta con este mensaje. Fase: explorar, te quedan 3 lecturas propias. Ajusta la propuesta y vuelve a preguntar ${Q}. Plan: ${P}`)
    assert.deepEqual(out.log, [{ kind: 'correction', file: P, at: AT, via: 'text', text: 'Cambia la ruta' }, { kind: 'phase', file: P, phase: 'explore' }])
  })

  test('a long text correction is logged up to 1000 characters', () => {
    const out = run(state({ phase: 'proposed' }), beforeAgent('x'.repeat(3000)))
    const entry = out.log[0]
    assert.equal(entry?.kind === 'correction' && entry.text.length, 1000)
    const dialog = run(state({ phase: 'proposed' }), afterTool('ask_user', proposalInput(), answered(0, 'z'.repeat(3000)))).log[0]
    assert.equal(dialog?.kind === 'correction' && dialog.text.length, 1000)
  })

  test('in accepted reports the validation', () => {
    const out = run(state({ phase: 'accepted', activeAgents: 3, validation: { qa: true, review: false } }), beforeAgent('sigue'))
    assert.equal(out.state?.activeAgents, 0)
    assert.equal(ctx(out.result), `[nursery] Fase: plan aceptado. Ejecuta los pasos con su agente (invoke_agent); tú solo escribes .md. Validación: qa-automation hecha, code-reviewer pendiente. Plan: ${P}`)
  })
})

describe('BeforeTool before acceptance', () => {
  for (const phase of ['explore', 'proposed'] as const) {
    test(`${phase}: read agents are allowed and counted`, () => {
      for (const agent of READ_AGENTS) {
        const out = run(state({ phase }), beforeTool('invoke_agent', agentCall(agent)))
        assert.deepEqual(out.result, {})
        assert.equal(out.state?.activeAgents, 1)
      }
    })

    test(`${phase}: work agents are denied`, () => {
      for (const agent of WORK_AGENTS) {
        const s = state({ phase })
        const out = run(s, beforeTool('invoke_agent', agentCall(agent)))
        denied(out.result, `${agent} trabaja solo con el plan aceptado. Presenta la propuesta ${Q}.`)
        assert.equal(out.state, s)
      }
    })

    test(`${phase}: unknown agents are denied`, () => {
      denied(run(state({ phase }), beforeTool('invoke_agent', agentCall('generalist'))).result, 'Antes de aceptar solo puedes invocar a researcher, analyst, architect, security, code-reviewer o sre.')
    })

    test(`${phase}: writes are denied whatever the agents`, () => {
      for (const tool of ['write_file', 'replace']) {
        for (const activeAgents of [0, 2]) {
          denied(run(state({ phase, activeAgents }), beforeTool(tool, { file_path: 'plan.md' })).result, `Aún no hay plan aceptado: no escribas archivos. Presenta la propuesta ${Q}.`)
        }
      }
    })

    test(`${phase}: the shell is denied even with active agents`, () => {
      for (const activeAgents of [0, 1, 3]) {
        const s = state({ phase, activeAgents })
        const out = run(s, beforeTool('run_shell_command', { command: 'ls' }))
        denied(out.result, 'Antes de aceptar no se usa el shell. Lee con read_file, grep_search o glob, o delega al researcher.')
        assert.equal(out.state, s)
      }
    })

    test(`${phase}: mcp reads are allowed and counted like the other reads`, () => {
      for (const tool of ['mcp_atlassian_getJiraIssue', 'mcp_jira_issue_comments', 'mcp_atl_sites', 'mcp_db_count']) {
        const out = run(state({ phase, reads: { used: 1, limit: 3 } }), beforeTool(tool))
        assert.deepEqual(out.result, {}, tool)
        assert.deepEqual(out.state?.reads, { used: 2, limit: 3 }, tool)
      }
      denied(run(state({ phase, reads: { used: 3, limit: 3 } }), beforeTool('mcp_atlassian_getJiraIssue')).result, phase === 'proposed' ? REASON.readsProposed : REASON.readsExplore)
      const busy = state({ phase, activeAgents: 1, reads: { used: 3, limit: 3 } })
      assert.deepEqual(run(busy, beforeTool('mcp_atlassian_searchJiraIssuesUsingJql')), { state: busy, result: {}, log: [] })
    })

    test(`${phase}: mcp writes are denied whatever the agents`, () => {
      for (const tool of ['mcp_atlassian_createJiraIssue', 'mcp_jira_update_issue', 'mcp_jira_delete_issue', 'mcp_jira_transition_issue', 'mcp_atl_api_call', 'mcp_x_create_findings', 'mcp_x_delete_showcase']) {
        for (const activeAgents of [0, 2]) {
          const s = state({ phase, activeAgents })
          const out = run(s, beforeTool(tool))
          denied(out.result, REASON.toolBefore)
          assert.equal(out.state, s)
        }
      }
    })

    test(`${phase}: unknown tools and plan mode are denied`, () => {
      for (const tool of ['save_memory', 'enter_plan_mode', 'exit_plan_mode', 'brand_new_tool', 'getIssue']) {
        denied(run(state({ phase }), beforeTool(tool)).result, `Antes de aceptar el plan solo se lee, se pregunta y se delega a agentes de lectura. Presenta la propuesta ${Q}.`)
      }
    })

    test(`${phase}: search_file_content counts as a read and the free tools pass untouched`, () => {
      assert.equal(run(state({ phase }), beforeTool('search_file_content')).state?.reads.used, 1)
      for (const tool of FREE_TOOLS) {
        const s = state({ phase, reads: { used: 3, limit: 3 } })
        assert.deepEqual(run(s, beforeTool(tool)), { state: s, result: {}, log: [] }, tool)
      }
    })

    test(`${phase}: an invalid proposal is denied`, () => {
      denied(run(state({ phase }), beforeTool('ask_user', proposalInput({ multiSelect: true }))).result, REASON.format)
    })

    test(`${phase}: a question without proposal is allowed`, () => {
      const s = state({ phase })
      const out = run(s, beforeTool('ask_user', { questions: [{ header: 'Duda', type: 'text', question: '¿Qué base?' }] }))
      assert.deepEqual(out, { state: s, result: {}, log: [] })
    })
  }

  test('the format reason is exact', () => {
    assert.equal(REASON.format, 'Propuesta con formato inválido. Usa ask_user con una sola pregunta header "Propuesta", type "choice", sin multiSelect, la propuesta completa en question (80 caracteres o más) y las opciones "Aceptar" y "Corregir".')
  })

  test('a valid proposal moves to proposed and logs it', () => {
    const out = run(state({ proposals: 1, reads: { used: 2, limit: 8 } }), beforeTool('ask_user', proposalInput()))
    assert.deepEqual(out.result, {})
    assert.equal(out.state?.phase, 'proposed')
    assert.equal(out.state?.proposals, 2)
    assert.deepEqual(out.state?.reads, { used: 0, limit: 3 })
    assert.deepEqual(out.log, [
      { kind: 'proposal', file: P, at: AT, version: 2, text: PROPOSAL_TEXT },
      { kind: 'phase', file: P, phase: 'proposed' },
    ])
  })

  test('reads are capped at 8 only without active agents', () => {
    let s = state()
    for (let i = 0; i < 8; i++) {
      const out = run(s, beforeTool(READ_TOOLS[i % READ_TOOLS.length] ?? 'read_file'))
      assert.deepEqual(out.result, {})
      assert.ok(out.state)
      s = out.state
    }
    assert.equal(s.reads.used, 8)
    const blocked = run(s, beforeTool('read_file'))
    denied(blocked.result, `Llegaste al tope de 8 lecturas. Delega lo que falte al researcher, o pregunta tus dudas y presenta la propuesta ${Q}.`)
    assert.equal(blocked.state, s)
    const busy = { ...s, activeAgents: 1 }
    const free = run(busy, beforeTool('grep_search'))
    assert.deepEqual(free.result, {})
    assert.equal(free.state, busy)
  })

  test('the reads reason depends on the situation', () => {
    const full = { reads: { used: 3, limit: 3 } }
    denied(run(state({ ...full, phase: 'proposed', corrections: 1, researched: true }), beforeTool('read_file')).result, `La propuesta está en revisión. Espera la respuesta del usuario o vuelve a proponer ${Q}.`)
    denied(run(state({ ...full, corrections: 1, researched: true }), beforeTool('read_file')).result, `Ya usaste las 3 lecturas de la corrección. Ajusta la propuesta y vuelve a preguntar ${Q}.`)
    denied(run(state({ ...full, researched: true }), beforeTool('read_file')).result, `Ya tienes la entrega del researcher. Pregunta tus dudas y presenta la propuesta ${Q}.`)
  })

  test('isMcpRead looks at the verb that starts the last segment', () => {
    for (const tool of ['mcp_a_getIssue', 'mcp_a_get', 'mcp_a__search', 'mcp_a_b_listSites', 'mcp_a_Fetch2', 'mcp_a_view-page']) assert.equal(isMcpRead(tool), true, tool)
    for (const tool of ['getIssue', 'mcp_gitlab_list_merge_requests', 'mcp_a_createIssue', 'mcp_a_findings', 'mcp_a_showcase', 'mcp_a_get_and_delete', 'mcp_', 'mcp_a_']) assert.equal(isMcpRead(tool), false, tool)
  })
})

describe('caps after the researcher, a proposal and a correction', () => {
  for (const reasonCode of ['GOAL', 'MAX_TURNS']) {
    test(`researcher ${reasonCode} caps the reads at used + 3`, () => {
      const out = run(state({ activeAgents: 1, reads: { used: 2, limit: 8 } }), afterTool('invoke_agent', agentCall('researcher'), finished('researcher', reasonCode)))
      assert.equal(out.state?.researched, true)
      assert.deepEqual(out.state?.reads, { used: 2, limit: 5 })
      assert.equal(out.state?.activeAgents, 0)
      assert.equal(ctx(out.result), `[nursery] Entrega del researcher recibida: es tu base, no releas lo que reportó. Te quedan 3 lecturas propias. Siguiente: pregunta tus dudas o presenta la propuesta ${Q}.`)
      let s = out.state
      assert.ok(s)
      for (let i = 0; i < 3; i++) {
        const next: FlowState | null = run(s, beforeTool('read_file')).state
        assert.ok(next)
        s = next
      }
      denied(run(s, beforeTool('read_file')).result, REASON.readsResearched)
    })
  }

  test('the researcher never raises the limit', () => {
    const out = run(state({ activeAgents: 1, reads: { used: 0, limit: 2 } }), afterTool('invoke_agent', agentCall('researcher'), finished('researcher')))
    assert.deepEqual(out.state?.reads, { used: 0, limit: 2 })
  })

  test('after a proposal only 3 reads remain', () => {
    let s = run(state(), beforeTool('ask_user', proposalInput())).state
    assert.ok(s)
    for (let i = 0; i < 3; i++) {
      const next: FlowState | null = run(s, beforeTool('glob')).state
      assert.ok(next)
      s = next
    }
    denied(run(s, beforeTool('glob')).result, REASON.readsProposed)
  })

  test('after a correction only 3 reads remain', () => {
    let s = run(state({ phase: 'proposed' }), beforeAgent('cambia esto')).state
    assert.ok(s)
    for (let i = 0; i < 3; i++) {
      const next: FlowState | null = run(s, beforeTool('read_file')).state
      assert.ok(next)
      s = next
    }
    denied(run(s, beforeTool('read_file')).result, REASON.readsCorrection)
  })
})

describe('AfterTool of invoke_agent', () => {
  test('logs the agent and decrements the active agents', () => {
    const out = run(state({ activeAgents: 2 }), afterTool('invoke_agent', agentCall('architect', 'Diseña la integración\nmás'), finished('architect')))
    assert.equal(out.state?.activeAgents, 1)
    assert.deepEqual(out.result, {})
    assert.deepEqual(out.log, [{ kind: 'agent', file: P, at: AT, agent: 'architect', task: 'Diseña la integración', outcome: 'goal', detail: '' }])
  })

  test('never goes below zero agents', () => {
    const out = run(state(), afterTool('invoke_agent', agentCall('architect'), finished('architect')))
    assert.equal(out.state?.activeAgents, 0)
  })

  test('logs the partial reason', () => {
    const out = run(state({ phase: 'accepted', activeAgents: 1 }), afterTool('invoke_agent', agentCall('developer'), finished('developer', 'MAX_TURNS')))
    assert.deepEqual(out.log[0], { kind: 'agent', file: P, at: AT, agent: 'developer', task: 'Investiga el módulo de pagos', outcome: 'partial', detail: 'MAX_TURNS' })
  })

  test('a failed agent asks to retry or leave it pending', () => {
    const out = run(state({ activeAgents: 1 }), afterTool('invoke_agent', agentCall('researcher'), { error: { message: 'timeout' } }))
    assert.equal(out.state?.researched, false)
    assert.equal(ctx(out.result), '[nursery] researcher no terminó (timeout). Vuelve a invocarlo con el encargo ajustado o déjalo como pendiente en el resumen.')
    const entry = out.log[0]
    assert.equal(entry?.kind === 'agent' && entry.outcome, 'failed')
  })

  test('the agent detail is cut to 300 characters', () => {
    const out = run(state({ activeAgents: 1 }), afterTool('invoke_agent', agentCall('architect'), { error: { message: 'e'.repeat(5000) } }))
    const entry = out.log[0]
    assert.equal(entry?.kind === 'agent' && entry.detail.length, 300)
  })

  test('validation is tracked in accepted', () => {
    let s = state({ phase: 'accepted', activeAgents: 2, changed: true })
    const qa = run(s, afterTool('invoke_agent', agentCall('qa-automation'), finished('qa-automation')))
    assert.deepEqual(qa.state?.validation, { qa: true, review: false })
    assert.equal(ctx(qa.result), '[nursery] Validación: qa-automation hecha, code-reviewer pendiente.')
    assert.ok(qa.state)
    s = qa.state
    const partial = run(s, afterTool('invoke_agent', agentCall('code-reviewer'), finished('code-reviewer', 'MAX_TURNS')))
    assert.deepEqual(partial.state?.validation, { qa: true, review: false })
    const review = run(s, afterTool('invoke_agent', agentCall('code-reviewer'), finished('code-reviewer')))
    assert.deepEqual(review.state?.validation, { qa: true, review: true })
    assert.equal(ctx(review.result), '[nursery] Validación: qa-automation hecha, code-reviewer hecha.')
  })
})

describe('AfterTool of ask_user', () => {
  const proposed = () => state({ phase: 'proposed', proposals: 1, reads: { used: 1, limit: 3 } })

  test('Aceptar accepts the plan', () => {
    const out = run(proposed(), afterTool('ask_user', proposalInput(), answered(0, 'Aceptar')))
    assert.equal(out.state?.phase, 'accepted')
    assert.equal(ctx(out.result), CONTEXT.accepted(P))
    assert.equal(out.result && 'hookSpecificOutput' in out.result && out.result.hookSpecificOutput.hookEventName, 'AfterTool')
    assert.deepEqual(out.log, [{ kind: 'accepted', file: P, at: AT, via: 'dialog' }, { kind: 'phase', file: P, phase: 'accepted' }])
  })

  test('the answer is read at the proposal index', () => {
    const input = proposalInput({}, [{ header: 'Duda', type: 'text', question: '¿Base?' }])
    const out = run(proposed(), afterTool('ask_user', input, { llmContent: JSON.stringify({ answers: { '0': 'Corregir', '1': 'Aceptar' } }) }))
    assert.equal(out.state?.phase, 'accepted')
  })

  test('Corregir asks what to change', () => {
    const out = run(proposed(), afterTool('ask_user', proposalInput(), answered(0, 'Corregir')))
    assert.equal(out.state?.phase, 'explore')
    assert.deepEqual(out.state?.reads, { used: 0, limit: 3 })
    assert.equal(out.state?.corrections, 1)
    assert.equal(ctx(out.result), `[nursery] El usuario quiere corregir la propuesta. Pregúntale qué cambiar con ask_user (type "text") y después vuelve a proponer ${Q}.`)
    assert.deepEqual(out.log[0], { kind: 'correction', file: P, at: AT, via: 'dialog', text: '' })
  })

  test('free text in Other is a correction with the text', () => {
    const out = run(proposed(), afterTool('ask_user', proposalInput(), answered(0, ['Usa otra tabla', 'y otra ruta'])))
    assert.equal(out.state?.phase, 'explore')
    assert.equal(out.state?.corrections, 1)
    assert.equal(ctx(out.result), `[nursery] El usuario corrigió: «Usa otra tabla, y otra ruta». Ajusta la propuesta y vuelve a preguntar ${Q}. Te quedan 3 lecturas propias.`)
    assert.deepEqual(out.log[0], { kind: 'correction', file: P, at: AT, via: 'dialog', text: 'Usa otra tabla, y otra ruta' })
  })

  test('the correction context keeps up to 500 characters', () => {
    const out = run(proposed(), afterTool('ask_user', proposalInput(), answered(0, 'y'.repeat(900))))
    assert.ok(ctx(out.result)?.includes(`«${'y'.repeat(500)}»`))
  })

  test('a dismissed dialog or empty answers go back to explore and log it', () => {
    for (const response of [{ llmContent: 'User dismissed ask_user dialog without answering.' }, { llmContent: '{"answers":{}}' }]) {
      const out = run(state({ phase: 'proposed', proposals: 1, reads: { used: 2, limit: 3 }, corrections: 1 }), afterTool('ask_user', proposalInput(), response))
      assert.equal(out.state?.phase, 'explore')
      assert.deepEqual(out.state?.reads, { used: 0, limit: 3 })
      assert.equal(out.state?.corrections, 1)
      assert.equal(ctx(out.result), '[nursery] El usuario cerró la propuesta sin responder. No ejecutes nada: termina el turno y espera su respuesta.')
      assert.deepEqual(out.log, [{ kind: 'dismissed', file: P, at: AT }, { kind: 'phase', file: P, phase: 'explore' }])
    }
  })

  test('acceptance by text after a dismissed dialog finds no proposal', () => {
    const dismissed = run(proposed(), afterTool('ask_user', proposalInput(), { llmContent: '{"answers":{}}' })).state
    assert.ok(dismissed)
    const out = run(dismissed, beforeAgent('acepto'))
    assert.equal(out.state?.phase, 'explore')
    assert.equal(ctx(out.result), CONTEXT.noProposal(P))
  })

  test('an error or invalid JSON goes back to explore without the dismissed entry', () => {
    for (const response of [{ error: 'boom' }, { llmContent: 'not json' }]) {
      const out = run(proposed(), afterTool('ask_user', proposalInput(), response))
      assert.equal(out.state?.phase, 'explore')
      assert.equal(ctx(out.result), CONTEXT.dismissed())
      assert.deepEqual(out.log, [{ kind: 'phase', file: P, phase: 'explore' }])
    }
  })

  test('only applies to a valid proposal in proposed', () => {
    const s = state()
    assert.deepEqual(run(s, afterTool('ask_user', proposalInput(), answered(0, 'Aceptar'))), { state: s, result: {}, log: [] })
    const p = proposed()
    assert.deepEqual(run(p, afterTool('ask_user', { questions: [{ header: 'Duda', type: 'text', question: '¿?' }] }, answered(0, 'sí'))), { state: p, result: {}, log: [] })
  })
})

describe('BeforeTool in accepted', () => {
  test('any agent is allowed and change agents reset the validation', () => {
    for (const agent of CHANGE_AGENTS) {
      const out = run(state({ phase: 'accepted', validation: { qa: true, review: true } }), beforeTool('invoke_agent', agentCall(agent)))
      assert.deepEqual(out.result, {})
      assert.equal(out.state?.activeAgents, 1)
      assert.equal(out.state?.changed, true)
      assert.deepEqual(out.state?.validation, { qa: false, review: false })
    }
    const qa = run(state({ phase: 'accepted', validation: { qa: true, review: false } }), beforeTool('invoke_agent', agentCall('qa-automation')))
    assert.equal(qa.state?.changed, false)
    assert.deepEqual(qa.state?.validation, { qa: true, review: false })
  })

  test('the main thread only writes .md files and those outside the plans need validation', () => {
    const s = state({ phase: 'accepted' })
    for (const tool of ['write_file', 'replace']) {
      denied(run(s, beforeTool(tool, { file_path: 'src/a.ts' })).result, 'Plan aceptado: el código lo escriben developer o devops con invoke_agent. Tú solo puedes escribir archivos .md. Si necesitas salir del flujo, NURSERY_FLOW=off.')
      denied(run(s, beforeTool(tool, {})).result, REASON.writeAccepted)
      const docs = run(s, beforeTool(tool, { file_path: 'docs/PLAN.MD' }))
      assert.deepEqual(docs.result, {})
      assert.equal(docs.state?.changed, true)
      assert.deepEqual(docs.state?.validation, { qa: false, review: false })
      for (const file of [P, '/plans/demo/notes.md', '../plans/demo/x.md']) {
        const event = { ...beforeTool(tool, { file_path: file }), cwd: '/repo' }
        assert.deepEqual(run(s, event), { state: s, result: {}, log: [] }, file)
      }
      assert.equal(run(s, beforeTool(tool, { file_path: '/plans-evil/x.md' })).state?.changed, true)
    }
    const busy = state({ phase: 'accepted', activeAgents: 1 })
    assert.deepEqual(run(busy, beforeTool('write_file', { file_path: 'src/a.ts' })), { state: busy, result: {}, log: [] })
  })

  test('the orchestrator shell is free but needs validation, reads stay free', () => {
    const s = state({ phase: 'accepted', reads: { used: 3, limit: 3 } })
    const shell = run(s, beforeTool('run_shell_command', { command: 'npm test' }))
    assert.deepEqual(shell.result, {})
    assert.equal(shell.state?.changed, true)
    assert.ok(shell.state)
    const validate = run(shell.state, afterAgent())
    assert.equal(validate.result && 'decision' in validate.result && validate.result.decision, 'deny')
    const busy = state({ phase: 'accepted', activeAgents: 1 })
    assert.equal(run(busy, beforeTool('run_shell_command')).state, busy)
    for (const tool of ['read_file', 'mcp_jira_createIssue', 'save_memory']) assert.deepEqual(run(s, beforeTool(tool)), { state: s, result: {}, log: [] }, tool)
  })

  test('a new proposal in accepted keeps changed and the validation through the new acceptance', () => {
    const s = state({ phase: 'accepted', proposals: 1, changed: true, validation: { qa: true, review: false } })
    const proposed = run(s, beforeTool('ask_user', proposalInput())).state
    assert.ok(proposed)
    assert.equal(proposed.phase, 'proposed')
    for (const accept of [run(proposed, beforeAgent('acepto')), run(proposed, afterTool('ask_user', proposalInput(), answered(0, 'Aceptar')))]) {
      assert.equal(accept.state?.phase, 'accepted')
      assert.equal(accept.state?.changed, true)
      assert.deepEqual(accept.state?.validation, { qa: true, review: false })
    }
  })

  test('a new proposal moves back to proposed and an invalid one is denied', () => {
    const out = run(state({ phase: 'accepted', proposals: 1 }), beforeTool('ask_user', proposalInput()))
    assert.equal(out.state?.phase, 'proposed')
    assert.equal(out.state?.proposals, 2)
    denied(run(state({ phase: 'accepted' }), beforeTool('ask_user', proposalInput({ question: 'corta' }))).result, REASON.format)
  })
})

describe('AfterAgent', () => {
  test('outside a changed accepted plan it only resets the agents', () => {
    for (const s of [state({ activeAgents: 2 }), state({ phase: 'proposed', activeAgents: 1 }), state({ phase: 'accepted', activeAgents: 1 })]) {
      const out = run(s, afterAgent())
      assert.deepEqual(out.result, {})
      assert.equal(out.state?.activeAgents, 0)
      assert.deepEqual(out.log, [])
    }
    const idle = state({ phase: 'accepted' })
    assert.equal(run(idle, afterAgent()).state, idle)
  })

  test('with qa and review done it finishes', () => {
    const out = run(state({ phase: 'accepted', changed: true, validation: { qa: true, review: true }, retries: { validation: 1, gaveUp: false } }), afterAgent())
    assert.equal(out.state?.phase, 'done')
    assert.deepEqual(out.result, {})
    assert.deepEqual(out.log, [
      { kind: 'validation', file: P, at: AT, qa: true, review: true, result: 'done', attempt: 1 },
      { kind: 'phase', file: P, phase: 'done' },
    ])
    assert.ok(out.state)
    assert.equal(run(out.state, beforeTool('write_file', { file_path: 'a.ts' })).result, run(out.state, afterAgent()).result)
  })

  test('missing validation is retried twice and then given up', () => {
    let s = state({ phase: 'accepted', changed: true })
    const first = run(s, afterAgent())
    denied(first.result, 'Falta validar: lanza qa-automation y code-reviewer con invoke_agent sobre los cambios y corrige lo que reporten antes de cerrar.')
    assert.deepEqual(first.log, [{ kind: 'validation', file: P, at: AT, qa: false, review: false, result: 'retry', attempt: 1 }])
    assert.ok(first.state)
    s = { ...first.state, validation: { qa: true, review: false } }
    const second = run(s, afterAgent())
    denied(second.result, 'Falta validar: lanza code-reviewer con invoke_agent sobre los cambios y corrige lo que reporten antes de cerrar.')
    assert.equal(second.state?.retries.validation, 2)
    assert.ok(second.state)
    const third = run(second.state, afterAgent())
    assert.deepEqual(third.result, {})
    assert.deepEqual(third.state?.retries, { validation: 2, gaveUp: true })
    assert.equal(third.state?.phase, 'done')
    assert.deepEqual(third.log, [
      { kind: 'validation', file: P, at: AT, qa: true, review: false, result: 'gave-up', attempt: 2 },
      { kind: 'phase', file: P, phase: 'done' },
    ])
    assert.ok(third.state)
    const fourth = run(third.state, afterAgent())
    assert.deepEqual(fourth, { state: third.state, result: {}, log: [] })
  })

  test('the validate reason names only qa when review is done', () => {
    denied(run(state({ phase: 'accepted', changed: true, validation: { qa: false, review: true } }), afterAgent()).result, REASON.validate(false, true))
    assert.equal(reason(run(state({ phase: 'accepted', changed: true, validation: { qa: false, review: true } }), afterAgent()).result), 'Falta validar: lanza qa-automation con invoke_agent sobre los cambios y corrige lo que reporten antes de cerrar.')
  })
})

describe('end to end', () => {
  test('a full flow produces the expected plan log', () => {
    const events: HookEvent[] = [
      beforeAgent(`${MARKER}<pedido>Agrega pagos</pedido>`),
      beforeTool('invoke_agent', agentCall('researcher')),
      afterTool('invoke_agent', agentCall('researcher'), finished('researcher')),
      beforeTool('ask_user', proposalInput()),
      afterTool('ask_user', proposalInput(), answered(0, 'Corregir')),
      beforeAgent('usa la tabla payments'),
      beforeTool('ask_user', proposalInput()),
      afterTool('ask_user', proposalInput(), answered(0, 'Aceptar')),
      beforeTool('invoke_agent', agentCall('developer')),
      afterTool('invoke_agent', agentCall('developer'), finished('developer')),
      afterAgent(),
      beforeAgent('sigue'),
      beforeTool('invoke_agent', agentCall('qa-automation')),
      afterTool('invoke_agent', agentCall('qa-automation'), finished('qa-automation')),
      beforeTool('invoke_agent', agentCall('code-reviewer')),
      afterTool('invoke_agent', agentCall('code-reviewer'), finished('code-reviewer')),
      afterAgent(),
    ]
    let s: FlowState | null = null
    const kinds: string[] = []
    for (const event of events) {
      const out = run(s, event)
      s = out.state
      for (const entry of out.log) kinds.push(entry.kind === 'phase' ? `phase:${entry.phase}` : entry.kind === 'validation' ? `validation:${entry.result}` : entry.kind)
    }
    assert.equal(s?.phase, 'done')
    assert.deepEqual(kinds, [
      'create',
      'agent',
      'proposal', 'phase:proposed',
      'correction', 'phase:explore',
      'proposal', 'phase:proposed',
      'accepted', 'phase:accepted',
      'agent',
      'validation:retry',
      'agent', 'agent',
      'validation:done', 'phase:done',
    ])
  })
})
