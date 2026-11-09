import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { dataHome, platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { NURSERY_ROLES } from '@kikedealba/kit/settings'
import { SUBAGENTS_DIR, TEMPLATE_SOURCES, agentNames, loadFragments } from './build.ts'
import { OVERRIDE_FIELDS, loadConfig, type AgentOverrides, type NurseryConfig, type OverrideField } from './config.ts'
import { renderTemplate } from './templates.ts'
import { loadUserAgents, type InvalidUserAgent } from './user-agents.ts'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const RENDER_HARNESSES = ['claude', 'opencode', 'codex', 'gemini', 'antigravity'] as const

export type RenderHarness = (typeof RENDER_HARNESSES)[number]

export const UNSUPPORTED_FIELDS: Record<RenderHarness, readonly OverrideField[]> = {
  claude: [],
  opencode: ['model', 'effort'],
  codex: ['model', 'maxTurns'],
  gemini: ['model', 'effort'],
  antigravity: ['model', 'effort', 'maxTurns'],
}

const PLUGIN_SOURCES = ['hooks', 'types'] as const
const DROPPED_FIELDS = ['source', 'createdAt']
const PLUGIN_MANIFEST = path.join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json')
const MARKETPLACE_MANIFEST = path.join(PACKAGE_ROOT, '.claude-plugin', 'marketplace.json')

export interface Unsupported {
  agent: string
  harness: RenderHarness
  field: OverrideField
  value: string
}

export interface PlannedAgent {
  name: string
  source: 'nursery' | 'user'
  enabled: boolean
  content: string
  description: string
  model: string | null
  effort: string | null
  maxTurns: number | null
  tools: string[] | null
  readOnly: boolean
  file: string | null
}

export interface NurseryPlan {
  config: NurseryConfig
  agents: PlannedAgent[]
  invalidAgents: InvalidUserAgent[]
  unsupported: Unsupported[]
}

export interface RenderedNursery {
  root: string
  policyFile: string
  marketplace: string
  rulesFile: string
  antigravityRulesFile: string
  skillDir: string
  subagentsDir: string
  version: string
  config: NurseryConfig
  agents: string[]
  userAgents: string[]
  invalidAgents: InvalidUserAgent[]
  unsupported: Unsupported[]
  stale: string[]
}

export function nurseryDataDir(ctx: PlatformContext = platformContext()): string {
  return path.join(dataHome(ctx), 'kikedealba', 'nursery')
}

export function marketplaceDir(ctx: PlatformContext = platformContext()): string {
  return path.join(nurseryDataDir(ctx), 'marketplace')
}

export function renderedDir(ctx: PlatformContext = platformContext()): string {
  return path.join(nurseryDataDir(ctx), 'rendered')
}

export function applyOverrides(content: string, overrides: AgentOverrides, drop: readonly string[] = []): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---', 4)
  if (end === -1) return content
  const replaced = OVERRIDE_FIELDS.filter((field) => overrides[field] !== undefined)
  const kept = content
    .slice(4, end)
    .split('\n')
    .filter((line) => {
      const field = /^([A-Za-z0-9_-]+):/.exec(line)?.[1]
      return field === undefined || (!(replaced as string[]).includes(field) && !drop.includes(field))
    })
  const added = replaced.map((field) => `${field}: ${overrides[field]}`)
  return `---\n${[...kept, ...added].join('\n')}${content.slice(end)}`
}

async function markdownNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((file) => file.endsWith('.md')).map((file) => path.basename(file, '.md'))
}

async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else hash.update(`${path.relative(dir, full)}\0`).update(await readFile(full)).update('\0')
    }
  }
  await walk(dir)
  return hash.digest('hex').slice(0, 12)
}

