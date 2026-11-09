import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { DEFAULT_TEMPLATE_CONFIG, renderTemplate, type RuleFlag, type TemplateConfig } from '../src/templates.ts'

const ROOT = path.join(import.meta.dirname, '..')
const RULES = path.join(ROOT, 'rules', 'RULES.md')
const ANTIGRAVITY = path.join(ROOT, 'rules', 'antigravity.md')
const SKILL = path.join(ROOT, 'skills', 'nursery', 'SKILL.md')
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
  assert.throws(() => renderTemplate('::: rule gitflow\nx\n'), /unclosed rule block/)
  assert.throws(() => renderTemplate('{{agents.bogus}}'), /unknown placeholder/)
  assert.equal(renderTemplate('$ARGUMENTS {{args}}'), '$ARGUMENTS {{args}}')
})

test('agent blocks nested in a rule block survive when the rule is on', () => {
  const source = '::: rule noAiTrace\n::: agent claude\nA\n:::\n::: agent !claude\nB\n:::\n:::\nC'
  assert.equal(renderTemplate(source), '::: agent claude\nA\n:::\n::: agent !claude\nB\n:::\nC')
  assert.equal(renderTemplate(source, config({ off: ['noAiTrace'] })), 'C')
})
