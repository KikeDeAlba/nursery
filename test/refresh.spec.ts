import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { addProfile } from '@kikedealba/kit/profiles'
import { setSetting } from '@kikedealba/kit/settings'
import { refreshProfiles } from '../src/refresh.ts'
import { marketplaceDir } from '../src/render.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'nursery.ts')

async function sandbox(t: { after: (fn: () => Promise<void>) => void }, extra: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-refresh-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    PATH: '',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    KIT_CONFIG_DIR: path.join(home, 'kit'),
    KIT_REGISTRY_DIR: path.join(home, 'registry'),
    ...extra,
  }
  return { home, env, ctx: platformContext({ home, env }) }
}

function recorder() {
  const calls: string[] = []
  return {
    calls,
    locate: async (command: string) => (command === 'claude' ? '/bin/claude' : null),
    exec: async (_command: string, args: readonly string[]) => {
      calls.push(args.join(' '))
      return args.at(-1) === '--json' ? '[]' : ''
    },
  }
}

test('refresh installs into every profile, and only the builtin pass touches single-account tools', async (t) => {
  const { home, ctx } = await sandbox(t, { CLAUDE_CONFIG_DIR: '/inherited/claude', CODEX_HOME: '/inherited/codex' })
  const { profile } = await addProfile('trabajo', ctx)
  await setSetting('agents.maxParallel', 3, ctx)
  const claude = recorder()
  const result = await refreshProfiles(['claude', 'codex', 'opencode'], { ctx, locate: claude.locate, exec: claude.exec })

  assert.deepEqual(result.profiles.map((entry) => [entry.profile, entry.builtin, entry.agents]), [
    ['default', true, ['claude', 'codex', 'opencode']],
    ['trabajo', false, ['claude', 'codex']],
  ])
  for (const entry of result.profiles) assert.deepEqual(entry.steps.filter((step) => step.state === 'failed'), [], entry.profile)
  assert.equal(result.marketplace, marketplaceDir(ctx))
  assert.equal(claude.calls.filter((call) => call === `plugin marketplace add ${result.marketplace}`).length, 2)

  for (const dir of [path.join(home, '.claude'), profile.claude ?? '']) assert.match(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8'), /máximo 3 agentes/, dir)
  for (const dir of [path.join(home, '.codex'), profile.codex ?? '']) {
    assert.match(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /máximo 3 agentes/, dir)
    assert.ok(existsSync(path.join(dir, 'agents', 'developer.toml')), dir)
  }
  assert.ok(existsSync(path.join(home, '.config', 'opencode', 'agents', 'developer.md')))
  assert.ok(!existsSync('/inherited/claude'))
})

test('refresh --profile limits the pass to that profile and rejects an unknown one', async (t) => {
  const { ctx } = await sandbox(t)
  await addProfile('trabajo', ctx)
  const claude = recorder()
  const result = await refreshProfiles(['codex'], { ctx, locate: claude.locate, exec: claude.exec, profile: 'trabajo' })
  assert.deepEqual(result.profiles.map((entry) => entry.profile), ['trabajo'])
  await assert.rejects(refreshProfiles(['codex'], { ctx, profile: 'nadie' }), { code: 'PROFILE_NOT_FOUND' })
})

test('nursery setup --refresh --json runs claude once per profile with that profile env', { skip: process.platform === 'win32' }, async (t) => {
  const { home, env, ctx } = await sandbox(t)
  const log = path.join(home, 'claude.log')
  const bin = path.join(home, 'bin')
  const script = path.join(bin, 'claude')
  await mkdir(bin, { recursive: true })
  await writeFile(
    script,
    `#!/bin/sh\necho "\${CLAUDE_CONFIG_DIR:-builtin}|\${DEN_PROFILE}|$*" >> "${log}"\ncase "$*" in *--json) echo '[]' ;; esac\nexit 0\n`,
  )
  await chmod(script, 0o755)
  const { profile } = await addProfile('trabajo', ctx)
  const run = spawnSync(process.execPath, [BIN, 'setup', '--refresh', '--agents', 'claude', '--json'], { encoding: 'utf8', env: { ...env, PATH: bin, KIT_HARNESS_BIN_CLAUDE: script } })
  assert.equal(run.status, 0, run.stderr + run.stdout)
  const envelope = JSON.parse(run.stdout.trim()) as { ok: boolean; command: string; data: { refresh: boolean; marketplace: string; profiles: { profile: string; steps: { state: string }[] }[] } }
  assert.equal(envelope.ok, true)
  assert.equal(envelope.command, 'setup')
  assert.equal(envelope.data.refresh, true)
  assert.deepEqual(envelope.data.profiles.map((entry) => entry.profile), ['default', 'trabajo'])
  const lines = (await readFile(log, 'utf8')).trim().split('\n')
  const adds = lines.filter((line) => line.endsWith(`plugin marketplace add ${envelope.data.marketplace}`))
  assert.deepEqual(adds.map((line) => line.split('|').slice(0, 2).join('|')), ['builtin|default', `${profile.claude}|trabajo`])
})

test('a corrupt settings file makes setup --refresh fail with SETTINGS_INVALID', async (t) => {
  const { home, env } = await sandbox(t)
  await mkdir(path.join(home, 'kit'), { recursive: true })
  await writeFile(path.join(home, 'kit', 'settings.json'), '{ nope')
  const run = spawnSync(process.execPath, [BIN, 'setup', '--refresh', '--agents', 'codex', '--json'], { encoding: 'utf8', env })
  assert.equal(run.status, 2)
  const envelope = JSON.parse(run.stdout.trim()) as { ok: boolean; error: { code: string } }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'SETTINGS_INVALID')
})