async function writeText(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

function unsupportedFor(name: string, values: AgentOverrides): Unsupported[] {
  const found: Unsupported[] = []
  for (const harness of RENDER_HARNESSES) {
    for (const field of UNSUPPORTED_FIELDS[harness]) {
      const value = values[field]
      if (value !== undefined) found.push({ agent: name, harness, field, value })
    }
  }
  return found
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export function isReadOnly(tools: readonly string[] | null): boolean {
  return tools !== null && tools.length > 0 && !tools.includes('*') && !tools.some((tool) => WRITE_TOOLS.includes(tool))
}

function describe(name: string, content: string): Omit<PlannedAgent, 'name' | 'source' | 'enabled' | 'content' | 'file'> {
  const subagent = agents.parseSubagent(content, 'claude', name)
  return { description: subagent.description, model: subagent.model, effort: subagent.effort, maxTurns: subagent.maxTurns, tools: subagent.tools, readOnly: isReadOnly(subagent.tools) }
}

export async function planNursery(ctx: PlatformContext = platformContext()): Promise<NurseryPlan> {
  const fragments = await loadFragments()
  const builtin = await Promise.all((await agentNames(SUBAGENTS_DIR)).map(async (name) => ({ name, content: await readFile(path.join(SUBAGENTS_DIR, `${name}.md`), 'utf8') })))
  const users = await loadUserAgents(fragments, ctx)
  const config = await loadConfig(users.valid.map((agent) => agent.name), ctx)
  const enabled = new Set(config.enabled)
  const unsupported: Unsupported[] = []
  const sources = [
    ...builtin.map((agent) => ({ name: agent.name, source: 'nursery' as const, file: null, content: agent.content, declared: {} as AgentOverrides })),
    ...users.valid.map((agent) => ({
      name: agent.name,
      source: 'user' as const,
      file: agent.file,
      content: agent.content,
      declared: Object.fromEntries(OVERRIDE_FIELDS.filter((field) => agent.attributes[field] !== undefined).map((field) => [field, agent.attributes[field]])) as AgentOverrides,
    })),
  ]
  const planned = sources.map((agent): PlannedAgent => {
    const overrides = config.overrides[agent.name] ?? {}
    const isEnabled = enabled.has(agent.name)
    if (isEnabled) unsupported.push(...unsupportedFor(agent.name, { ...agent.declared, ...overrides }))
    const content = applyOverrides(agent.content, overrides, DROPPED_FIELDS)
    return { name: agent.name, source: agent.source, enabled: isEnabled, content, file: agent.file, ...describe(agent.name, content) }
  })
  const readOnly = new Set(planned.filter((agent) => agent.readOnly).map((agent) => agent.name))
  return { config: { ...config, readOnly: config.enabled.filter((name) => readOnly.has(name)) }, agents: planned, invalidAgents: users.invalid, unsupported }
}

async function template(name: keyof typeof TEMPLATE_SOURCES, config: NurseryConfig): Promise<string> {
  return renderTemplate(await readFile(TEMPLATE_SOURCES[name], 'utf8'), config)
}

export async function renderNursery(ctx: PlatformContext = platformContext()): Promise<RenderedNursery> {
  const plan = await planNursery(ctx)
  const { config } = plan
  const finals = plan.agents.filter((agent) => agent.enabled)
  const enabled = new Set(finals.map((agent) => agent.name))
  const root = nurseryDataDir(ctx)
  const marketplace = marketplaceDir(ctx)
  const rendered = renderedDir(ctx)
  const subagentsDir = path.join(rendered, 'subagents')
  const previous = await markdownNames(subagentsDir)

  await rm(rendered, { recursive: true, force: true })
  for (const agent of finals) await writeText(path.join(subagentsDir, `${agent.name}.md`), agent.content)
  const rulesFile = path.join(rendered, 'RULES.md')
  const antigravityRulesFile = path.join(rendered, 'antigravity.md')
  const policyFile = path.join(rendered, 'gemini-plan.toml')
  const skillDir = path.join(rendered, 'skills', 'nursery')
  const skill = await template('skill', config)
  await writeText(rulesFile, await template('rules', config))
  await writeText(antigravityRulesFile, await template('antigravity', config))
  await writeText(policyFile, await template('policy', config))
  await writeText(path.join(skillDir, 'SKILL.md'), skill)

  await rm(marketplace, { recursive: true, force: true })
  for (const agent of finals) await writeText(path.join(marketplace, 'agents', `${agent.name}.md`), agents.renderForAgent(agent.content, 'claude'))
  await writeText(path.join(marketplace, 'skills', 'nursery', 'SKILL.md'), skill)
  for (const dir of PLUGIN_SOURCES) {
    await cp(path.join(PACKAGE_ROOT, dir), path.join(marketplace, dir), { recursive: true, filter: (source) => !source.endsWith('.test.ts') })
  }
  const version = `${VERSION}+${await hashTree(marketplace)}`
  const plugin = { ...(JSON.parse(await readFile(PLUGIN_MANIFEST, 'utf8')) as Record<string, unknown>), version }
  const catalog = JSON.parse(await readFile(MARKETPLACE_MANIFEST, 'utf8')) as { plugins?: Record<string, unknown>[] } & Record<string, unknown>
  catalog.plugins = (catalog.plugins ?? []).map((entry) => (entry['name'] === 'nursery' ? { ...entry, source: './', version } : entry))
  await writeText(path.join(marketplace, '.claude-plugin', 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`)
  await writeText(path.join(marketplace, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`)

  const names = finals.map((agent) => agent.name)
  const stale = [...new Set([...NURSERY_ROLES, ...previous])].filter((name) => !enabled.has(name))
  return {
    root,
    policyFile,
    marketplace,
    rulesFile,
    antigravityRulesFile,
    skillDir,
    subagentsDir,
    version,
    config,
    agents: names,
    userAgents: plan.agents.filter((agent) => agent.source === 'user').map((agent) => agent.name),
    invalidAgents: plan.invalidAgents,
    unsupported: plan.unsupported,
    stale,
  }
}
