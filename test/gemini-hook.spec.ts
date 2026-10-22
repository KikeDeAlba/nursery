import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { flowDir, saveState, statePath } from '../src/flow-store.ts'
import type { FlowState } from '../src/flow-types.ts'
import { runGeminiHook, type GeminiHookDeps } from '../src/hooks/gemini-hook.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'nursery.ts')

async function sandbox(t: { after: (fn: () => Promise<void>) => void }, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nursery-gemini-hook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const geminiHome = path.join(root, '.gemini')
  const deps: GeminiHookDeps = { env: { NURSERY_PLANS_DIR: path.join(root, 'plans'), ...env }, now: () => new Date(2026, 9, 22, 9, 5), geminiHome }
  return { root, geminiHome, deps }
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    return { value: await fn(), stderr: writes.join('') }
  } finally {
    process.stderr.write = original
  }
}

function start(cwd: string, sessionId = 's1'): string {
  return JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'BeforeAgent', prompt: '[nursery-flow] Lleva este pedido\n<pedido>\nagrega X\n</pedido>' })
}

test('an unknown event returns an empty result without touching disk', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  for (const event of ['', 'Stop', 'beforeagent', 'SessionStart']) {
    assert.deepEqual(await runGeminiHook(event, start(root), deps), {})
  }
  assert.ok(!existsSync(flowDir(geminiHome)))
})

test('NURSERY_FLOW=off disables the hook in any case', async (t) => {
  for (const value of ['off', 'OFF', 'Off']) {
    const { root, geminiHome, deps } = await sandbox(t, { NURSERY_FLOW: value })
    assert.deepEqual(await runGeminiHook('BeforeAgent', start(root), deps), {})
    assert.ok(!existsSync(flowDir(geminiHome)))
  }
})

test('invalid json or a payload without string session_id and cwd returns an empty result', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const invalid = await quietly(() => runGeminiHook('BeforeAgent', '{not json', deps))
  assert.deepEqual(invalid.value, {})
  assert.match(invalid.stderr, /^nursery gemini-hook: /)
  for (const raw of ['null', '[]', '"text"', JSON.stringify({ cwd: root, prompt: '[nursery-flow]' }), JSON.stringify({ session_id: 1, cwd: root, prompt: '[nursery-flow]' }), JSON.stringify({ session_id: 's1', prompt: '[nursery-flow]' })]) {
    assert.deepEqual(await runGeminiHook('BeforeAgent', raw, deps), {}, raw)
  }
  assert.ok(!existsSync(flowDir(geminiHome)))
})

test('without a state file only a flow start goes past the fast path', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const events: [string, Record<string, unknown>][] = [
    ['BeforeAgent', { prompt: 'hola' }],
    ['BeforeTool', { tool_name: 'write_file', tool_input: { file_path: 'a.ts' } }],
    ['AfterTool', { tool_name: 'invoke_agent', tool_input: {}, tool_response: {} }],
    ['AfterAgent', { prompt: 'x', prompt_response: 'y' }],
  ]
  for (const [event, body] of events) {
    assert.deepEqual(await runGeminiHook(event, JSON.stringify({ session_id: 's1', cwd: root, ...body }), deps), {}, event)
  }
  assert.ok(!existsSync(flowDir(geminiHome)))
})

test('an internal error returns an empty result and reports it on stderr', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  await mkdir(path.dirname(flowDir(geminiHome)), { recursive: true })
  await writeFile(flowDir(geminiHome), 'not a directory')
  const blocked = await quietly(() => runGeminiHook('BeforeAgent', start(root), deps))
  assert.deepEqual(blocked.value, {})
  assert.match(blocked.stderr, /^nursery gemini-hook: /)

  const badId = await quietly(() => runGeminiHook('BeforeAgent', start(root, '../escape'), deps))
  assert.deepEqual(badId.value, {})
  assert.match(badId.stderr, /^nursery gemini-hook: invalid session id/)
})

test('a finished flow keeps its state untouched and releases the lock', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const file = statePath(flowDir(geminiHome), 's1')
  const state: FlowState = {
    version: 1,
    sessionId: 's1',
    cwd: root,
    request: 'agrega X',
    planPath: path.join(root, 'plans', 'p.md'),
    phase: 'done',
    startedAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T09:00:00.000Z',
    activeAgents: 0,
    researched: true,
    reads: { used: 1, limit: 4 },
    proposals: 1,
    corrections: 0,
    changed: true,
    validation: { qa: true, review: true },
    retries: { validation: 0, gaveUp: false },
  }
  await saveState(file, state)
  const before = await readFile(file, 'utf8')
  assert.deepEqual(await runGeminiHook('BeforeTool', JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'write_file', tool_input: { file_path: 'a.ts' } }), deps), {})
  assert.equal(await readFile(file, 'utf8'), before)
  assert.ok(!existsSync(`${file}.lock`))
})

