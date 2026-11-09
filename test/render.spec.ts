import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { setSetting, userAgentsDir } from '@kikedealba/kit/settings'
import { AGENTS_DIR } from '../src/build.ts'
import { applyOverrides, marketplaceDir, planNursery, renderNursery } from '../src/render.ts'
import { installAgents, uninstallAgents } from '../src/setup.ts'
import { READ_ONLY_ROLES } from '../src/templates.ts'
import { validateUserAgent } from '../src/user-agents.ts'
import { VERSION } from '../src/version.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'nursery.ts')

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-render-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = platformContext({
    home,
    env: {
      PATH: '',
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      KIT_CONFIG_DIR: path.join(home, 'kit'),
      KIT_REGISTRY_DIR: path.join(home, 'registry'),
    },
  })
  return { home, ctx, homes: agents.agentHomes(ctx), options: { ctx, locate: async () => null } }
}

const SQL_AGENT = `---
name: revisor-sql
description: Revisa migraciones SQL antes de mezclar. Úsalo con «revisa esta migración».
tools: Read, Grep, Glob, Bash
model: sonnet
effort: medium
maxTurns: 20
source: den
createdAt: 2026-11-08T17:00:00.000Z
---
Eres el revisor de SQL.

@include handoff
`

async function writeUserAgent(ctx: ReturnType<typeof platformContext>, name: string, text: string): Promise<string> {
  const file = path.join(userAgentsDir(ctx), `${name}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return file
}

test('the default render matches the committed claude agents and builds a local marketplace', async (t) => {
  const { ctx } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  assert.equal(rendered.marketplace, path.join(ctx.home, '.local', 'share', 'kikedealba', 'nursery', 'marketplace'))
  assert.equal(rendered.marketplace, marketplaceDir(ctx))
  assert.equal(rendered.agents.length, 10)
  assert.deepEqual(rendered.unsupported, [])
  for (const name of rendered.agents) {
    assert.equal(await readFile(path.join(rendered.marketplace, 'agents', `${name}.md`), 'utf8'), await readFile(path.join(AGENTS_DIR, `${name}.md`), 'utf8'), name)
  }
  const catalog = JSON.parse(await readFile(path.join(rendered.marketplace, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; plugins: { name: string; source: string; version: string }[] }
  assert.equal(catalog.name, 'nursery')
  assert.deepEqual(catalog.plugins.map((plugin) => [plugin.name, plugin.source, plugin.version]), [['nursery', './', rendered.version]])
  assert.match(rendered.version, new RegExp(`^${VERSION.replace(/\./g, '\\.')}\\+[0-9a-f]{12}$`))
  const plugin = JSON.parse(await readFile(path.join(rendered.marketplace, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; version: string; types: string }
  assert.equal(plugin.version, rendered.version)
  assert.ok(existsSync(path.join(rendered.marketplace, plugin.types)))
  assert.ok(existsSync(path.join(rendered.marketplace, 'hooks', 'register.tsx')))
  assert.ok(!existsSync(path.join(rendered.marketplace, 'hooks', 'register.test.ts')))
  assert.match(await readFile(path.join(rendered.marketplace, 'skills', 'nursery', 'SKILL.md'), 'utf8'), /hasta 10 agentes/)
  assert.equal((await renderNursery(ctx)).version, rendered.version)
})

test('settings change the rendered agents, rules and plugin version', async (t) => {
  const { ctx } = await sandbox(t)
  const before = await renderNursery(ctx)
  await setSetting('agents.maxParallel', 4, ctx)
  await setSetting('agents.enabled', 'researcher,developer', ctx)
  await setSetting('agents.developer.model', 'opus', ctx)
  await setSetting('agents.developer.maxTurns', 12, ctx)
  await setSetting('agents.researcher.effort', 'high', ctx)
  await setSetting('rules.gitflow', false, ctx)
  await setSetting('rules.baseBranch', 'main', ctx)
  const rendered = await renderNursery(ctx)
  assert.notEqual(rendered.version, before.version)
  assert.deepEqual(rendered.agents, ['developer', 'researcher'])
  assert.deepEqual((await readdir(path.join(rendered.marketplace, 'agents'))).sort(), ['developer.md', 'researcher.md'])
  const developer = agents.parseFrontmatter(await readFile(path.join(rendered.marketplace, 'agents', 'developer.md'), 'utf8')).attributes
  assert.equal(developer['model'], 'opus')
  assert.equal(developer['maxTurns'], '12')
  const researcher = await readFile(path.join(rendered.subagentsDir, 'researcher.md'), 'utf8')
  assert.equal(agents.parseFrontmatter(agents.renderForAgent(researcher, 'claude')).attributes['effort'], 'high')
  assert.match(agents.subagentForCodex(researcher, 'researcher'), /model_reasoning_effort = "high"/)
  assert.match(agents.subagentForGemini(researcher, 'researcher'), /^max_turns: 60$/m)
  const rules = await readFile(rendered.rulesFile, 'utf8')
  assert.match(rules, /máximo 4 agentes/)
  assert.match(rules, /agente de nursery \(researcher, developer\)/)
  assert.doesNotMatch(rules, /## Ramas/)
  assert.match(rules, /base: `main`/)
  assert.match(await readFile(path.join(rendered.skillDir, 'SKILL.md'), 'utf8'), /hasta 4 agentes/)
  assert.match(await readFile(rendered.antigravityRulesFile, 'utf8'), /máximo 4 subagentes/)
  assert.deepEqual(rendered.stale.sort(), ['analyst', 'architect', 'code-reviewer', 'devops', 'documenter', 'qa-automation', 'security', 'sre'])
  const unsupported = rendered.unsupported.map((entry) => `${entry.agent}:${entry.harness}:${entry.field}`).sort()
  assert.deepEqual(unsupported, [
    'developer:antigravity:maxTurns',
    'developer:antigravity:model',
    'developer:codex:maxTurns',
    'developer:codex:model',
    'developer:gemini:model',
    'developer:opencode:model',
    'researcher:antigravity:effort',
    'researcher:gemini:effort',
    'researcher:opencode:effort',
  ])
})

test('applyOverrides replaces frontmatter fields, including per-tool blocks, and leaves the body alone', () => {
  const source = '---\nname: x\nmodel: sonnet\n::: agent gemini\nmaxTurns: 60\n:::\nsource: den\n---\nmodel: body stays\n'
  const result = applyOverrides(source, { model: 'opus', maxTurns: '5' }, ['source'])
  assert.equal(result, '---\nname: x\n::: agent gemini\n:::\nmodel: opus\nmaxTurns: 5\n---\nmodel: body stays\n')
  assert.equal(agents.parseFrontmatter(agents.renderForAgent(result, 'gemini')).attributes['maxTurns'], '5')
})

test('a valid user agent is rendered like a role and joins the rules', async (t) => {
  const { ctx } = await sandbox(t)
  await writeUserAgent(ctx, 'revisor-sql', SQL_AGENT)
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['revisor-sql'])
  assert.deepEqual(rendered.invalidAgents, [])
  assert.equal(rendered.agents.length, 11)
  const claude = await readFile(path.join(rendered.marketplace, 'agents', 'revisor-sql.md'), 'utf8')
  const { attributes, body } = agents.parseFrontmatter(claude)
  assert.equal(attributes['name'], 'revisor-sql')
  assert.equal(attributes['maxTurns'], '20')
  assert.equal(attributes['source'], undefined)
  assert.equal(attributes['createdAt'], undefined)
  assert.match(body, /## Entrega/)
  assert.match(await readFile(rendered.rulesFile, 'utf8'), /documenter, revisor-sql\)/)
  assert.deepEqual(rendered.unsupported.filter((entry) => entry.harness === 'codex').map((entry) => entry.field).sort(), ['maxTurns', 'model'])

  await setSetting('agents.revisor-sql.model', 'haiku', ctx)
  const overridden = await renderNursery(ctx)
  assert.equal(agents.parseFrontmatter(await readFile(path.join(overridden.marketplace, 'agents', 'revisor-sql.md'), 'utf8')).attributes['model'], 'haiku')
})

test('invalid user agents are reported with every failure and never installed', async (t) => {
  const { ctx } = await sandbox(t)
  const cases: Record<string, string> = {
    'otro-nombre': SQL_AGENT,
    'mal-tools': SQL_AGENT.replace('revisor-sql', 'mal-tools').replace('tools: Read, Grep, Glob, Bash', 'tools: Read, Task'),
    'sin-cuerpo': '---\nname: sin-cuerpo\ndescription: algo\n---\n\n',
    developer: SQL_AGENT.replace('name: revisor-sql', 'name: developer'),
    'muy-largo': SQL_AGENT.replace('revisor-sql', 'muy-largo').replace(/description: .*/, `description: ${'x'.repeat(301)}`),
    'mal-include': SQL_AGENT.replace('revisor-sql', 'mal-include').replace('@include handoff', '@include nope'),
  }
  for (const [name, text] of Object.entries(cases)) await writeUserAgent(ctx, name, text)
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, [])
  assert.equal(rendered.agents.length, 10)
  const errors = Object.fromEntries(rendered.invalidAgents.map((agent) => [agent.name, agent.errors.join(' | ')]))
  assert.deepEqual(Object.keys(errors).sort(), Object.keys(cases).sort())
  assert.match(errors['otro-nombre'] ?? '', /must match the file name/)
  assert.match(errors['mal-tools'] ?? '', /unknown tools: Task/)
  assert.match(errors['sin-cuerpo'] ?? '', /body is empty/)
  assert.match(errors['developer'] ?? '', /is a nursery role/)
  assert.match(errors['muy-largo'] ?? '', /301 characters/)
  assert.match(errors['mal-include'] ?? '', /unknown include: nope/)
  assert.ok(!existsSync(path.join(rendered.marketplace, 'agents', 'otro-nombre.md')))
})

test('validateUserAgent checks name, description, tools, model, effort, maxTurns and body', () => {
  assert.deepEqual(validateUserAgent('revisor-sql.md', SQL_AGENT, new Map([['handoff', '## Entrega']])), { ok: true, errors: [] })
  assert.deepEqual(validateUserAgent('x.md', 'no frontmatter'), { ok: false, errors: ['missing frontmatter'] })
  const bad = validateUserAgent('Bad.md', '---\nname: Bad\nmodel: GPT 5\neffort: extreme\nmaxTurns: 900\n---\nbody\n')
  assert.equal(bad.ok, false)
  const joined = bad.errors.join(' | ')
  for (const pattern of [/name must match/, /description is required/, /model must match/, /effort must be one of/, /maxTurns must be an integer from 1 to 500/]) assert.match(joined, pattern)
})

test('disabling a role or deleting a user agent removes it from opencode and codex on the next setup', async (t) => {
  const { ctx, homes, options } = await sandbox(t)
  const file = await writeUserAgent(ctx, 'revisor-sql', SQL_AGENT)
  const first = await installAgents(['opencode', 'codex'], options)
  assert.deepEqual(first.filter((step) => step.state === 'failed'), [])
  assert.ok(existsSync(path.join(homes.opencode, 'agents', 'revisor-sql.md')))
  assert.ok(existsSync(path.join(homes.codex, 'agents', 'revisor-sql.toml')))
  assert.ok(first.some((step) => step.agent === 'codex' && step.item === 'subagent revisor-sql' && step.state === 'skipped' && /model: sonnet has no equivalent in codex/.test(step.detail)))
  assert.ok(!first.some((step) => step.agent === 'claude'))
  assert.match(await readFile(path.join(homes.codex, 'AGENTS.md'), 'utf8'), /revisor-sql/)

  await setSetting('agents.enabled', 'researcher,developer,revisor-sql', ctx)
  const second = await installAgents(['opencode', 'codex'], options)
  assert.ok(second.some((step) => step.agent === 'opencode' && step.item === 'subagent sre' && step.state === 'removed'))
  assert.ok(!existsSync(path.join(homes.opencode, 'agents', 'sre.md')))
  assert.ok(!existsSync(path.join(homes.codex, 'agents', 'security.toml')))
  assert.ok(existsSync(path.join(homes.codex, 'agents', 'developer.toml')))

  await rm(file)
  await installAgents(['opencode', 'codex'], options)
  assert.ok(!existsSync(path.join(homes.opencode, 'agents', 'revisor-sql.md')))
  assert.ok(!existsSync(path.join(homes.codex, 'agents', 'revisor-sql.toml')))
  assert.ok(existsSync(path.join(homes.codex, 'agents', 'researcher.toml')))
})

function fakeClaude(marketplaces: unknown[]) {
  const calls: string[] = []
  const plugins: unknown[] = []
  return {
    calls,
    locate: async (command: string) => (command === 'claude' ? '/bin/claude' : null),
    exec: async (command: string, args: readonly string[]) => {
      assert.equal(command, '/bin/claude')
      const line = args.join(' ')
      calls.push(line)
      if (line === 'plugin marketplace list --json') return JSON.stringify(marketplaces)
      if (line === 'plugin list --json') return JSON.stringify(plugins)
      if (args[1] === 'marketplace' && args[2] === 'add') marketplaces.push({ name: 'nursery', source: 'directory', path: args[3] })
      if (args[1] === 'marketplace' && args[2] === 'remove') marketplaces.splice(0, marketplaces.length)
      if (args[1] === 'install') plugins.push({ id: args[2], scope: 'user' })
      return ''
    },
  }
}

test('claude swaps the github marketplace for the local one and installs nursery@nursery from it', async (t) => {
  const { ctx, options } = await sandbox(t)
  const claude = fakeClaude([{ name: 'nursery', source: 'github', repo: 'KikeDeAlba/nursery' }])
  const steps = await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  const marketplace = marketplaceDir(ctx)
  assert.deepEqual(claude.calls.filter((call) => !call.endsWith('--json')), [
    'plugin marketplace remove nursery',
    `plugin marketplace add ${marketplace}`,
    'plugin marketplace update nursery',
    'plugin install nursery@nursery --scope user',
  ])
  assert.ok(steps.some((step) => step.item === 'marketplace nursery' && step.state === 'removed' && step.detail.includes('KikeDeAlba/nursery')))

  claude.calls.length = 0
  await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  assert.deepEqual(claude.calls.filter((call) => !call.endsWith('--json')), ['plugin marketplace update nursery', 'plugin update nursery@nursery --scope user'])
})

test('the default read-only roles are the ones whose tools cannot write', async (t) => {
  const { ctx } = await sandbox(t)
  const plan = await planNursery(ctx)
  assert.deepEqual(plan.config.readOnly, READ_ONLY_ROLES)
})

test('the gemini plan policy allows enabled read-only user agents and drops disabled roles', async (t) => {
  const { ctx, homes, options } = await sandbox(t)
  await writeUserAgent(ctx, 'revisor-sql', SQL_AGENT)
  await writeUserAgent(ctx, 'editor-sql', SQL_AGENT.replace('revisor-sql', 'editor-sql').replace('tools: Read, Grep, Glob, Bash', 'tools: Read, Edit, Write'))
  await setSetting('agents.enabled', 'researcher,developer,revisor-sql,editor-sql', ctx)
  const steps = await installAgents(['gemini'], options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  const file = path.join(homes.gemini, 'policies', 'nursery.toml')
  const policy = await readFile(file, 'utf8')
  assert.match(policy, /\(researcher\|revisor-sql\)/)
  const pattern = new RegExp(/^argsPattern = '''(.*)'''$/m.exec(policy)?.[1] ?? '')
  assert.match('\0"agent_name":"revisor-sql"\0', pattern)
  for (const name of ['editor-sql', 'analyst', 'developer']) assert.doesNotMatch(`\0"agent_name":"${name}"\0`, pattern, name)
  assert.match(await readFile(path.join(homes.gemini, 'GEMINI.md'), 'utf8'), /revisor-sql/)
  await uninstallAgents(options)
  assert.ok(!existsSync(file))
})

test('nursery list --json shows user agents, disabled roles, overrides and invalid agents', async (t) => {
  const { ctx } = await sandbox(t)
  await writeUserAgent(ctx, 'revisor-sql', SQL_AGENT)
  await writeUserAgent(ctx, 'roto', '---\nname: roto\n---\n')
  await setSetting('agents.enabled', 'researcher,developer,revisor-sql', ctx)
  await setSetting('agents.developer.model', 'opus', ctx)
  const run = spawnSync(process.execPath, [BIN, 'list', '--json'], { encoding: 'utf8', env: { ...process.env, ...ctx.env, PATH: process.env['PATH'] } })
  assert.equal(run.status, 0, run.stderr)
  const { data } = JSON.parse(run.stdout) as { data: { agents: { name: string; source: string; enabled: boolean; model: string; readOnly: boolean; file?: string }[]; invalidAgents: { name: string }[] } }
  const byName = new Map(data.agents.map((agent) => [agent.name, agent]))
  assert.equal(data.agents.length, 11)
  assert.deepEqual(byName.get('revisor-sql') && [byName.get('revisor-sql')?.source, byName.get('revisor-sql')?.enabled, byName.get('revisor-sql')?.readOnly], ['user', true, true])
  assert.equal(byName.get('revisor-sql')?.file, path.join(userAgentsDir(ctx), 'revisor-sql.md'))
  assert.equal(byName.get('developer')?.model, 'opus')
  assert.equal(byName.get('sre')?.enabled, false)
  assert.equal(byName.get('sre')?.source, 'nursery')
  assert.deepEqual(data.invalidAgents.map((agent) => agent.name), ['roto'])
})
