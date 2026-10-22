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

test('the gemini plan mode guidance stays out of the other agents', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  for (const agent of ['claude', 'codex', 'opencode'] as const) {
    assert.doesNotMatch(agents.renderForAgent(rules, agent), GEMINI_ONLY, agent)
  }
})
