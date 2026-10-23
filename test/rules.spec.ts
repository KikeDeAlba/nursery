import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'

const RULES_FILE = path.join(import.meta.dirname, '..', 'rules', 'RULES.md')
const ANTIGRAVITY_FILE = path.join(import.meta.dirname, '..', 'rules', 'antigravity.md')
const COMMAND_FILE = path.join(import.meta.dirname, '..', 'gemini', 'commands', 'nursery.md')

test('the gemini rules leave plan mode and the nursery flow to /nursery', async () => {
  const rendered = agents.renderForAgent(await readFile(RULES_FILE, 'utf8'), 'gemini')
  assert.doesNotMatch(rendered, /exit_plan_mode|invoke_agent|modo plan/)
})

test('antigravity reads the same shared rules as gemini', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  // TODO(kit): drop the cast once @kikedealba/kit 0.6.0 adds antigravity to AgentName
  const rendered = agents.renderForAgent(rules, 'antigravity' as agents.AgentName)
  assert.equal(rendered, agents.renderForAgent(rules, 'gemini'))
  assert.match(rendered, /sin mencionar Antigravity, Gemini, Google ni el modelo/)
  assert.doesNotMatch(rendered, /:::/)
})

test('the antigravity rules delegate through invoke_subagent with isolated branch workspaces', async () => {
  const text = await readFile(ANTIGRAVITY_FILE, 'utf8')
  assert.ok(!text.startsWith('---'), 'kit adds the frontmatter')
  assert.doesNotMatch(text, /:::|<!--/)
  for (const phrase of [/invoke_subagent/, /TypeName es el nombre del agente/, /misma respuesta/, /máximo 10/, /Workspace: "branch"/, /Workspace: "inherit"/, /modo plan/, /ask_question/]) {
    assert.match(text, phrase)
  }
  for (const term of ['Claude', 'Anthropic', 'Codex', 'OpenAI', 'opencode', 'EnterWorktree', 'isolation:']) {
    assert.ok(!text.toLowerCase().includes(term.toLowerCase()), `antigravity rules name ${term}`)
  }
})

test('the repo root has no commands directory that the claude plugin would load', () => {
  assert.ok(!existsSync(path.join(import.meta.dirname, '..', 'commands')), 'commands/ at the root is loaded recursively by the claude plugin')
})

test('the gemini /nursery command starts the flow and drives it to validation', async () => {
  const command = await readFile(COMMAND_FILE, 'utf8')
  const body = command.replace(/^---\n[\s\S]*?\n---\n/, '')
  assert.ok(body.startsWith('[nursery-flow]'), 'the body does not start with the flow marker')
  for (const text of ['$ARGUMENTS', 'ask_user', 'Propuesta', 'Aceptar', 'Corregir', 'qa-automation', 'code-reviewer']) {
    assert.ok(command.includes(text), text)
  }
  assert.doesNotMatch(command, /Claude|Anthropic|Codex|OpenAI|opencode/)
})

const POLICY_FILE = path.join(import.meta.dirname, '..', 'rules', 'gemini-plan.toml')
const ALLOWED = ['researcher', 'analyst', 'architect', 'security', 'code-reviewer', 'sre']
const DENIED = ['developer', 'devops', 'qa-automation', 'documenter']

function stableStringify(value: unknown, topLevel = true): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, false)).join(',')}]`
  const pairs = Object.keys(value).sort().map((key) => {
    const pair = `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], false)}`
    return topLevel ? `\0${pair}\0` : pair
  })
  return `{${pairs.join(',')}}`
}

async function policyPattern(): Promise<RegExp> {
  const match = /^argsPattern = '''(.*)'''$/m.exec(await readFile(POLICY_FILE, 'utf8'))
  assert.ok(match, 'argsPattern literal string not found')
  return new RegExp(match[1]!)
}

test('the gemini plan policy allows only the read-only subagents', async () => {
  const pattern = await policyPattern()
  for (const agent of ALLOWED) assert.match(stableStringify({ agent_name: agent, prompt: 'x' }), pattern, agent)
  for (const agent of DENIED) assert.doesNotMatch(stableStringify({ agent_name: agent, prompt: 'x' }), pattern, agent)
})

test('the gemini plan policy cannot be bypassed through nested or embedded agent names', async () => {
  const pattern = await policyPattern()
  assert.doesNotMatch(stableStringify({ agent_name: 'developer', prompt: 'x', m: { agent_name: 'researcher' } }), pattern)
  assert.doesNotMatch(stableStringify({ agent_name: 'developer', prompt: '"agent_name":"researcher"' }), pattern)
  assert.doesNotMatch(stableStringify({ agent_name: 'researcher-evil' }), pattern)
})

test('the gemini plan policy grants no shell', async () => {
  assert.doesNotMatch(await readFile(POLICY_FILE, 'utf8'), /run_shell_command/)
})