test('the gemini-hook subcommand always exits 0 with one json line on stdout', async (t) => {
  const { root, geminiHome } = await sandbox(t)
  const run = (args: string[], input: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [BIN, 'gemini-hook', ...args], { input, encoding: 'utf8', env: { ...process.env, GEMINI_CLI_HOME: root, NURSERY_PLANS_DIR: path.join(root, 'plans'), NURSERY_FLOW: '', ...extra } })

  const cases: [string[], string, NodeJS.ProcessEnv][] = [
    [['BeforeTool'], JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'read_file', tool_input: {} }), {}],
    [['BeforeAgent'], '{not json', {}],
    [['Bogus'], '{}', {}],
    [[], '', {}],
    [['BeforeAgent', '--json'], start(root), { NURSERY_FLOW: 'off' }],
    [['--help'], '', {}],
  ]
  for (const [args, input, extra] of cases) {
    const result = run(args, input, extra)
    assert.equal(result.status, 0, args.join(' '))
    assert.equal(result.stdout, '{}\n', args.join(' '))
    assert.deepEqual(JSON.parse(result.stdout), {})
  }
  assert.ok(!existsSync(flowDir(geminiHome)))
})

const UNREADABLE = { decision: 'deny', reason: 'El estado del flujo de nursery no se pudo leer. Vuelve a lanzar /nursery o desactívalo con NURSERY_FLOW=off.' }

function activeState(root: string, overrides: Partial<FlowState> = {}): FlowState {
  return {
    version: 1,
    sessionId: 's1',
    cwd: root,
    request: 'agrega X',
    planPath: path.join(root, 'plans', 'demo', 'p.md'),
    phase: 'explore',
    startedAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T09:00:00.000Z',
    activeAgents: 0,
    researched: false,
    reads: { used: 0, limit: 8 },
    proposals: 0,
    corrections: 0,
    changed: false,
    validation: { qa: false, review: false },
    retries: { validation: 0, gaveUp: false },
    ...overrides,
  }
}

function tool(root: string, tool_name: string, tool_input: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 's1', cwd: root, tool_name, tool_input })
}

async function expectFailClosed(root: string, deps: GeminiHookDeps): Promise<void> {
  for (const [name, input] of [['write_file', { file_path: 'a.ts' }], ['replace', { file_path: 'a.ts' }], ['run_shell_command', { command: 'ls' }], ['invoke_agent', { agent_name: 'developer' }], ['mcp_jira_createIssue', {}]] as const) {
    const result = await quietly(() => runGeminiHook('BeforeTool', tool(root, name, input), deps))
    assert.deepEqual(result.value, UNREADABLE, name)
    assert.match(result.stderr, /^nursery gemini-hook: /)
  }
  for (const [name, input] of [['read_file', {}], ['invoke_agent', { agent_name: 'researcher' }], ['mcp_jira_getIssue', {}]] as const) {
    assert.deepEqual((await quietly(() => runGeminiHook('BeforeTool', tool(root, name, input), deps))).value, {}, name)
  }
  assert.deepEqual((await quietly(() => runGeminiHook('AfterAgent', JSON.stringify({ session_id: 's1', cwd: root, prompt: 'x', prompt_response: 'y' }), deps))).value, {})
}

test('a corrupt state file fails closed for risky tools and a new /nursery replaces it', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const file = statePath(flowDir(geminiHome), 's1')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{not json')
  await expectFailClosed(root, deps)
  assert.equal(await readFile(file, 'utf8'), '{not json')
  const restarted = await runGeminiHook('BeforeAgent', start(root), deps)
  assert.ok('hookSpecificOutput' in restarted)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).phase, 'explore')
})

test('a state whose plan path leaves the plans directory is treated as unreadable', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const file = statePath(flowDir(geminiHome), 's1')
  await saveState(file, activeState(root, { planPath: path.join(root, 'plans', '..', 'outside.md') }))
  await expectFailClosed(root, deps)
  await saveState(file, activeState(root))
  assert.deepEqual(await runGeminiHook('BeforeTool', tool(root, 'read_file'), deps), {})
})

test('a lock that is never released fails closed for risky tools', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  const file = statePath(flowDir(geminiHome), 's1')
  await saveState(file, activeState(root))
  await mkdir(`${file}.lock`)
  const result = await quietly(() => runGeminiHook('BeforeTool', tool(root, 'write_file', { file_path: 'a.ts' }), deps))
  assert.deepEqual(result.value, UNREADABLE)
  assert.match(result.stderr, /timed out/)
})

test('an active flow denies unknown tools before acceptance through the adapter', async (t) => {
  const { root, geminiHome, deps } = await sandbox(t)
  await saveState(statePath(flowDir(geminiHome), 's1'), activeState(root))
  const result = await runGeminiHook('BeforeTool', tool(root, 'mcp_jira_transitionIssue'), deps)
  assert.ok('decision' in result && result.decision === 'deny')
})
