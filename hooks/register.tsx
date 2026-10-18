import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, Register, Timer } from 'claude-code'

import type { NurseryActivity, NurseryAgent, NurseryAgentStatus } from '../types'

const PANE = 'nursery-panel'
const TITLE = 'Subagentes'
const MAX_AGENTS = 30
const MAX_ACTIVITY = 5
const TOOL_LABEL_MAX = 80
const TEXT_LABEL_MAX = 120
const TYPE_WIDTH = 15
const TICK_MS = 1000
const RECONCILE_EVERY = 5
const MAX_ENDED_EARLY = 50
const WIDE_COLUMNS = 80
const NURSERY_PREFIX = 'nursery:'

const agents = atom({ plugin: 'nursery', key: 'agents' } as const, [])
const clockNow = atom({ plugin: 'nursery', key: 'now' } as const, 0)
const isPaneOffered = atom({ plugin: 'nursery', key: 'isPaneOffered' } as const, false)

const TOOL_DETAIL: Readonly<Record<string, string>> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  Agent: 'description',
}

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write'])

const STATUS_FROM_LIST: Readonly<Record<AgentStatus, NurseryAgentStatus>> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'completed',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}

const STATUS_GLYPH: Readonly<Record<NurseryAgentStatus, string>> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

const STATUS_COLOR: Readonly<Record<NurseryAgentStatus, string>> = {
  running: 'claude',
  completed: 'success',
  failed: 'error',
  killed: 'inactive',
}

const ACTIVITY_GLYPH: Readonly<Record<NurseryActivity['state'], string>> = {
  running: '…',
  done: '✓',
  failed: '✗',
}

type Placed = { agent: NurseryAgent; depth: number }

type Ending = { status: NurseryAgentStatus; endedAt: number }

const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

let ticker: Timer | undefined
let ticks = 0
let cwd: string | undefined
const endedEarly = new Map<string, Ending>()

const sanitize = (text: string): string =>
  text.replace(ESCAPE_SEQUENCE, '').replace(/\t/g, ' ').replace(CONTROL, '')

const firstLine = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map(line => sanitize(line).trim())
    .find(line => line.length > 0) ?? ''

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

