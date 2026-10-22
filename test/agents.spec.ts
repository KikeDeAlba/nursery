import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { AGENTS_DIR, RULES_FILE, SUBAGENTS_DIR, agentNames, buildAgents, renderAgent, staleAgents, writeAgents } from '../src/build.ts'

const KNOWN_FIELDS = new Set(['name', 'description', 'tools', 'model', 'effort', 'maxTurns'])
const KNOWN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'Skill', 'WebFetch', 'WebSearch'])
const MODELS = new Set(['sonnet', 'opus', 'haiku', 'inherit', 'claude-opus-5-5'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const DESCRIPTION_MAX = 300
const DESCRIPTIONS_TOTAL_MAX = 2500
const BODY_MAX_LINES = 80
const RULES_MAX_CHARS = 5200
const SKILL_FILE = path.join(import.meta.dirname, '..', 'skills', 'nursery', 'SKILL.md')
const TOOL_ONLY = ['.claude', 'EnterWorktree', 'ExitWorktree', 'isolation:', 'worktree-agent-']
const FOREIGN_TERMS = {
  claude: ['Codex', 'OpenAI', 'Gemini', 'Google', 'opencode'],
  codex: ['Claude', 'Anthropic', 'Gemini', 'Google', 'opencode', ...TOOL_ONLY],
  gemini: ['Claude', 'Anthropic', 'Codex', 'OpenAI', 'opencode', ...TOOL_ONLY],
  opencode: ['Claude', 'Anthropic', 'Codex', 'OpenAI', 'Gemini', 'Google', ...TOOL_ONLY],
} as const
const OWN_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'opencode' } as const
const CONVERTERS = {
  claude: (markdown: string) => agents.parseFrontmatter(agents.renderForAgent(markdown, 'claude')).body,
  codex: agents.subagentForCodex,
  gemini: agents.subagentForGemini,
  opencode: agents.subagentForOpenCode,
} as const

function assertNoForeignTerms(text: string, agent: keyof typeof FOREIGN_TERMS, label: string): void {
  const lower = text.toLowerCase()
  for (const term of FOREIGN_TERMS[agent]) assert.ok(!lower.includes(term.toLowerCase()), `${label} for ${agent} mentions ${term}`)
}

const TOOLS = ['claude', 'codex', 'gemini', 'opencode'] as const

async function loadAgents(dir: string = AGENTS_DIR): Promise<{ name: string; text: string; attributes: Record<string, string>; body: string }[]> {
  return Promise.all(
    (await agentNames(dir)).map(async (name) => {
      const text = await readFile(path.join(dir, `${name}.md`), 'utf8')
      return { name, text, ...agents.parseFrontmatter(text) }
    }),
  )
}

async function loadRendered(tool: (typeof TOOLS)[number]): Promise<{ name: string; text: string; attributes: Record<string, string>; body: string }[]> {
  return (await loadAgents(SUBAGENTS_DIR)).map((agent) => {
    const text = agents.renderForAgent(agent.text, tool)
    return { name: agent.name, text, ...agents.parseFrontmatter(text) }
  })
}

test('the committed agents match their sources', async () => {
  assert.deepEqual(await staleAgents(await buildAgents()), [])
})

test('the claude agents are the portable subagents rendered for claude', async () => {
  const claude = await loadAgents()
  const portable = await loadAgents(SUBAGENTS_DIR)
  assert.deepEqual(claude.map((agent) => agent.name), portable.map((agent) => agent.name))
  for (const [index, agent] of claude.entries()) {
    assert.doesNotMatch(agent.text, /^@include|:::/m, agent.name)
    assert.equal(agent.text, agents.renderForAgent(portable[index]?.text ?? '', 'claude'), agent.name)
  }
})

test('the build writes and checks the claude agents and the portable subagents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'nursery-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const claudeDir = path.join(root, 'agents')
  const portableDir = path.join(root, 'subagents')
  const built = [{ name: 'x', content: '---\nname: x\n::: agent gemini\nmaxTurns: 60\n:::\n---\n\nBody\n' }]
  assert.deepEqual(await staleAgents(built, claudeDir, portableDir), ['agents/x', 'subagents/x'])
  await writeAgents(built, claudeDir, portableDir)
  assert.equal(await readFile(path.join(claudeDir, 'x.md'), 'utf8'), '---\nname: x\n---\n\nBody\n')
  assert.equal(await readFile(path.join(portableDir, 'x.md'), 'utf8'), built[0]?.content)
  assert.deepEqual(await staleAgents(built, claudeDir, portableDir), [])
  await writeFile(path.join(portableDir, 'y.md'), 'stale\n')
  await writeFile(path.join(claudeDir, 'x.md'), 'edited\n')
  assert.deepEqual(await staleAgents(built, claudeDir, portableDir), ['agents/x', 'subagents/y'])
})

