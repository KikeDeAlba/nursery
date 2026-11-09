import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { NURSERY_ROLES, RULE_FLAGS, SettingsError, setSetting, settingsPath, userAgentsDir } from '@kikedealba/kit/settings'
import { planNursery, renderNursery } from '../src/render.ts'
import { validateUserAgent } from '../src/user-agents.ts'
import { TEMPLATE_SOURCES } from '../src/build.ts'
import { DEFAULT_TEMPLATE_CONFIG, renderTemplate } from '../src/templates.ts'

type Cleanup = { after: (fn: () => Promise<void>) => void }

async function sandbox(t: Cleanup) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-matrix-'))
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
    },
  })
  return { home, ctx }
}

function agentText(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: Reviews things for the tests. Use it with «review this».\n${extra}---\nYou review things.\n`
}

async function writeAgent(ctx: ReturnType<typeof platformContext>, file: string, text: string): Promise<string> {
  const full = path.join(userAgentsDir(ctx), file)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, text)
  return full
}

async function outputs(rendered: Awaited<ReturnType<typeof renderNursery>>): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    rules: await readFile(rendered.rulesFile, 'utf8'),
    antigravity: await readFile(rendered.antigravityRulesFile, 'utf8'),
    policy: await readFile(rendered.policyFile, 'utf8'),
    skill: await readFile(path.join(rendered.skillDir, 'SKILL.md'), 'utf8'),
  }
  return files
}

function assertClean(files: Record<string, string>, label: string): void {
  for (const [name, text] of Object.entries(files)) {
    if (name === 'policy') continue
    assert.doesNotMatch(text, /\{\{|\}\}/, `${label}/${name}: unresolved placeholder`)
    assert.doesNotMatch(text, /^:::\s*(rule|role)\b/m, `${label}/${name}: leftover block marker`)
    assert.doesNotMatch(text, /undefined|NaN|\[object/, `${label}/${name}: leaked a bad value`)
    assert.doesNotMatch(text, /\n{3,}/, `${label}/${name}: more than one blank line in a row`)
  }
}

for (const value of [1, 20]) {
  test(`agents.maxParallel=${value} reaches the rules, the skill and the antigravity rules`, async (t) => {
    const { ctx } = await sandbox(t)
    await setSetting('agents.maxParallel', value, ctx)
    const files = await outputs(await renderNursery(ctx))
    assert.match(files['rules'] ?? '', new RegExp(`máximo ${value} agentes`))
    assert.match(files['skill'] ?? '', new RegExp(`hasta ${value} agentes`))
    assert.match(files['antigravity'] ?? '', new RegExp(`máximo ${value} subagentes`))
    assertClean(files, `maxParallel=${value}`)
  })
}

test('maxParallel outside 1-20 and non-integers are rejected and leave the file untouched', async (t) => {
  const { ctx } = await sandbox(t)
  await setSetting('agents.maxParallel', 5, ctx)
  const before = await readFile(settingsPath(ctx), 'utf8')
  for (const bad of [0, 21, -1, 1.5, 'abc', '1e1', '', '0x10', 'NaN', '99999999999999999999']) {
    await assert.rejects(setSetting('agents.maxParallel', bad as never, ctx), { code: 'INVALID_VALUE' }, String(bad))
  }
  assert.equal(await readFile(settingsPath(ctx), 'utf8'), before)
})

test('invalid efforts, models and maxTurns are rejected for roles and for user agents', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'reviewer.md', agentText('reviewer'))
  for (const role of ['developer', 'reviewer']) {
    for (const bad of ['extreme', 'HIGH', '', ' high', 'high\n']) await assert.rejects(setSetting(`agents.${role}.effort`, bad, ctx), { code: 'INVALID_VALUE' }, `${role} effort ${JSON.stringify(bad)}`)
    for (const bad of ['GPT 5', 'Opus', 'a\nb', 'opus\n', '', 'a;b', '$(id)', '../x']) await assert.rejects(setSetting(`agents.${role}.model`, bad, ctx), { code: 'INVALID_VALUE' }, `${role} model ${JSON.stringify(bad)}`)
    for (const good of ['a/b', 'openai/gpt-5.6-luna']) assert.equal((await setSetting(`agents.${role}.model`, good, ctx)).value, good, `${role} model ${good}`)
    for (const bad of ['0', '501', '-1', 'abc', '5.5', '1e2']) await assert.rejects(setSetting(`agents.${role}.maxTurns`, bad, ctx), { code: 'INVALID_VALUE' }, `${role} maxTurns ${bad}`)
  }
  await assert.rejects(setSetting('agents.ghost.model', 'opus', ctx), { code: 'UNKNOWN_KEY' })
  await assert.rejects(setSetting('agents.enabled', 'developer,ghost', ctx), { code: 'INVALID_VALUE' })
  await assert.rejects(setSetting('agents.enabled', '', ctx), { code: 'INVALID_VALUE' })
  await assert.rejects(setSetting('agents.enabled', '[]', ctx), { code: 'INVALID_VALUE' })
  await assert.rejects(setSetting('agents.enabled.model', 'opus', ctx), { code: 'UNKNOWN_KEY' })
})

test('effort, model and maxTurns boundaries are accepted and land in the claude agent', async (t) => {
  const { ctx } = await sandbox(t)
  await setSetting('agents.developer.maxTurns', 1, ctx)
  await setSetting('agents.researcher.maxTurns', 500, ctx)
  await setSetting('agents.developer.model', 'claude-opus-4.5[1m]', ctx)
  await setSetting('agents.researcher.effort', 'max', ctx)
  const rendered = await renderNursery(ctx)
  const developer = agents.parseFrontmatter(await readFile(path.join(rendered.marketplace, 'agents', 'developer.md'), 'utf8')).attributes
  const researcher = agents.parseFrontmatter(await readFile(path.join(rendered.marketplace, 'agents', 'researcher.md'), 'utf8')).attributes
  assert.equal(developer['maxTurns'], '1')
  assert.equal(developer['model'], 'claude-opus-4.5[1m]')
  assert.equal(researcher['maxTurns'], '500')
  assert.equal(researcher['effort'], 'max')
})

test('every combination of rule flags renders clean text in all four outputs', async (t) => {
  const { ctx } = await sandbox(t)
  for (let mask = 0; mask < 1 << RULE_FLAGS.length; mask += 1) {
    for (const [index, flag] of RULE_FLAGS.entries()) await setSetting(`rules.${flag}`, (mask & (1 << index)) !== 0, ctx)
    const files = await outputs(await renderNursery(ctx))
    assertClean(files, `mask=${mask}`)
    assert.match(files['rules'] ?? '', /## Verificación/, `mask=${mask}`)
    assert.match(files['rules'] ?? '', /## Contexto del proyecto/, `mask=${mask}`)
  }
})

for (const role of NURSERY_ROLES) {
  test(`with only ${role} enabled the outputs are clean and the other nine are stale`, async (t) => {
    const { ctx } = await sandbox(t)
    await setSetting('agents.enabled', role, ctx)
    const rendered = await renderNursery(ctx)
    assert.deepEqual(rendered.agents, [role])
    assert.deepEqual((await readdir(path.join(rendered.marketplace, 'agents'))).sort(), [`${role}.md`])
    assert.deepEqual(rendered.stale.sort(), NURSERY_ROLES.filter((name) => name !== role).sort())
    assertClean(await outputs(rendered), role)
  })
}

test('with every role switched off by hand the render still succeeds, ships no agents and keeps the mandatory sections', async (t) => {
  const { ctx } = await sandbox(t)
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  await writeFile(settingsPath(ctx), JSON.stringify({ version: 1, agents: { enabled: ['ghost'] } }))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.agents, [])
  assert.deepEqual(await readdir(path.join(rendered.marketplace, 'agents')).catch(() => []), [])
  assert.deepEqual(rendered.stale.sort(), [...NURSERY_ROLES].sort())
  const files = await outputs(rendered)
  assertClean(files, 'none')
  assert.match(files['rules'] ?? '', /## Verificación/)
  const plugin = JSON.parse(await readFile(path.join(rendered.marketplace, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
  assert.equal(plugin.version, rendered.version)
})

test('hand-edited invalid values are ignored in favour of the defaults instead of breaking the render', async (t) => {
  const { ctx } = await sandbox(t)
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  await writeFile(
    settingsPath(ctx),
    JSON.stringify({ version: 1, agents: { maxParallel: 99, developer: { effort: 'zzz', model: 'GPT 5', maxTurns: 9000 } }, rules: { gitflow: 'no', baseBranch: 'a b' } }),
  )
  const plan = await planNursery(ctx)
  assert.equal(plan.config.maxParallel, 10)
  assert.equal(plan.config.baseBranch, 'develop')
  assert.equal(plan.config.rules.gitflow, true)
  const developer = plan.agents.find((agent) => agent.name === 'developer')
  assert.notEqual(developer?.effort, 'zzz')
  assert.notEqual(developer?.model, 'GPT 5')
  assert.notEqual(developer?.maxTurns, 9000)
})

test('a settings file with the wrong shape fails a strict render with SETTINGS_INVALID, a plain render warns, and setSetting refuses to overwrite it', async (t) => {
  const { ctx } = await sandbox(t)
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  for (const text of ['[]', '{"version":2}', '{ nope', '"x"', 'null', '{"agents":{"maxParallel":3}}']) {
    await writeFile(settingsPath(ctx), text)
    await assert.rejects(renderNursery(ctx, { strict: true }), (error: unknown) => error instanceof SettingsError && error.code === 'SETTINGS_INVALID', text)
    const plain = await renderNursery(ctx)
    assert.equal(plain.agents.length, 10, text)
    assert.match(plain.warnings.join('\n'), /using the default settings/, text)
    await assert.rejects(setSetting('agents.maxParallel', 4, ctx), { code: 'SETTINGS_INVALID' }, text)
    assert.equal(await readFile(settingsPath(ctx), 'utf8'), text)
  }
})

test('a base branch with markdown, replacement patterns or placeholders is refused by kit and rendered literally by the template', async (t) => {
  const { ctx } = await sandbox(t)
  const branch = 'feat$&x$1{{agents.maxParallel}}'
  await assert.rejects(setSetting('rules.baseBranch', branch, ctx), { code: 'INVALID_VALUE' })
  const rules = renderTemplate(await readFile(TEMPLATE_SOURCES.rules, 'utf8'), { ...DEFAULT_TEMPLATE_CONFIG, baseBranch: branch, maxParallel: 3 })
  assert.ok(rules.includes(`\`${branch}\``))
  assert.match(rules, /máximo 3 agentes/)
})

