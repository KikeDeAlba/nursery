import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { addProfile, profilesPath, removeProfile, renameBuiltinProfile } from '@kikedealba/kit/profiles'
import { setSetting } from '@kikedealba/kit/settings'
import { refreshProfiles } from '../src/refresh.ts'

type Cleanup = { after: (fn: () => Promise<void>) => void }

async function sandbox(t: Cleanup, extra: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-profiles-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = platformContext({
    home,
    env: {
      PATH: '',
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      KIT_CONFIG_DIR: path.join(home, 'kit'),
      KIT_REGISTRY_DIR: path.join(home, 'registry'),
      ...extra,
    },
  })
  return { home, ctx }
}

function recorder() {
  const calls: { env: string | undefined; args: string }[] = []
  return {
    calls,
    locate: async (command: string) => (command === 'claude' ? '/bin/claude' : null),
    exec: async (_command: string, args: readonly string[]) => {
      calls.push({ env: undefined, args: args.join(' ') })
      return args.at(-1) === '--json' ? '[]' : ''
    },
  }
}

function states(steps: { state: string }[]): string[] {
  return steps.map((step) => step.state)
}

test('a second refresh changes nothing in any profile', async (t) => {
  const { ctx } = await sandbox(t)
  const { profile } = await addProfile('work', ctx)
  const first = recorder()
  await refreshProfiles(['claude', 'codex'], { ctx, locate: first.locate, exec: first.exec })
  const files = [path.join(profile.claude ?? '', 'CLAUDE.md'), path.join(profile.codex ?? '', 'AGENTS.md'), path.join(profile.codex ?? '', 'agents', 'developer.toml')]
  const before = await Promise.all(files.map(async (file) => [await readFile(file, 'utf8'), (await stat(file)).mtimeMs] as const))
  const second = await refreshProfiles(['claude', 'codex'], { ctx, locate: first.locate, exec: first.exec })
  for (const entry of second.profiles) {
    for (const step of entry.steps.filter((candidate) => candidate.item === 'memory' || candidate.item.startsWith('subagent'))) {
      assert.notEqual(step.state, 'installed', `${entry.profile}: ${step.item}`)
      assert.notEqual(step.state, 'failed', `${entry.profile}: ${step.item}`)
    }
  }
  const after = await Promise.all(files.map(async (file) => [await readFile(file, 'utf8'), (await stat(file)).mtimeMs] as const))
  assert.deepEqual(after, before)
})

test('refresh propagates a setting change to every profile and prunes the disabled roles from codex in both', async (t) => {
  const { home, ctx } = await sandbox(t)
  const { profile } = await addProfile('work', ctx)
  const claude = recorder()
  await refreshProfiles(['codex'], { ctx, locate: claude.locate, exec: claude.exec })
  const dirs = [path.join(home, '.codex'), profile.codex ?? '']
  for (const dir of dirs) assert.ok(existsSync(path.join(dir, 'agents', 'sre.toml')), dir)
  await setSetting('agents.enabled', 'developer,researcher', ctx)
  await setSetting('agents.maxParallel', 2, ctx)
  await refreshProfiles(['codex'], { ctx, locate: claude.locate, exec: claude.exec })
  for (const dir of dirs) {
    assert.ok(!existsSync(path.join(dir, 'agents', 'sre.toml')), `${dir} kept sre`)
    assert.ok(existsSync(path.join(dir, 'agents', 'developer.toml')), dir)
    assert.match(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /máximo 2 agentes/, dir)
  }
})

test('a removed profile is no longer refreshed and its directories are left alone', async (t) => {
  const { ctx } = await sandbox(t)
  const { profile } = await addProfile('work', ctx)
  const claude = recorder()
  await refreshProfiles(['claude'], { ctx, locate: claude.locate, exec: claude.exec })
  const memory = path.join(profile.claude ?? '', 'CLAUDE.md')
  const before = await readFile(memory, 'utf8')
  await removeProfile('work', {}, ctx)
  await setSetting('agents.maxParallel', 3, ctx)
  const result = await refreshProfiles(['claude'], { ctx, locate: claude.locate, exec: claude.exec })
  assert.deepEqual(result.profiles.map((entry) => entry.profile), ['default'])
  assert.equal(await readFile(memory, 'utf8'), before)
  await assert.rejects(refreshProfiles(['claude'], { ctx, profile: 'work' }), { code: 'PROFILE_NOT_FOUND' })
})

