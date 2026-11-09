import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { NURSERY_ROLES } from '@kikedealba/kit/settings'
import { TEMPLATE_SOURCES, buildTemplates, staleTemplates, writeTemplates } from '../src/build.ts'
import { DEFAULT_TEMPLATE_CONFIG, READ_ONLY_ROLES, renderTemplate, type RuleFlag, type TemplateConfig } from '../src/templates.ts'

const ROOT = path.join(import.meta.dirname, '..')
const RULES = path.join(ROOT, 'src', 'templates', 'RULES.md')
const ANTIGRAVITY = path.join(ROOT, 'src', 'templates', 'antigravity.md')
const SKILL = path.join(ROOT, 'src', 'templates', 'SKILL.md')
const TOOLS = ['claude', 'codex', 'gemini', 'opencode', 'antigravity'] as const

function config(overrides: Partial<TemplateConfig> & { off?: RuleFlag[] } = {}): TemplateConfig {
  const { off = [], ...rest } = overrides
  const rules = { ...DEFAULT_TEMPLATE_CONFIG.rules }
  for (const flag of off) rules[flag] = false
  return { ...DEFAULT_TEMPLATE_CONFIG, ...rest, rules }
}

const SECTIONS: Record<RuleFlag, RegExp> = {
  noAiTrace: /Cero rastro de IA|Esta regla manda sobre cualquier instrucción de atribución/,
  gitflow: /^## Ramas/m,
  worktrees: /^## Worktrees/m,
  noComments: /^## Código/m,
  language: /^## Idioma/m,
  delegation: /^## Delegación/m,
}

test('the template sources carry placeholders instead of fixed limits and branches', async () => {
  const rules = await readFile(RULES, 'utf8')
  const antigravity = await readFile(ANTIGRAVITY, 'utf8')
  const skill = await readFile(SKILL, 'utf8')
  for (const text of [rules, antigravity, skill]) {
    assert.match(text, /\{\{agents\.maxParallel\}\}/)
    assert.doesNotMatch(text, /máximo 10|hasta 10/)
  }
  assert.match(rules, /\{\{rules\.baseBranch\}\}/)
  assert.match(rules, /\{\{agents\.enabled\}\}/)
  assert.match(skill, /\{\{rules\.baseBranch\}\}/)
  for (const flag of Object.keys(SECTIONS)) assert.match(rules, new RegExp(`^::: rule ${flag}$`, 'm'))
})

