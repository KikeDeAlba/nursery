import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { checkMemory, findLegacy, installAgents, removeLegacy, uninstallAgents, LEGACY_HEADING } from '../src/setup.ts'

const LEGACY = `# Personal

Keep me.

${LEGACY_HEADING}

## Git
- old rule

# Other

Keep me too.
`

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = platformContext({
    home,
    env: { PATH: '', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), KIT_REGISTRY_DIR: path.join(home, 'registry') },
  })
  const homes = agents.agentHomes(ctx)
  return { home, homes, options: { ctx, locate: async () => null } }
}

test('legacy rules are found outside kit blocks and removed with their section only', () => {
  const range = findLegacy(LEGACY)
  assert.ok(range)
  assert.equal(removeLegacy(LEGACY), '# Personal\n\nKeep me.\n\n# Other\n\nKeep me too.\n')
  const managed = `<!-- kit:nursery:begin -->\n${LEGACY_HEADING}\n<!-- kit:nursery:end -->\n`
  assert.equal(findLegacy(managed), null)
})

test('a clean install writes rules and subagents for every agent, and a second run changes nothing', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents('all', options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.ok(steps.some((step) => step.agent === 'claude' && step.item === 'plugin nursery@nursery' && step.state === 'unavailable'))

  const claude = await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8')
  assert.match(claude, /<!-- kit:nursery:begin -->\n# Reglas generales/)
  assert.match(claude, /EnterWorktree/)
  assert.ok(!existsSync(path.join(homes.claude, 'agents')))

  for (const file of [path.join(homes.opencode, 'AGENTS.md'), path.join(homes.codex, 'AGENTS.md'), path.join(homes.gemini, 'GEMINI.md')]) {
    const text = await readFile(file, 'utf8')
    assert.match(text, /Cero rastro de IA/)
    assert.doesNotMatch(text, /EnterWorktree/)
  }
  assert.match(await readFile(path.join(homes.opencode, 'agents', 'developer.md'), 'utf8'), /mode: subagent/)
  assert.match(await readFile(path.join(homes.codex, 'agents', 'security.toml'), 'utf8'), /model_reasoning_effort = "high"/)
  assert.match(await readFile(path.join(homes.gemini, 'extensions', 'nursery', 'agents', 'code-reviewer.md'), 'utf8'), /kind: local/)
  assert.ok(existsSync(path.join(homes.codex, 'prompts', 'nursery.md')))

  assert.ok((await checkMemory('all', options)).every((report) => report.state === 'current'))
  const again = await installAgents(['claude', 'opencode', 'codex'], options)
  assert.deepEqual(again.filter((step) => step.item === 'memory').map((step) => step.state), ['present', 'present', 'present'])

  await uninstallAgents(options)
  assert.equal(await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8'), '')
  assert.ok(!existsSync(path.join(homes.opencode, 'agents', 'developer.md')))
})

test('unmarked rules block the memory block until --replace-legacy', async (t) => {
  const { homes, options } = await sandbox(t)
  await mkdir(homes.claude, { recursive: true })
  const file = path.join(homes.claude, 'CLAUDE.md')
  await writeFile(file, LEGACY)

  const steps = await installAgents(['claude'], options)
  assert.ok(steps.some((step) => step.item === 'legacy rules' && step.state === 'skipped'))
  assert.equal(await readFile(file, 'utf8'), LEGACY)
  assert.deepEqual((await checkMemory(['claude'], options)).map((report) => report.state), ['legacy'])

  const replaced = await installAgents(['claude'], { ...options, replaceLegacy: true })
  assert.ok(replaced.some((step) => step.item === 'legacy rules' && step.state === 'removed'))
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# Personal\n\nKeep me\.\n\n# Other\n\nKeep me too\.\n\n<!-- kit:nursery:begin -->/)
  assert.equal(text.match(/# Reglas generales/g)?.length, 1)
  assert.equal(await readFile(`${file}.legacy-backup`, 'utf8'), LEGACY)
  assert.deepEqual((await checkMemory(['claude'], options)).map((report) => report.state), ['current'])
})
