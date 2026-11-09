import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { addProfile } from '@kikedealba/kit/profiles'
import { setSetting } from '@kikedealba/kit/settings'
import { renderNursery } from '../src/render.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'src', 'bin', 'nursery.ts')
const HAS_CLAUDE = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30_000 }).status === 0
const SKIP = HAS_CLAUDE ? false : 'the claude binary is not on PATH'
const TIMEOUT = 180_000

type Cleanup = { after: (fn: () => Promise<void>) => void }

interface Marketplace {
  name: string
  source: string
  path?: string
}

interface Plugin {
  id: string
  version: string
  scope: string
  enabled: boolean
  installPath: string
  readFromFolder?: string
}

async function sandbox(t: Cleanup) {
  const home = realpathSync(await mkdtemp(path.join(tmpdir(), 'nursery-e2e-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    KIT_CONFIG_DIR: path.join(home, 'kit'),
    KIT_REGISTRY_DIR: path.join(home, 'registry'),
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  return { home, env, ctx: platformContext({ home, env }) }
}

function claude(env: NodeJS.ProcessEnv, ...args: string[]): string {
  const run = spawnSync('claude', args, { encoding: 'utf8', env, timeout: 120_000 })
  assert.equal(run.status, 0, `claude ${args.join(' ')}\n${run.stdout}${run.stderr}`)
  return run.stdout
}

function json<T>(env: NodeJS.ProcessEnv, ...args: string[]): T {
  return JSON.parse(claude(env, ...args, '--json')) as T
}

function refresh(env: NodeJS.ProcessEnv, ...extra: string[]): { marketplace: string; version: string; profiles: { profile: string; steps: { item: string; state: string; detail: string }[] }[] } {
  const run = spawnSync(process.execPath, [BIN, 'setup', '--refresh', '--agents', 'claude', '--json', ...extra], { encoding: 'utf8', env, timeout: TIMEOUT })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const envelope = JSON.parse(run.stdout.trim()) as { ok: boolean; data: ReturnType<typeof refresh> }
  assert.equal(envelope.ok, true)
  return envelope.data
}

function nursery(env: NodeJS.ProcessEnv): Plugin | undefined {
  return json<Plugin[]>(env, 'plugin', 'list').find((plugin) => plugin.id === 'nursery@nursery')
}

function marketplaces(env: NodeJS.ProcessEnv): Marketplace[] {
  return json<Marketplace[]>(env, 'plugin', 'marketplace', 'list').filter((entry) => entry.name === 'nursery')
}

async function agentFiles(plugin: Plugin | undefined): Promise<string[]> {
  assert.ok(plugin, 'nursery@nursery is not installed')
  return (await readdir(path.join(plugin.installPath, 'agents'))).sort()
}

test('the real claude binary installs the rendered marketplace without an account and a second refresh changes nothing', { skip: SKIP, timeout: TIMEOUT * 2 }, async (t) => {
  const { home, env } = await sandbox(t)
  const first = refresh(env)
  assert.deepEqual(first.profiles.flatMap((entry) => entry.steps).filter((step) => step.state === 'failed'), [])
  const [entry] = marketplaces(env)
  assert.equal(marketplaces(env).length, 1)
  assert.equal(entry?.source, 'directory')
  assert.equal(realpathSync(entry?.path ?? ''), realpathSync(first.marketplace))
  const plugin = nursery(env)
  assert.equal(plugin?.version, first.version)
  assert.equal(plugin?.enabled, true)
  assert.equal(plugin?.scope, 'user')
  assert.equal((await agentFiles(plugin)).length, 10)
  assert.match(await readFile(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), /<!-- kit:nursery:begin -->[\s\S]*máximo 10 agentes[\s\S]*<!-- kit:nursery:end -->/)

  const second = refresh(env)
  assert.equal(second.version, first.version)
  assert.deepEqual(second.profiles.flatMap((step) => step.steps).filter((step) => step.state === 'failed'), [])
  assert.equal(nursery(env)?.version, first.version)
  assert.equal(marketplaces(env).length, 1)
})

test('the real claude binary follows settings: disabled roles leave the installed plugin and the version moves', { skip: SKIP, timeout: TIMEOUT * 2 }, async (t) => {
  const { env, ctx } = await sandbox(t)
  const first = refresh(env)
  await setSetting('agents.enabled', 'developer,qa-automation', ctx)
  await setSetting('agents.developer.maxTurns', 7, ctx)
  const second = refresh(env)
  assert.notEqual(second.version, first.version)
  const plugin = nursery(env)
  assert.equal(plugin?.version, second.version)
  assert.deepEqual(await agentFiles(plugin), ['developer.md', 'qa-automation.md'])
  assert.match(await readFile(path.join(plugin?.installPath ?? '', 'agents', 'developer.md'), 'utf8'), /^maxTurns: 7$/m)
})

test('the real claude binary leaves a foreign local marketplace named nursery alone and still refreshes the rules block', { skip: SKIP, timeout: TIMEOUT * 2 }, async (t) => {
  const { home, env } = await sandbox(t)
  const legacy = await sandbox(t)
  await setSetting('agents.maxParallel', 3, legacy.ctx)
  const old = await renderNursery(legacy.ctx)
  claude(env, 'plugin', 'marketplace', 'add', old.marketplace)
  claude(env, 'plugin', 'install', 'nursery@nursery', '--scope', 'user')
  assert.equal(realpathSync(marketplaces(env)[0]?.path ?? ''), realpathSync(old.marketplace))
  const memory = path.join(home, '.claude', 'CLAUDE.md')
  await mkdir(path.dirname(memory), { recursive: true })
  await writeFile(memory, '# Mine\n\nkeep this\n\n<!-- kit:nursery:begin -->\nold rules máximo 99 agentes\n<!-- kit:nursery:end -->\n\ntail\n')

  const result = refresh(env)
  assert.deepEqual(result.profiles.flatMap((entry) => entry.steps).filter((step) => step.state === 'failed'), [])
  assert.ok(result.profiles[0]?.steps.some((step) => step.item === 'marketplace nursery' && step.state === 'skipped' && step.detail.includes(old.marketplace)))
  const registered = marketplaces(env)
  assert.equal(registered.length, 1)
  assert.equal(realpathSync(registered[0]?.path ?? ''), realpathSync(old.marketplace))
  assert.equal(nursery(env)?.version, old.version)
  const text = await readFile(memory, 'utf8')
  assert.equal(text.match(/<!-- kit:nursery:begin -->/g)?.length, 1)
  assert.match(text, /^# Mine\n\nkeep this\n/)
  assert.match(text, /tail\n$/)
  assert.doesNotMatch(text, /máximo 99/)
  assert.match(text, /máximo 10 agentes/)
})

test('the real claude binary keeps two profiles apart: one CLAUDE_CONFIG_DIR per profile, the builtin one under HOME', { skip: SKIP, timeout: TIMEOUT * 2 }, async (t) => {
  const { home, env, ctx } = await sandbox(t)
  const { profile } = await addProfile('work', ctx)
  const result = refresh(env)
  assert.deepEqual(result.profiles.map((entry) => entry.profile), ['default', 'work'])
  assert.deepEqual(result.profiles.flatMap((entry) => entry.steps).filter((step) => step.state === 'failed'), [])
  const work = { ...env, CLAUDE_CONFIG_DIR: profile.claude ?? '' }
  const builtin = nursery(env)
  const other = nursery(work)
  assert.ok(builtin && other)
  assert.ok(builtin.installPath.startsWith(path.join(home, '.claude')))
  assert.ok(other.installPath.startsWith(profile.claude ?? ''))
  assert.notEqual(builtin.installPath, other.installPath)
  assert.equal(other.version, builtin.version)

  await setSetting('agents.enabled', 'researcher', ctx)
  refresh(env)
  assert.deepEqual(await agentFiles(nursery(env)), ['researcher.md'])
  assert.deepEqual(await agentFiles(nursery(work)), ['researcher.md'])
  assert.match(await readFile(path.join(profile.claude ?? '', 'CLAUDE.md'), 'utf8'), /agente de nursery \(researcher\)/)

  const only = refresh(env, '--profile', 'work')
  assert.deepEqual(only.profiles.map((entry) => entry.profile), ['work'])
  assert.ok(existsSync(path.join(profile.claude ?? '', 'CLAUDE.md')))
})

async function buildCopy(t: Cleanup) {
  const copy = await mkdtemp(path.join(tmpdir(), 'nursery-build-'))
  t.after(() => rm(copy, { recursive: true, force: true }))
  for (const entry of ['src', 'agents', 'subagents', 'rules', 'skills', '.claude-plugin', 'hooks', 'types', 'gemini', 'package.json']) {
    if (existsSync(path.join(ROOT, entry))) await cp(path.join(ROOT, entry), path.join(copy, entry), { recursive: true })
  }
  await cp(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), { recursive: true, verbatimSymlinks: true })
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(copy, 'src', 'bin', 'nursery.ts'), 'build', ...args], { encoding: 'utf8' })
  return { copy, run }
}

test('nursery build --check fails on an edited or missing generated file, names it, and passes after nursery build', async (t) => {
  const { copy, run } = await buildCopy(t)
  const clean = run('--check')
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)

  await writeFile(path.join(copy, 'agents', 'developer.md'), 'tampered\n')
  await rm(path.join(copy, 'subagents', 'sre.md'))
  await rm(path.join(copy, 'rules', 'RULES.md'))
  await writeFile(path.join(copy, 'skills', 'nursery', 'SKILL.md'), 'hasta 10 agentes\n')
  const stale = run('--check')
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /out of date:/)
  for (const name of ['agents/developer', 'subagents/sre', 'rules/RULES.md', 'skills/nursery/SKILL.md']) assert.ok(stale.stdout.includes(name), `${name} missing in ${stale.stdout}`)
  assert.equal(await readFile(path.join(copy, 'agents', 'developer.md'), 'utf8'), 'tampered\n')

  assert.equal(run().status, 0)
  const fixed = run('--check')
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
})

test('nursery build --check on a source edit names the generated agents that depend on it', async (t) => {
  const { copy, run } = await buildCopy(t)
  const source = path.join(copy, 'src', 'agents', 'sre.md')
  await writeFile(source, `${await readFile(source, 'utf8')}\nExtra line.\n`)
  const stale = run('--check')
  assert.equal(stale.status, 1)
  assert.ok(stale.stdout.includes('agents/sre') && stale.stdout.includes('subagents/sre'), stale.stdout)
  assert.ok(!stale.stdout.includes('agents/developer'), stale.stdout)
})

test('an orphan generated agent reported by build --check is removed by the build the message tells you to run', async (t) => {
  const { copy, run } = await buildCopy(t)
  await writeFile(path.join(copy, 'subagents', 'orphan.md'), 'orphan\n')
  assert.equal(run('--check').status, 1)
  assert.equal(run().status, 0)
  assert.equal(run('--check').status, 0)
})
