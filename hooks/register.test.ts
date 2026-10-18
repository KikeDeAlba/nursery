import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

import type { NurseryAgent } from '../types'

const AGENTS = { plugin: 'nursery', key: 'agents' } as const
const PANE = 'nursery-panel'
const SURFACES = ['terminal', 'desktop'] as const
const VIEW = {}
const SCROLL = { offset: 0, bodyRows: 30 }

let stored: NurseryAgent[] = []

type EngineOptions = {
  placed?: boolean
  denySpawn?: string
  spawnIds?: string[]
  unplaced?: string
  throwOn?: string
  listed?: () => AgentInfo[]
}

const engine = (on: On, options: EngineOptions = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  const opened: string[] = []
  let next = 0
  stored = []

  on('state.set', (_$, e, proceed) => {
    if (e.plugin === AGENTS.plugin && e.key === AGENTS.key) stored = e.value as NurseryAgent[]

    return proceed(e)
  })

  on('agent.spawn', () => {
    if (options.denySpawn !== undefined) return { deny: options.denySpawn }
    const forced = options.spawnIds?.[next]
    next += 1

    return { model: 'test-model', agentId: forced ?? `agent-${next}` }
  })
  on('agent.list', () => ({ value: options.listed?.() ?? [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)

    return options.unplaced === undefined
      ? { value: { isPlaced: true } }
      : { value: { isPlaced: false as const, reason: options.unplaced } }
  })
  on('ui.panes', () => ({
    value:
      options.placed === true
        ? [{ id: PANE, title: 'Subagentes', isShown: true, isFocused: false, isPlaced: true }]
        : [],
  }))
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (options.throwOn !== undefined && input['command'] === options.throwOn) throw new Error('boom')

    return input['command'] === 'exit 1'
      ? { isError: true as const, result: 'failed', text: 'failed' }
      : { result: 'ok', text: 'ok' }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  return { clock, opened }
}

const agentsOf = (): readonly NurseryAgent[] => stored

const spawn = ($: Engine, subagentType: string, description: string, parentAgentId?: string) =>
  $.agent.spawn({
    prompt: 'do it',
    description,
    subagentType,
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  } as Parameters<Engine['agent']['spawn']>[0])

const callTool = ($: Engine, agentId: string, input: Record<string, unknown>) =>
  $.tool.call({ ...input, agentId } as unknown as Parameters<Engine['tool']['call']>[0])

const complete = ($: Engine, agentId: string, reason: 'answer' | 'error' | 'aborted' = 'answer') =>
  $.turn.complete({
    answer: 'listo',
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId: `turn-${agentId}`,
    agentId,
    reason,
  })

const paneProps = {
  title: 'Subagentes',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: SCROLL,
  view: VIEW,
}

const bandProps = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 6 },
  view: VIEW,
}