test('includes are replaced and unknown includes fail', () => {
  assert.equal(renderAgent('A\n@include x\nB\n', new Map([['x', 'X\n']])), 'A\nX\nB\n')
  assert.throws(() => renderAgent('@include missing\n', new Map()), /unknown include/)
})

test('there are ten agents with valid frontmatter for every tool', async () => {
  for (const tool of TOOLS) {
    const loaded = await loadRendered(tool)
    assert.deepEqual(loaded.map((agent) => agent.name), ['analyst', 'architect', 'code-reviewer', 'developer', 'devops', 'documenter', 'qa-automation', 'researcher', 'security', 'sre'])
    for (const agent of loaded) {
      const label = `${tool}/${agent.name}`
      assert.equal(agent.attributes['name'], agent.name, label)
      assert.ok(!agent.name.includes(':'))
      for (const field of Object.keys(agent.attributes)) assert.ok(KNOWN_FIELDS.has(field), `${label}: unknown field ${field}`)
      assert.ok(MODELS.has(agent.attributes['model'] ?? ''), `${label}: model`)
      assert.ok(EFFORTS.has(agent.attributes['effort'] ?? ''), `${label}: effort`)
      assert.ok(Number.parseInt(agent.attributes['maxTurns'] ?? '', 10) > 0, `${label}: maxTurns`)
      for (const item of (agent.attributes['tools'] ?? '').split(',').map((value) => value.trim()).filter(Boolean)) assert.ok(KNOWN_TOOLS.has(item), `${label}: tool ${item}`)
      assert.doesNotMatch(agent.text, /^@include|:::/m, label)
    }
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

test('the rules make the main thread delegate, in parallel when it can', async () => {
  const rendered = agents.renderForAgent(await readFile(RULES_FILE, 'utf8'), 'claude')
  const section = rendered.slice(rendered.indexOf('## Delegación'))
  assert.ok(section.length > '## Delegación'.length)
  for (const name of await agentNames()) assert.match(section, new RegExp(`\\b${name}\\b`), `${name} missing from the delegation rules`)
  assert.match(section, /máximo 10/)
  assert.match(section, /solo locales/)
})

test('the researcher is read-only and starts the planned chains', async () => {
  const researcher = (await loadAgents()).find((agent) => agent.name === 'researcher')
  const tools = (researcher?.attributes['tools'] ?? '').split(',').map((item) => item.trim())
  assert.ok(tools.length > 1)
  for (const tool of ['Write', 'Edit']) assert.ok(!tools.includes(tool), `researcher has ${tool}`)
  const skill = await readFile(SKILL_FILE, 'utf8')
  for (const chain of ['Feature o historia', 'Infraestructura o pipeline', 'Incidente']) {
    const row = skill.split('\n').find((line) => line.startsWith(`| ${chain} |`))
    assert.match(row ?? '', /^\| [^|]+ \| researcher → /, `${chain} does not start with researcher`)
  }
})

test('agents that change code know how to work as one part of a parallel task', async () => {
  for (const agent of (await loadAgents()).filter((item) => ['developer', 'devops', 'qa-automation'].includes(item.name))) {
    assert.match(agent.body, /## Rama asignada/, agent.name)
    assert.match(agent.body, /sin push ni MR/, agent.name)
  }
})

test('parallel parts of one repo run in worktrees the orchestrator creates for them', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  const skill = await readFile(SKILL_FILE, 'utf8')
  assert.doesNotMatch(skill, /:::/)
  const lower = skill.toLowerCase()
  for (const term of ['Claude', 'Anthropic', 'Codex', 'OpenAI', 'Gemini', 'Google', 'opencode', ...TOOL_ONLY]) assert.ok(!lower.includes(term.toLowerCase()), `skill names ${term}`)
  assert.match(skill, /worktree aislado/)
  assert.match(skill, /git switch -C feature\/<n>-<parte> feature\/<n>/)
  assert.match(skill, /git merge/)
  assert.match(skill, /git worktree remove/)
  assert.match(skill, /git branch -D/)
  assert.match(skill, /eres una parte aislada; tu cwd es tu worktree/)
  assert.match(skill, /Si tu sesión queda restringida a su worktree/)
  for (const phrase of [/no puedes escribir en otro repo/, /reglas generales/]) assert.doesNotMatch(skill, phrase)
  const claudeRules = agents.renderForAgent(rules, 'claude')
  assert.match(claudeRules, /isolation: "worktree"/)
  assert.match(claudeRules, /git merge/)
  assert.match(claudeRules, /worktree-agent-<id>/)
  assert.match(claudeRules, /no se puede escribir en otro repo/)
  for (const agent of ['codex', 'gemini', 'opencode'] as const) {
    const rendered = agents.renderForAgent(rules, agent)
    assert.doesNotMatch(rendered, /isolation|Claude|no se puede escribir en otro repo/)
    assert.match(rendered, /propio worktree y sub-rama/)
  }
  for (const agent of (await loadAgents()).filter((item) => ['developer', 'devops', 'qa-automation', 'documenter'].includes(item.name))) {
    assert.match(agent.body, /Si el mensaje dice que eres una parte aislada \(tu cwd ya es un worktree creado para ti\), no crees otro/, agent.name)
    assert.match(agent.body, /git switch -C <rama> <base>/, agent.name)
    const steps = agent.body.slice(agent.body.indexOf('## Cómo trabajas'), agent.body.indexOf('## Rama asignada'))
    for (const line of steps.split('\n').filter((item) => /worktree/.test(item))) assert.match(line, /parte aislada/, `${agent.name} step ignores the isolated-part exception: ${line}`)
  }
})

test('each agent only sees its own tool in the rules, subagents and skill', async () => {
  const rules = await readFile(RULES_FILE, 'utf8')
  const skill = await readFile(SKILL_FILE, 'utf8')
  const loaded = await loadAgents(SUBAGENTS_DIR)
  for (const agent of TOOLS) {
    const rendered = agents.renderForAgent(rules, agent)
    assertNoForeignTerms(rendered, agent, 'rules')
    assert.match(rendered, new RegExp(`\\b${OWN_NAME[agent]}\\b`), `rules for ${agent} do not name it`)
    const traceLines = rendered.split('\n').filter((line) => line.includes('Cero rastro'))
    assert.equal(traceLines.length, 1, `rules for ${agent} have ${traceLines.length} no-trace lines`)
    assert.match(traceLines[0] ?? '', new RegExp(`\\b${OWN_NAME[agent]}\\b`), `no-trace rule for ${agent} does not name it`)
    for (const subagent of loaded) assertNoForeignTerms(CONVERTERS[agent](subagent.text, subagent.name), agent, `subagent ${subagent.name}`)
    assertNoForeignTerms(agents.renderForAgent(skill, agent), agent, 'skill')
  }
})