test('user agents: CRLF, BOM, duplicate names and block scalars are rejected or normalised without crashing the render', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'crlf.md', agentText('crlf').replace(/\n/g, '\r\n'))
  await writeAgent(ctx, 'bom.md', `﻿${agentText('bom')}`)
  await writeAgent(ctx, 'upper.md', agentText('Upper'))
  await writeAgent(ctx, 'a.md', agentText('a'))
  await writeAgent(ctx, 'dotted.md', agentText('dot.ted'))
  await writeAgent(ctx, 'developer.md', agentText('developer'))
  await writeAgent(ctx, 'notes.txt', 'not markdown')
  await writeAgent(ctx, 'nested/inner.md', agentText('inner'))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['crlf'])
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name).sort(), ['a', 'bom', 'developer', 'dotted', 'upper'])
  assert.deepEqual(rendered.agents.length, 11)
  assert.doesNotMatch(await readFile(path.join(rendered.marketplace, 'agents', 'crlf.md'), 'utf8'), /\r/)
})

test('user agent names that collide with every nursery role are rejected, in the file name and in the frontmatter', async (t) => {
  const { ctx } = await sandbox(t)
  for (const role of NURSERY_ROLES) {
    assert.match(validateUserAgent(`${role}.md`, agentText(role)).errors.join('|'), /is a nursery role/, role)
    await writeAgent(ctx, `${role}.md`, agentText(role))
  }
  const rendered = await renderNursery(ctx)
  assert.equal(rendered.invalidAgents.length, NURSERY_ROLES.length)
  assert.deepEqual(rendered.userAgents, [])
  for (const role of NURSERY_ROLES) {
    const builtin = await readFile(path.join(rendered.marketplace, 'agents', `${role}.md`), 'utf8')
    assert.doesNotMatch(builtin, /You review things/, `${role} was overwritten by a user agent`)
  }
})