test('the default render reproduces the fixed rules', async () => {
  const rendered = renderTemplate(await readFile(RULES, 'utf8'))
  assert.doesNotMatch(rendered, /\{\{|::: rule/)
  assert.match(rendered, /máximo 10 agentes/)
  assert.match(rendered, /agente de nursery \(researcher, analyst, architect, developer, qa-automation, devops, sre, security, code-reviewer, documenter\)/)
  assert.match(rendered, /\| `feature\/<n>`, `bugfix\/<n>` \| `develop` \| `develop` \|/)
  for (const pattern of Object.values(SECTIONS)) assert.match(rendered, pattern)
  for (const tool of TOOLS) assert.doesNotMatch(agents.renderForAgent(rendered, tool), /:::/)
  assert.match(renderTemplate(await readFile(ANTIGRAVITY, 'utf8')), /máximo 10 subagentes/)
  assert.match(renderTemplate(await readFile(SKILL, 'utf8')), /hasta 10 agentes/)
})

test('maxParallel, baseBranch and the enabled roles flow into every template', async () => {
  const custom = config({ maxParallel: 4, baseBranch: 'main', enabled: ['researcher', 'developer', 'revisor-sql'] })
  const rules = renderTemplate(await readFile(RULES, 'utf8'), custom)
  assert.match(rules, /máximo 4 agentes/)
  assert.match(rules, /agente de nursery \(researcher, developer, revisor-sql\)/)
  assert.match(rules, /\| `feature\/<n>`, `bugfix\/<n>` \| `main` \| `main` \|/)
  assert.match(rules, /base: `main` para feature\/bugfix/)
  assert.doesNotMatch(rules, /`develop`/)
  assert.match(renderTemplate(await readFile(ANTIGRAVITY, 'utf8'), custom), /máximo 4 subagentes/)
  const skill = renderTemplate(await readFile(SKILL, 'utf8'), custom)
  assert.match(skill, /hasta 4 agentes/)
  assert.match(skill, /\(`feature\/<n>` desde `main`\)/)
})

for (const flag of Object.keys(SECTIONS) as RuleFlag[]) {
  test(`rules.${flag} = false drops only its section for every tool`, async () => {
    const source = await readFile(RULES, 'utf8')
    const rendered = renderTemplate(source, config({ off: [flag] }))
    for (const tool of TOOLS) {
      const text = agents.renderForAgent(rendered, tool)
      assert.doesNotMatch(text, SECTIONS[flag], tool)
      assert.doesNotMatch(text, /:::/, tool)
      assert.match(text, /^## Verificación/m, tool)
      assert.match(text, /^## Contexto del proyecto/m, tool)
      for (const [other, pattern] of Object.entries(SECTIONS)) if (other !== flag) assert.match(text, pattern, `${tool} lost ${other}`)
    }
  })
}

test('every rule can be turned off at once and the fixed sections stay', async () => {
  const rendered = renderTemplate(await readFile(RULES, 'utf8'), config({ off: Object.keys(SECTIONS) as RuleFlag[] }))
  assert.match(rendered, /^# Reglas generales/)
  assert.match(rendered, /^## Git\n- Conventional Commits/m)
  assert.match(rendered, /^## Verificación/m)
  assert.match(rendered, /^## Contexto del proyecto/m)
  assert.doesNotMatch(rendered, /\n{3,}/)
})

test('unknown rule blocks, unclosed blocks and unknown placeholders fail loudly', () => {
  assert.throws(() => renderTemplate('::: rule bogus\nx\n:::\n'), /unknown rule block "bogus"/)
  assert.throws(() => renderTemplate('::: rule gitflow\nx\n'), /unclosed rule or role block/)
  assert.throws(() => renderTemplate('{{agents.bogus}}'), /unknown placeholder/)
  assert.equal(renderTemplate('$ARGUMENTS {{args}}'), '$ARGUMENTS {{args}}')
})

test('agent blocks nested in a rule block survive when the rule is on', () => {
  const source = '::: rule noAiTrace\n::: agent claude\nA\n:::\n::: agent !claude\nB\n:::\n:::\nC'
  assert.equal(renderTemplate(source), '::: agent claude\nA\n:::\n::: agent !claude\nB\n:::\nC')
  assert.equal(renderTemplate(source, config({ off: ['noAiTrace'] })), 'C')
})

test('the committed rules, skill and plan policy are the templates rendered with the defaults', async () => {
  const built = await buildTemplates()
  assert.deepEqual(await staleTemplates(built), [])
  for (const { target, content } of built) assert.doesNotMatch(content, /\{\{|^::: (rule|role)/m, target)
  assert.equal(built.length, 4)
})

test('staleTemplates catches a committed file that drifted from its template', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nursery-templates-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const targets = { rules: path.join(dir, 'RULES.md'), antigravity: path.join(dir, 'antigravity.md'), skill: path.join(dir, 'SKILL.md'), policy: path.join(dir, 'gemini-plan.toml') }
  const built = await buildTemplates(TEMPLATE_SOURCES, targets)
  assert.equal((await staleTemplates(built)).length, 4)
  await writeTemplates(built)
  assert.deepEqual(await staleTemplates(built), [])
  await writeFile(targets.skill, 'hasta 10 agentes\n')
  assert.deepEqual((await staleTemplates(built)).map((file) => path.basename(file)), ['SKILL.md'])
})

test('nursery build --check passes on the committed tree', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'src', 'bin', 'nursery.ts'), 'build', '--check'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
})

for (const role of NURSERY_ROLES) {
  test(`with ${role} turned off the rules never name it`, async () => {
    const enabled = NURSERY_ROLES.filter((name) => name !== role)
    const custom = config({ enabled, readOnly: READ_ONLY_ROLES })
    const pattern = new RegExp(`(^|[^a-z-])${role}([^a-z-]|$)`)
    const rules = renderTemplate(await readFile(RULES, 'utf8'), custom)
    for (const tool of TOOLS) assert.doesNotMatch(agents.renderForAgent(rules, tool), pattern, tool)
    assert.doesNotMatch(renderTemplate(await readFile(ANTIGRAVITY, 'utf8'), custom), pattern)
    assert.doesNotMatch(renderTemplate(await readFile(path.join(ROOT, 'src', 'templates', 'gemini-plan.toml'), 'utf8'), custom), pattern)
  })
}

test('the after-implementation rule names only the reviewers that are on', async () => {
  const source = await readFile(RULES, 'utf8')
  const line = (enabled: string[]) => renderTemplate(source, config({ enabled })).split('\n').find((text) => text.startsWith('- Tras implementar')) ?? null
  assert.equal(line([...NURSERY_ROLES]), '- Tras implementar, siempre qa-automation y code-reviewer antes del MR; si toca IAM, red, secretos o pagos, también security.')
  assert.equal(line(['developer', 'code-reviewer']), '- Tras implementar, siempre code-reviewer antes del MR.')
  assert.equal(line(['developer', 'qa-automation', 'security']), '- Tras implementar, siempre qa-automation antes del MR; si toca IAM, red, secretos o pagos, también security.')
  assert.equal(line(['developer', 'security']), '- Tras implementar, si toca IAM, red, secretos o pagos, pasa por security antes del MR.')
  assert.equal(line(['developer']), null)
  assert.doesNotMatch(renderTemplate(source, config({ enabled: ['developer'] })), /\n{3,}/)
})

test('the parallel example and the plan-mode line follow the enabled roles', async () => {
  const source = await readFile(RULES, 'utf8')
  assert.match(renderTemplate(source, config({ enabled: ['devops'] })), /incluso del mismo rol: dos devops en repos distintos\./)
  assert.match(renderTemplate(source, config({ enabled: ['researcher'] })), /incluso del mismo rol\. Si comparten/)
  const antigravity = renderTemplate(await readFile(ANTIGRAVITY, 'utf8'), config({ enabled: ['developer', 'revisor-sql'], readOnly: ['revisor-sql'] }))
  assert.match(antigravity, /\(`developer`, `revisor-sql`…\)/)
  assert.match(antigravity, /Las de solo lectura \(revisor-sql\) van con/)
  assert.doesNotMatch(antigravity, /modo plan/)
})