test('a profile whose directory was deleted by hand is rebuilt by the next refresh', async (t) => {
  const { ctx } = await sandbox(t)
  const { profile } = await addProfile('work', ctx)
  const claude = recorder()
  await rm(profile.claude ?? '', { recursive: true, force: true })
  await rm(profile.codex ?? '', { recursive: true, force: true })
  const result = await refreshProfiles(['claude', 'codex'], { ctx, locate: claude.locate, exec: claude.exec })
  const work = result.profiles.find((entry) => entry.profile === 'work')
  assert.deepEqual(work?.steps.filter((step) => step.state === 'failed'), [])
  assert.ok(existsSync(path.join(profile.claude ?? '', 'CLAUDE.md')))
  assert.ok(existsSync(path.join(profile.codex ?? '', 'AGENTS.md')))
})

test('a renamed builtin profile keeps being the only one that touches single-account tools', async (t) => {
  const { home, ctx } = await sandbox(t)
  await addProfile('work', ctx)
  await renameBuiltinProfile('personal', ctx)
  const claude = recorder()
  const result = await refreshProfiles(['opencode', 'gemini', 'antigravity'], { ctx, locate: claude.locate, exec: claude.exec })
  assert.deepEqual(result.profiles.map((entry) => [entry.profile, entry.builtin, entry.agents]), [
    ['personal', true, ['opencode', 'gemini', 'antigravity']],
    ['work', false, []],
  ])
  assert.deepEqual(result.profiles[1]?.steps, [])
  assert.ok(existsSync(path.join(home, '.config', 'opencode', 'agents', 'developer.md')))
})

test('each profile runs claude with its own CLAUDE_CONFIG_DIR and the builtin one never inherits the caller', async (t) => {
  const { home, ctx } = await sandbox(t, { CLAUDE_CONFIG_DIR: '/inherited/claude', DEN_PROFILE: 'stale' })
  const { profile } = await addProfile('work', ctx)
  const seen: (string | undefined)[] = []
  const locate = async (command: string) => (command === 'claude' ? '/bin/claude' : null)
  const exec = async (_command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (args.join(' ') === 'plugin marketplace list --json') seen.push(options?.env?.['CLAUDE_CONFIG_DIR'])
    return args.at(-1) === '--json' ? '[]' : ''
  }
  const result = await refreshProfiles(['claude'], { ctx, locate, exec: exec as never })
  assert.equal(result.profiles.length, 2)
  assert.ok(!seen.includes('/inherited/claude'))
  assert.ok(existsSync(path.join(home, '.claude', 'CLAUDE.md')))
  assert.ok(existsSync(path.join(profile.claude ?? '', 'CLAUDE.md')))
  assert.ok(!existsSync('/inherited/claude'))
})

test('two sandboxes with different HOME, XDG and KIT_CONFIG_DIR never write into each other', async (t) => {
  const one = await sandbox(t)
  const two = await sandbox(t)
  await setSetting('agents.maxParallel', 2, one.ctx)
  await setSetting('agents.maxParallel', 7, two.ctx)
  const claude = recorder()
  const [a, b] = await Promise.all([
    refreshProfiles(['claude'], { ctx: one.ctx, locate: claude.locate, exec: claude.exec }),
    refreshProfiles(['claude'], { ctx: two.ctx, locate: claude.locate, exec: claude.exec }),
  ])
  assert.notEqual(a.marketplace, b.marketplace)
  assert.match(await readFile(path.join(one.home, '.claude', 'CLAUDE.md'), 'utf8'), /máximo 2 agentes/)
  assert.match(await readFile(path.join(two.home, '.claude', 'CLAUDE.md'), 'utf8'), /máximo 7 agentes/)
  assert.ok(a.marketplace.startsWith(one.home))
  assert.ok(b.marketplace.startsWith(two.home))
})

test('a corrupt profiles.json stops the refresh before anything is written', async (t) => {
  const { home, ctx } = await sandbox(t)
  await mkdir(path.dirname(profilesPath(ctx)), { recursive: true })
  await writeFile(profilesPath(ctx), '{ nope')
  const claude = recorder()
  await assert.rejects(refreshProfiles(['claude'], { ctx, locate: claude.locate, exec: claude.exec }), { code: 'PROFILES_INVALID' })
  assert.ok(!existsSync(path.join(home, '.claude', 'CLAUDE.md')))
  assert.deepEqual(claude.calls, [])
})

test('refresh with no agent installed leaves the builtin profile untouched and never fails', async (t) => {
  const { home, ctx } = await sandbox(t)
  await addProfile('work', ctx)
  const result = await refreshProfiles('detected', { ctx, locate: async () => null })
  assert.deepEqual(states(result.profiles[0]?.steps ?? []), [])
  for (const entry of result.profiles) assert.ok(!states(entry.steps).includes('failed'), entry.profile)
  assert.ok(!existsSync(path.join(home, '.claude', 'CLAUDE.md')))
})
