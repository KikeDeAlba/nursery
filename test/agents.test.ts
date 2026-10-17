import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { AGENTS_DIR, RULES_FILE, agentNames, buildAgents, renderAgent, staleAgents } from '../src/build.ts'

const KNOWN_FIELDS = new Set(['name', 'description', 'tools', 'model', 'effort', 'maxTurns'])
const KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Skill', 'WebFetch', 'WebSearch'])
const MODELS = new Set(['sonnet', 'opus', 'haiku', 'inherit', 'claude-opus-5-5'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const DESCRIPTION_MAX = 300
const DESCRIPTIONS_TOTAL_MAX = 2500
const BODY_MAX_LINES = 80
const RULES_MAX_CHARS = 4500

async function loadAgents(): Promise<{ name: string; text: string; attributes: Record<string, string>; body: string }[]> {
  return Promise.all(
    (await agentNames()).map(async (name) => {
      const text = await readFile(path.join(AGENTS_DIR, `${name}.md`), 'utf8')
      return { name, text, ...agents.parseFrontmatter(text) }
    }),
  )
}

test('the committed agents match their sources', async () => {
  assert.deepEqual(await staleAgents(await buildAgents()), [])
})

test('includes are replaced and unknown includes fail', () => {
  assert.equal(renderAgent('A\n@include x\nB\n', new Map([['x', 'X\n']])), 'A\nX\nB\n')
  assert.throws(() => renderAgent('@include missing\n', new Map()), /unknown include/)
})

test('there are nine agents with valid frontmatter', async () => {
  const loaded = await loadAgents()
  assert.deepEqual(loaded.map((agent) => agent.name), ['analyst', 'architect', 'code-reviewer', 'developer', 'devops', 'documenter', 'qa-automation', 'security', 'sre'])
  for (const agent of loaded) {
    assert.equal(agent.attributes['name'], agent.name)
    assert.ok(!agent.name.includes(':'))
    for (const field of Object.keys(agent.attributes)) assert.ok(KNOWN_FIELDS.has(field), `${agent.name}: unknown field ${field}`)
    assert.ok(MODELS.has(agent.attributes['model'] ?? ''), `${agent.name}: model`)
    assert.ok(EFFORTS.has(agent.attributes['effort'] ?? ''), `${agent.name}: effort`)
    assert.ok(Number.parseInt(agent.attributes['maxTurns'] ?? '', 10) > 0, `${agent.name}: maxTurns`)
    for (const tool of (agent.attributes['tools'] ?? '').split(',').map((item) => item.trim()).filter(Boolean)) assert.ok(KNOWN_TOOLS.has(tool), `${agent.name}: tool ${tool}`)
    assert.doesNotMatch(agent.text, /^@include|:::/m)
  }
})

test('the developer runs on Opus 5.5 with medium effort', async () => {
  const developer = (await loadAgents()).find((agent) => agent.name === 'developer')
  assert.equal(developer?.attributes['model'], 'claude-opus-5-5')
  assert.equal(developer?.attributes['effort'], 'medium')
})

test('descriptions stay inside the context budget and are safe yaml', async () => {
  const loaded = await loadAgents()
  let total = 0
  for (const agent of loaded) {
    const description = agent.attributes['description'] ?? ''
    total += description.length
    assert.ok(description.length > 0 && description.length <= DESCRIPTION_MAX, `${agent.name}: ${description.length} chars`)
    assert.doesNotMatch(description, /: |#|"/, `${agent.name}: description must be a plain yaml scalar`)
  }
  assert.ok(total <= DESCRIPTIONS_TOTAL_MAX, `descriptions add up to ${total} chars`)
})

test('trigger phrases are not shared between agents', async () => {
  const owners = new Map<string, string>()
  for (const agent of await loadAgents()) {
    for (const match of (agent.attributes['description'] ?? '').matchAll(/«([^»]+)»/g)) {
      const phrase = (match[1] ?? '').toLowerCase()
      assert.ok(!owners.has(phrase), `«${phrase}» is in ${owners.get(phrase)} and ${agent.name}`)
      owners.set(phrase, agent.name)
    }
  }
  assert.ok(owners.size >= 18)
})

test('bodies are short, end with the handoff and do not repeat the general rules', async () => {
  const rules = (await readFile(RULES_FILE, 'utf8')).split('\n').map((line) => line.trim()).filter((line) => line.length >= 40)
  for (const agent of await loadAgents()) {
    assert.ok(agent.body.split('\n').length <= BODY_MAX_LINES, `${agent.name}: body too long`)
    assert.match(agent.body, /## Entrega/)
    for (const line of rules) assert.ok(!agent.body.includes(line), `${agent.name} repeats: ${line}`)
  }
})

test('the rules block stays inside its budget for every agent', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  for (const agent of ['claude', 'opencode', 'codex', 'gemini'] as const) {
    const rendered = agents.renderForAgent(rules, agent)
    assert.ok(rendered.length <= RULES_MAX_CHARS, `${agent}: ${rendered.length} chars`)
    assert.doesNotMatch(rendered, /:::/)
    if (agent === 'claude') assert.match(rendered, /EnterWorktree/)
    else assert.doesNotMatch(rendered, /EnterWorktree|ExitWorktree/)
  }
})