const relativeTo = (path: string, root: string | undefined): string => {
  if (root === undefined || root === '') return path
  const prefix = root.endsWith('/') ? root : `${root}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const toolLabel = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  root: string | undefined,
): string => {
  const field = TOOL_DETAIL[tool]
  const raw = field === undefined ? undefined : input[field]
  const value = typeof raw === 'string' ? raw : ''
  const detail = firstLine(PATH_TOOLS.has(tool) ? relativeTo(value, root) : value)

  return clip(detail === '' ? tool : `${tool} ${detail}`, TOOL_LABEL_MAX)
}

const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  return hours > 0
    ? `${hours}h${String(minutes).padStart(2, '0')}m`
    : `${minutes}m${String(seconds).padStart(2, '0')}s`
}

const shortType = (type: string): string =>
  type.startsWith(NURSERY_PREFIX) ? type.slice(NURSERY_PREFIX.length) : type

const isRunning = (agent: NurseryAgent): boolean => agent.status === 'running'

const elapsedOf = (agent: NurseryAgent, now: number): string =>
  formatElapsed((agent.endedAt ?? now) - agent.startedAt)

const withActivity = (agent: NurseryAgent, activity: NurseryActivity): NurseryAgent => ({
  ...agent,
  activity: [...agent.activity, activity].slice(-MAX_ACTIVITY),
})

const byStatusThenStart = (a: NurseryAgent, b: NurseryAgent): number =>
  Number(isRunning(b)) - Number(isRunning(a)) || a.startedAt - b.startedAt

const arrange = (list: readonly NurseryAgent[]): Placed[] => {
  const ids = new Set(list.map(agent => agent.id))
  const children = new Map<string | undefined, NurseryAgent[]>()

  for (const agent of list) {
    const parent = agent.parentId !== undefined && ids.has(agent.parentId) ? agent.parentId : undefined
    children.set(parent, [...(children.get(parent) ?? []), agent])
  }

  const walk = (parent: string | undefined, depth: number): Placed[] =>
    [...(children.get(parent) ?? [])]
      .sort(byStatusThenStart)
      .flatMap(agent => [{ agent, depth }, ...walk(agent.id, depth + 1)])

  return walk(undefined, 0)
}

const quietly = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    return
  }
}

const isWatched = async ($: EngineInterface, agentId: string | undefined): Promise<boolean> => {
  if (agentId === undefined) return false
  try {
    return (await read($, agents)).some(agent => agent.id === agentId)
  } catch {
    return false
  }
}

const change = ($: EngineInterface, agentId: string, fn: (agent: NurseryAgent) => NurseryAgent) =>
  update($, agents, list => list.map(agent => (agent.id === agentId ? fn(agent) : agent)))

const toolsText = (count: number, isWide: boolean): string =>
  isWide ? `${count} ${count === 1 ? 'herramienta' : 'herramientas'}` : `${count} herr.`

const rememberEnding = (agentId: string, ending: Ending): void => {
  endedEarly.delete(agentId)
  endedEarly.set(agentId, ending)
  for (const stale of endedEarly.keys()) {
    if (endedEarly.size <= MAX_ENDED_EARLY) break
    endedEarly.delete(stale)
  }
}

const reconcile = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list()
  const statusById = new Map(listed.map(info => [info.id, STATUS_FROM_LIST[info.status]] as const))
  const now = await $.clock.now()
  await update($, agents, list =>
    list.map(agent => {
      const status = statusById.get(agent.id)

      return isRunning(agent) && status !== undefined && status !== 'running'
        ? { ...agent, status, endedAt: now }
        : agent
    }),
  )
}

const stopTicking = (): void => {
  ticker?.cancel()
  ticker = undefined
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (!(await read($, agents)).some(isRunning)) {
    stopTicking()
    return
  }
  ticks += 1
  if (ticks % RECONCILE_EVERY === 0) await quietly(() => reconcile($))
  const now = await $.clock.now()
  await update($, clockNow, () => now)
}

const keepTicking = ($: EngineInterface): void => {
  if (ticker !== undefined) return
  ticker = $.clock.every(TICK_MS, () => {
    void quietly(() => tick($))
  })
}

const sessionCwd = async ($: EngineInterface): Promise<string | undefined> => {
  if (cwd !== undefined) return cwd
  try {
    cwd = await $.session.cwd()
  } catch {
    return undefined
  }

  return cwd
}

const fromInfo = (info: AgentInfo, now: number): NurseryAgent => ({
  id: info.id,
  type: info.type,
  description: info.description,
  ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
  status: STATUS_FROM_LIST[info.status],
  startedAt: now,
  ...(STATUS_FROM_LIST[info.status] === 'running' ? {} : { endedAt: now }),
  toolCount: 0,
  activity: [],
})

const seed = async ($: EngineInterface): Promise<void> => {
  const listed = await $.agent.list()
  if (listed.length === 0) return
  const now = await $.clock.now()
  const list = await update($, agents, current => {
    const known = new Set(current.map(agent => agent.id))
    const fresh = listed.filter(info => !known.has(info.id)).map(info => fromInfo(info, now))

    return [...current, ...fresh].slice(-MAX_AGENTS)
  })
  if (list.some(isRunning)) keepTicking($)
}

const textOf = (content: readonly { type: string; [field: string]: unknown }[]): string =>
  content
    .filter(block => block.type === 'text' && typeof block['text'] === 'string')
    .map(block => block['text'] as string)
    .join('\n')

const viewAgent = async ($: EngineInterface, agentId: string): Promise<void> => {
  const viewed = await $.ui.view({ agentId })
  if (viewed.deny !== undefined) $.ui.toast(`No se pudo abrir el subagente: ${viewed.deny}`)
}

const offerPane = async ($: EngineInterface): Promise<void> => {
  if (await read($, isPaneOffered)) return
  await update($, isPaneOffered, () => true)
  await $.ui.open({ id: PANE, title: TITLE })
}

const statusOfTurn = (reason: string): NurseryAgentStatus =>
  reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await quietly(() =>
      $.command.register({ name: 'nursery-panel', description: 'Abre el panel en vivo de los subagentes' }),
    )
    await quietly(() => seed($))

    return next(e)
  })

  on('command.run', { command: 'nursery-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? 'Panel de subagentes abierto.'
        : `El panel de subagentes espera lugar: ${opened.reason}`,
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId === undefined) return started

    await quietly(async () => {
      const now = await $.clock.now()
      const early = e.resume === undefined ? endedEarly.get(agentId) : undefined
      endedEarly.delete(agentId)
      const list = await update($, agents, list => {
        const previous = list.find(agent => agent.id === agentId)
        const base: NurseryAgent = previous ?? {
          id: agentId,
          type: e.subagentType,
          description: e.description,
          ...(e.parentAgentId === undefined ? {} : { parentId: e.parentAgentId }),
          status: 'running',
          startedAt: now,
          toolCount: 0,
          activity: [],
        }
        const { endedAt: _ended, ...rest } = base
        const agent: NurseryAgent =
          early === undefined ? { ...rest, status: 'running' } : { ...rest, ...early }

        return [...list.filter(one => one.id !== agentId), agent].slice(-MAX_AGENTS)
      })
      if (list.some(isRunning)) keepTicking($)
      await offerPane($)
    })

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined || !(await isWatched($, agentId))) return next(e)

    const tool = String(e.tool)
    const callId = e.tool_use_id
    await quietly(async () => {
      const label = toolLabel(tool, e as unknown as Record<string, unknown>, await sessionCwd($))
      await change($, agentId, agent =>
        withActivity(agent, { kind: 'tool', label, state: 'running', id: callId }),
      )
    })

    const finish = (state: NurseryActivity['state']) =>
      quietly(() =>
        change($, agentId, agent => ({
          ...agent,
          toolCount: agent.toolCount + 1,
          activity: agent.activity.map(one =>
            one.kind === 'tool' && one.id === callId ? { ...one, state } : one,
          ),
        })),
      )

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      await finish('failed')
      throw error
    }
    await finish(ran.deny !== undefined || ran.isError === true ? 'failed' : 'done')

    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const agentId = e.agentId

    if (e.message.type === 'assistant' && (await isWatched($, agentId)) && agentId !== undefined) {
      await quietly(async () => {
        const line = firstLine(textOf(e.message.content))
        if (line === '') return
        await change($, agentId, agent =>
          withActivity(agent, { kind: 'text', label: clip(line, TEXT_LABEL_MAX), state: 'done' }),
        )
      })
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId

    if (agentId !== undefined) {
      await quietly(async () => {
        const ending: Ending = { status: statusOfTurn(e.reason), endedAt: await $.clock.now() }
        if (await isWatched($, agentId)) {
          await change($, agentId, agent => ({ ...agent, ...ending }))
        } else {
          rememberEnding(agentId, ending)
        }
      })
    }

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    await read($, clockNow)
    const now = await $.clock.now()
    if (list.some(isRunning)) keepTicking($)
    const room = Math.max(
      2,
      e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : (e.viewport?.rows ?? 24) - 4,
    )
    const columns = Math.max(40, e.props.bodyColumns)
    const isWide = columns >= WIDE_COLUMNS

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>{TITLE}</Text>
          <Text dimColor>Ningún subagente en esta sesión.</Text>
        </Box>
      )
    }

    const lines = arrange(list).flatMap(({ agent, depth }) => {
      const indent = '  '.repeat(depth)
      const isDone = !isRunning(agent)
      const type = shortType(agent.type)
      const isNursery = type !== agent.type
      const tail = `${elapsedOf(agent, now).padStart(6)} ${toolsText(agent.toolCount, isWide).padStart(isWide ? 16 : 8)}`
      const descriptionWidth = Math.max(8, columns - indent.length - TYPE_WIDTH - tail.length - 5)
      const description = clip(firstLine(agent.description), descriptionWidth).padEnd(descriptionWidth)
      const row = (
        <Button key={`agent-${agent.id}`} plain onPress={() => void quietly(() => viewAgent($, agent.id))}>
          {indent}
          <Text color={STATUS_COLOR[agent.status]}>{STATUS_GLYPH[agent.status]}</Text>{' '}
          <Text
            bold
            dimColor={isDone}
            {...(isNursery ? { color: 'suggestion' } : {})}
          >
            {clip(type, TYPE_WIDTH).padEnd(TYPE_WIDTH)}
          </Text>{' '}
          <Text dimColor={isDone}>{description}</Text>
          <Text dimColor>{` ${tail}`}</Text>
        </Button>
      )
      const activity = isDone
        ? []
        : agent.activity.map(one => (
            <Text dimColor={one.kind === 'tool' && one.state === 'done'}>
              {indent}
              {'  '}
              <Text {...(one.state === 'failed' ? { color: 'error' } : {})}>
                {one.kind === 'text' ? '»' : ACTIVITY_GLYPH[one.state]}
              </Text>{' '}
              {one.label}
            </Text>
          ))

      return [row, ...activity]
    })

    const visible = lines.length > room - 1 ? lines.slice(0, Math.max(1, room - 2)) : lines
    const hidden = lines.length - visible.length

    return (
      <Box flexDirection="column">
        <Text bold>{TITLE}</Text>
        {visible}
        {hidden > 0 && <Text dimColor>{`+${hidden} más`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const running = (await read($, agents)).filter(isRunning)
    if (running.length === 0) return next(e)

    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) return next(e)

    keepTicking($)
    const { Box, Text } = $.ui.resolve(e)
    await read($, clockNow)
    const now = await $.clock.now()
    const shown = running.slice(0, Math.max(1, e.props.maxRows))

    return (
      <Box flexDirection="column">
        {shown.map(agent => {
          const current =
            [...agent.activity].reverse().find(one => one.kind === 'tool')?.label ??
            firstLine(agent.description)
          const line = `${shortType(agent.type)} · ${elapsedOf(agent, now)} · ${current}`

          return (
            <Text wrap="truncate">
              <Text color={STATUS_COLOR.running}>{STATUS_GLYPH.running}</Text> {line}
            </Text>
          )
        })}
      </Box>
    )
  })
}