test('a user agent cannot claim another name through the frontmatter or a different file name', () => {
  assert.match(validateUserAgent('mine.md', agentText('developer')).errors.join('|'), /must match the file name "mine"/)
  assert.match(validateUserAgent('developer.md', agentText('mine')).errors.join('|'), /must match the file name "developer"/)
  assert.match(validateUserAgent('Developer.md', agentText('Developer')).errors.join('|'), /name must match/)
  assert.match(validateUserAgent('../developer.md', agentText('../developer')).errors.join('|'), /name must match/)
  assert.match(validateUserAgent('a/b.md', agentText('a/b')).errors.join('|'), /name must match/)
})

test('user agent frontmatter values that try to smuggle extra fields or lines do not reach the rendered file', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'literal-escape.md', `---\nname: literal-escape\ndescription: ok\\ntools: Edit, Write\ntools: Read\n---\nbody\n`)
  await writeAgent(ctx, 'model-escape.md', `---\nname: model-escape\ndescription: ok\nmodel: sonnet\\nmaxTurns: 9\n---\nbody\n`)
  await writeAgent(ctx, 'model-newline.md', `---\nname: model-newline\ndescription: ok\nmodel: "sonnet\\nmaxTurns: 9"\n---\nbody\n`)
  await writeAgent(ctx, 'tools-star.md', `---\nname: tools-star\ndescription: ok\ntools: Read, *\n---\nbody\n`)
  await writeAgent(ctx, 'tools-case.md', `---\nname: tools-case\ndescription: ok\ntools: read\n---\nbody\n`)
  await writeAgent(ctx, 'tools-task.md', `---\nname: tools-task\ndescription: ok\ntools: Read, Task, mcp__x__y\n---\nbody\n`)
  await writeAgent(ctx, 'effort-bad.md', `---\nname: effort-bad\ndescription: ok\neffort: HIGH\n---\nbody\n`)
  await writeAgent(ctx, 'turns-bad.md', `---\nname: turns-bad\ndescription: ok\nmaxTurns: 0x10\n---\nbody\n`)
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['literal-escape'])
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name).sort(), ['effort-bad', 'model-escape', 'model-newline', 'tools-case', 'tools-star', 'tools-task', 'turns-bad'])
  const claude = agents.parseFrontmatter(await readFile(path.join(rendered.marketplace, 'agents', 'literal-escape.md'), 'utf8')).attributes
  assert.equal(claude['tools'], 'Read')
  assert.equal(claude['maxTurns'], undefined)
  assert.equal(claude['description']?.includes('\n'), false)
})

