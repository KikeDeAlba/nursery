import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'

const RULES_FILE = path.join(import.meta.dirname, '..', 'rules', 'RULES.md')
const GEMINI_ONLY = /invoke_agent|exit_plan_mode/

test('the gemini rules make plan mode delegate and close the plan', async () => {
  const rendered = agents.renderForAgent(await readFile(RULES_FILE, 'utf8'), 'gemini')
  assert.match(rendered, /invoke_agent/)
  assert.match(rendered, /exit_plan_mode/)
})

test('the gemini rules delegate research in parallel and build on the handoff in any mode', async () => {
  const rendered = agents.renderForAgent(await readFile(RULES_FILE, 'utf8'), 'gemini')
  const lines = rendered.split('\n').filter((line) => /invoke_agent|entrega|exit_plan_mode|codebase_investigator/.test(line))
  const research = lines.find((line) => line.includes('invoke_agent'))
  assert.match(research ?? '', /varias invocaciones en la misma respuesta/)
  assert.match(research ?? '', /3 preguntas/)
  assert.ok(lines.some((line) => /entrega/.test(line) && /no releas/.test(line)), 'the handoff is not the base')
  assert.ok(lines.some((line) => /Tras la entrega, 10 llamadas/.test(line)), 'no call budget after the handoff')
  for (const line of lines) assert.doesNotMatch(line, /^- En modo plan/, line)
})

test('the gemini plan mode guidance stays out of the other agents', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  for (const agent of ['claude', 'codex', 'opencode'] as const) {
    assert.doesNotMatch(agents.renderForAgent(rules, agent), GEMINI_ONLY, agent)
  }
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