describe('nursery subagent panel', () => {
  test('a spawn is watched as running and opens the pane', async ($, on) => {
    const { opened } = engine(on)

    const started = await spawn($, 'nursery:developer', 'implementa endpoint')

    expect(started.agentId).toBe('agent-1')
    const [agent] = agentsOf()
    expect(agent).toMatchObject({
      id: 'agent-1',
      type: 'nursery:developer',
      description: 'implementa endpoint',
      status: 'running',
      toolCount: 0,
    })
    expect(opened).toContain(PANE)
  })

  test('a tool call of a watched agent is labelled by its argument', async ($, on) => {
    engine(on)
    await spawn($, 'nursery:developer', 'implementa endpoint')

    await callTool($, 'agent-1', { tool: 'Bash', command: 'npm test\nnpm run lint' })
    await callTool($, 'agent-1', { tool: 'Read', file_path: '/repo/src/api/users.ts' })
    await callTool($, 'agent-1', { tool: 'Grep', pattern: 'TODO' })
    await callTool($, 'agent-1', { tool: 'WebSearch', query: 'x' })

    const [agent] = agentsOf()
    expect(agent?.activity.map(one => one.label)).toEqual([
      'Bash npm test',
      'Read src/api/users.ts',
      'Grep TODO',
      'WebSearch',
    ])
    expect(agent?.activity.every(one => one.state === 'done')).toBe(true)
    expect(agent?.toolCount).toBe(4)
  })

  test('a failed tool is marked failed and the result passes through', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    const ran = await callTool($, 'agent-1', { tool: 'Bash', command: 'exit 1' })

    expect(ran.isError).toBe(true)
    const [agent] = agentsOf()
    expect(agent?.activity).toMatchObject([{ kind: 'tool', label: 'Bash exit 1', state: 'failed' }])
  })

  test('tools of unknown agents and of the main loop are ignored', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    const ran = await callTool($, 'fork-xyz', { tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'Bash', command: 'pwd' } as Parameters<Engine['tool']['call']>[0])

    expect(ran.text).toBe('ok')
    const [agent] = agentsOf()
    expect(agent?.activity).toEqual([])
  })

  test('assistant text becomes a text activity', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    await $.session.append({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [{ type: 'text', text: '\n  Las pruebas pasan, falta el lint\nmás detalle' }],
      },
      door: 'response',
      origin: { kind: 'model', model: 'test-model' },
      uuid: 'row-1',
      agentId: 'agent-1',
    })

    const [agent] = agentsOf()
    expect(agent?.activity).toMatchObject([
      { kind: 'text', label: 'Las pruebas pasan, falta el lint' },
    ])
  })

  test('turn.complete marks the agent completed or failed', async ($, on) => {
    const { clock } = engine(on)
    await spawn($, 'developer', 'uno')
    await spawn($, 'developer', 'dos')
    await clock.advance(48_000)

    const done = await complete($, 'agent-1')
    await complete($, 'agent-2', 'error')

    expect(done.text).toBe('listo')
    const list = agentsOf()
    expect(list.find(one => one.id === 'agent-1')).toMatchObject({
      status: 'completed',
      endedAt: 49_000,
    })
    expect(list.find(one => one.id === 'agent-2')?.status).toBe('failed')
  })

  test('a nested agent keeps its parent', async ($, on) => {
    engine(on)
    await spawn($, 'nursery:developer', 'padre')
    await spawn($, 'Explore', 'hijo', 'agent-1')

    const list = agentsOf()
    expect(list.find(one => one.id === 'agent-2')?.parentId).toBe('agent-1')

    const ui = await $.ui.mount({
      plugin: 'nursery',
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: paneProps,
      viewport: { columns: 120, rows: 40 },
    })
    const rows = await ui.findAll({ type: 'Button' })
    expect(rows.map(row => row.key)).toEqual(['agent-agent-1', 'agent-agent-2'])
    expect(rows[1]?.text.startsWith('  ')).toBe(true)
    await ui.unmount()
  })

  for (const surface of SURFACES) {
    test(`the pane draws empty on ${surface}`, async ($, on) => {
      engine(on)

      const ui = await $.ui.mount({
        plugin: 'nursery',
        surface,
        component: 'Pane',
        requestId: PANE,
        props: paneProps,
        viewport: { columns: 120, rows: 40 },
      })

      expect(await ui.find({ type: 'Text', text: /Ningún subagente/ })).toBeDefined()
      await ui.unmount()
    })

    test(`the pane draws agents on ${surface}`, async ($, on) => {
      const { clock } = engine(on)
      await spawn($, 'nursery:developer', 'implementa endpoint')
      await spawn($, 'nursery:code-reviewer', 'revisa diff')
      await callTool($, 'agent-1', { tool: 'Read', file_path: '/repo/src/api/users.ts' })
      await clock.advance(48_000)
      await complete($, 'agent-2')
      await clock.advance(24_000)

      const ui = await $.ui.mount({
        plugin: 'nursery',
        surface,
        component: 'Pane',
        requestId: PANE,
        props: paneProps,
        viewport: { columns: 120, rows: 40 },
      })

      const rows = await ui.findAll({ type: 'Button' })
      expect(rows.map(row => row.key)).toEqual(['agent-agent-1', 'agent-agent-2'])
      expect(rows[0]?.text).toMatch(/● developer\s+implementa endpoint\s+1m12s\s+1 herramienta\b/)
      expect(rows[1]?.text).toMatch(/✓ code-reviewer\s+revisa diff\s+0m48s\s+0 herramientas/)
      expect(rows[0]?.text).not.toContain('nursery:')
      expect(await ui.find({ type: 'Text', text: /✓ Read src\/api\/users\.ts/ })).toBeDefined()
      await ui.unmount()
    })

    test(`the band is empty without running agents on ${surface}`, async ($, on) => {
      engine(on)
      on('ui.render', { component: 'AbovePrompt' }, (_$, e) => {
        const { Box } = _$.ui.resolve(e)

        return Box({ key: 'engine-band' })
      })

      const ui = await $.ui.mount({
        plugin: 'nursery',
        surface,
        component: 'AbovePrompt',
        props: bandProps,
        viewport: { columns: 120, rows: 40 },
      })

      expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
      await ui.unmount()
    })

    test(`the band lists running agents while the pane is not placed on ${surface}`, async ($, on) => {
      const { clock } = engine(on)
      await spawn($, 'nursery:developer', 'implementa endpoint')
      await callTool($, 'agent-1', { tool: 'Bash', command: 'npm test' })
      await clock.advance(72_000)

      const ui = await $.ui.mount({
        plugin: 'nursery',
        surface,
        component: 'AbovePrompt',
        props: bandProps,
        viewport: { columns: 120, rows: 40 },
      })

      expect(await ui.find({ type: 'Text', text: '● developer · 1m12s · Bash npm test' })).toBeDefined()
      await ui.unmount()
    })

    test(`the band steps aside while the pane is placed on ${surface}`, async ($, on) => {
      engine(on, { placed: true })
      on('ui.render', { component: 'AbovePrompt' }, (_$, e) => {
        const { Box } = _$.ui.resolve(e)

        return Box({ key: 'engine-band' })
      })
      await spawn($, 'nursery:developer', 'implementa endpoint')

      const ui = await $.ui.mount({
        plugin: 'nursery',
        surface,
        component: 'AbovePrompt',
        props: bandProps,
        viewport: { columns: 120, rows: 40 },
      })

      expect(await ui.find({ type: 'Text', text: /developer/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('/nursery-panel opens the pane', async ($, on) => {
    const { opened } = engine(on)

    const ran = await $.command.run({ command: 'nursery-panel', args: '' } as Parameters<
      Engine['command']['run']
    >[0])

    expect(ran.text).toBe('Panel de subagentes abierto.')
    expect(opened).toEqual([PANE])
  })
  test('a tool that throws is marked failed and counted', async ($, on) => {
    engine(on, { throwOn: 'explode' })
    await spawn($, 'developer', 'algo')

    await callTool($, 'agent-1', { tool: 'Bash', command: 'explode' }).catch(() => undefined)

    const [agent] = agentsOf()
    expect(agent?.activity).toMatchObject([{ label: 'Bash explode', state: 'failed' }])
    expect(agent?.toolCount).toBe(1)
  })

  test('a tool of an unknown agent leaves the store untouched', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')
    const before = JSON.stringify(agentsOf())

    await callTool($, 'ghost', { tool: 'Bash', command: 'ls' })

    expect(JSON.stringify(agentsOf())).toBe(before)
    expect(agentsOf()).toHaveLength(1)
  })

  test('session.append of an unknown agent is ignored and the row is stored', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')
    const before = JSON.stringify(agentsOf())

    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hola' }] },
      door: 'response',
      origin: { kind: 'model', model: 'test-model' },
      uuid: 'row-ghost',
      agentId: 'ghost',
    })

    expect(JSON.stringify(agentsOf())).toBe(before)
    expect(agentsOf()[0]?.activity).toEqual([])
  })

  test('assistant text without text blocks adds no activity', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    await $.session.append({
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: '  \n ' }] },
      door: 'response',
      origin: { kind: 'model', model: 'test-model' },
      uuid: 'row-blank',
      agentId: 'agent-1',
    })

    expect(agentsOf()[0]?.activity).toEqual([])
  })

  test('activity keeps only the latest 5 entries', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    for (let n = 1; n <= 7; n += 1) await callTool($, 'agent-1', { tool: 'Grep', pattern: `p${n}` })

    const [agent] = agentsOf()
    expect(agent?.activity.map(one => one.label)).toEqual([
      'Grep p3',
      'Grep p4',
      'Grep p5',
      'Grep p6',
      'Grep p7',
    ])
    expect(agent?.toolCount).toBe(7)
  })

  test('the store keeps only the latest 30 agents', async ($, on) => {
    engine(on)

    for (let n = 1; n <= 32; n += 1) await spawn($, 'developer', `tarea ${n}`)

    const list = agentsOf()
    expect(list).toHaveLength(30)
    expect(list[0]?.id).toBe('agent-3')
    expect(list.at(-1)?.id).toBe('agent-32')
  })

  test('a resumed agent goes back to running without its end time', async ($, on) => {
    const { clock } = engine(on, { spawnIds: ['agent-1', 'agent-1'] })
    await spawn($, 'developer', 'algo')
    await complete($, 'agent-1')
    expect(agentsOf()[0]).toMatchObject({ status: 'completed', endedAt: 1_000 })
    await clock.advance(5_000)

    await spawn($, 'developer', 'algo otra vez')

    const list = agentsOf()
    expect(list).toHaveLength(1)
    expect(list[0]?.status).toBe('running')
    expect(list[0]?.endedAt).toBeUndefined()
    expect(list[0]?.startedAt).toBe(1_000)
    expect(list[0]?.description).toBe('algo')
  })

  test('an aborted turn marks the agent killed', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    await complete($, 'agent-1', 'aborted')

    expect(agentsOf()[0]).toMatchObject({ status: 'killed', endedAt: 1_000 })
  })

  test('turn.complete of an unknown agent or the main loop changes nothing', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')
    const before = JSON.stringify(agentsOf())

    const ghost = await complete($, 'ghost')
    const main = await $.turn.complete({
      answer: 'listo',
      durationMs: 10,
      isAborted: false,
      turnId: 'turn-main',
      reason: 'answer',
    } as Parameters<Engine['turn']['complete']>[0])

    expect(ghost.text).toBe('listo')
    expect(main.text).toBe('listo')
    expect(JSON.stringify(agentsOf())).toBe(before)
  })

  test('a denied spawn is returned as given and nothing is watched', async ($, on) => {
    const { opened } = engine(on, { denySpawn: 'no subagents here' })

    const started = await spawn($, 'developer', 'algo')

    expect(started).toMatchObject({ deny: 'no subagents here' })
    expect(started.agentId).toBeUndefined()
    expect(agentsOf()).toEqual([])
    expect(opened).toEqual([])
  })

  test('the hooks return exactly what next gave', async ($, on) => {
    engine(on)

    const started = await spawn($, 'developer', 'algo')
    const ran = await callTool($, 'agent-1', { tool: 'Bash', command: 'ls' })
    const failed = await callTool($, 'agent-1', { tool: 'Bash', command: 'exit 1' })
    const done = await complete($, 'agent-1')

    expect(started).toMatchObject({ model: 'test-model', agentId: 'agent-1' })
    expect(ran).toMatchObject({ result: 'ok', text: 'ok' })
    expect(ran.isError).toBeUndefined()
    expect(failed).toMatchObject({ isError: true, result: 'failed', text: 'failed' })
    expect(done).toMatchObject({ text: 'listo' })
  })

  test('/nursery-panel reports why the pane is not placed', async ($, on) => {
    const { opened } = engine(on, { unplaced: 'terminal too small' })

    const ran = await $.command.run({ command: 'nursery-panel', args: '' } as Parameters<
      Engine['command']['run']
    >[0])

    expect(ran.text).toBe('El panel de subagentes espera lugar: terminal too small')
    expect(opened).toEqual([PANE])
  })

  test('the band draws nothing at all when the pane is placed, even with running agents', async ($, on) => {
    engine(on, { placed: true })
    on('ui.render', { component: 'AbovePrompt' }, (_$, e) => _$.ui.resolve(e).Box({ key: 'engine-band' }))
    await spawn($, 'developer', 'uno')
    await spawn($, 'developer', 'dos')

    const ui = await $.ui.mount({
      plugin: 'nursery',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: bandProps,
      viewport: { columns: 120, rows: 40 },
    })

    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test('a turn that ends before its spawn is recorded is not left running', async ($, on) => {
    engine(on)

    await complete($, 'agent-1')
    await spawn($, 'developer', 'rápido')

    expect(agentsOf()[0]).toMatchObject({ id: 'agent-1', status: 'completed', endedAt: 1_000 })
  })

  test('the tick reconciles running agents with the agent list', async ($, on) => {
    let status: AgentInfo['status'] = 'running'
    const { clock } = engine(on, {
      listed: () => [{ id: 'agent-1', type: 'developer', description: 'algo', status }],
    })
    await spawn($, 'developer', 'algo')
    status = 'failed'

    await clock.advance(5_000)

    expect(agentsOf()[0]?.status).toBe('failed')
  })

  test('the pane opens by itself only once per session', async ($, on) => {
    const { opened } = engine(on)

    await spawn($, 'developer', 'uno')
    await spawn($, 'developer', 'dos')

    expect(opened).toEqual([PANE])
  })

  test('labels drop control characters and escape sequences', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    await callTool($, 'agent-1', { tool: 'Bash', command: '\u001b[31mnpm\u0007 test\r\nnext' })

    expect(agentsOf()[0]?.activity[0]?.label).toBe('Bash npm test')
  })

  test('a narrow pane abbreviates the tool count', async ($, on) => {
    engine(on)
    await spawn($, 'developer', 'algo')

    const ui = await $.ui.mount({
      plugin: 'nursery',
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: { ...paneProps, bodyColumns: 60 },
      viewport: { columns: 60, rows: 40 },
    })

    expect((await ui.find({ type: 'Button' }))?.text).toMatch(/0 herr\./)
    await ui.unmount()
  })
})