test('a user agent body with a path-like include and frontmatter lookalikes is rendered as plain text', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'bad-include.md', agentText('bad-include').replace('You review things.', '@include ../../etc/passwd'))
  await writeAgent(ctx, 'tricky-body.md', agentText('tricky-body').replace('You review things.', 'text\n---\nmodel: evil\ntools: Edit, Write\n---\n{{agents.maxParallel}}\n'))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name), [])
  assert.deepEqual(rendered.userAgents, ['bad-include', 'tricky-body'])
  const traversal = await readFile(path.join(rendered.marketplace, 'agents', 'bad-include.md'), 'utf8')
  assert.match(traversal, /^@include \.\.\/\.\.\/etc\/passwd$/m)
  assert.doesNotMatch(traversal, /root:/)
  const claude = agents.parseFrontmatter(await readFile(path.join(rendered.marketplace, 'agents', 'tricky-body.md'), 'utf8')).attributes
  assert.equal(claude['model'], undefined)
  assert.equal(claude['tools'], undefined)
})

test('a user agent with no tools line inherits every tool and is not treated as read-only; a read-only one is', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'open-tools.md', agentText('open-tools'))
  await writeAgent(ctx, 'ro-tools.md', agentText('ro-tools', 'tools: Read, Grep\n'))
  await writeAgent(ctx, 'rw-tools.md', agentText('rw-tools', 'tools: Read, Write\n'))
  const plan = await planNursery(ctx)
  const flags = Object.fromEntries(plan.agents.filter((agent) => agent.source === 'user').map((agent) => [agent.name, agent.readOnly]))
  assert.deepEqual(flags, { 'open-tools': false, 'ro-tools': true, 'rw-tools': false })
  assert.ok(plan.config.readOnly.includes('ro-tools'))
  assert.ok(!plan.config.readOnly.includes('rw-tools'))
  const policy = await readFile((await renderNursery(ctx)).policyFile, 'utf8')
  assert.match(policy, /ro-tools/)
  assert.doesNotMatch(policy, /rw-tools|open-tools/)
})

test('a user agent that is enabled by name survives, and stops being listed once the file is deleted', async (t) => {
  const { ctx } = await sandbox(t)
  const file = await writeAgent(ctx, 'solo.md', agentText('solo'))
  await setSetting('agents.enabled', 'solo', ctx)
  await setSetting('agents.solo.model', 'haiku', ctx)
  assert.deepEqual((await renderNursery(ctx)).agents, ['solo'])
  await rm(file)
  const after = await renderNursery(ctx)
  assert.deepEqual(after.agents, [])
  assertClean(await outputs(after), 'deleted-solo')
})

test('a user agent symlinked to a file outside the agents directory is read as a user agent, never written to', async (t) => {
  const { home, ctx } = await sandbox(t)
  const outside = path.join(home, 'outside.md')
  await writeFile(outside, agentText('linked'))
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await symlink(outside, path.join(userAgentsDir(ctx), 'linked.md'))
  const before = await readFile(outside, 'utf8')
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['linked'])
  assert.equal(await readFile(outside, 'utf8'), before)
  assert.ok(!existsSync(path.join(path.dirname(outside), 'linked.md')))
})

test('a broken symlink named like an agent is reported as invalid instead of crashing every render', async (t) => {
  const { ctx } = await sandbox(t)
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await symlink('/nonexistent/target.md', path.join(userAgentsDir(ctx), 'broken.md'))
  await writeAgent(ctx, 'fine.md', agentText('fine'))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['fine'])
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name), ['broken'])
})

test('a directory named like an agent (x.md/) is reported as invalid instead of crashing every render', async (t) => {
  const { ctx } = await sandbox(t)
  await mkdir(path.join(userAgentsDir(ctx), 'folder.md'), { recursive: true })
  await writeAgent(ctx, 'fine.md', agentText('fine'))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['fine'])
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name), ['folder'])
})

test('a user agent called "enabled" is rejected instead of breaking every render with UNKNOWN_KEY', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'enabled.md', agentText('enabled'))
  await writeAgent(ctx, 'fine.md', agentText('fine'))
  const rendered = await renderNursery(ctx)
  assert.deepEqual(rendered.userAgents, ['fine'])
  assert.deepEqual(rendered.invalidAgents.map((agent) => agent.name), ['enabled'])
})

test('duplicate frontmatter keys are rejected because Claude Code parses the file as strict YAML', () => {
  const text = '---\nname: dup\ndescription: d\ntools: Read\ntools: Bash, Edit, Write\n---\nbody\n'
  assert.equal(validateUserAgent('dup.md', text).ok, false)
})

test('a block scalar description is rejected instead of being published as "|"', async (t) => {
  const { ctx } = await sandbox(t)
  await writeAgent(ctx, 'block.md', '---\nname: block\ndescription: |\n  multi line\n  description\n---\nbody\n')
  const plan = await planNursery(ctx)
  assert.notEqual(plan.agents.find((agent) => agent.name === 'block')?.description, '|')
})
