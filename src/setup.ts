import { existsSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { AGENTS_DIR, RULES_FILE, agentNames } from './build.ts'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const TOOL = 'nursery'

export const CLAUDE_PLUGIN: agents.ClaudePluginSpec = { marketplace: 'KikeDeAlba/nursery', marketplaceName: 'nursery', plugin: 'nursery' }

export const LEGACY_HEADING = '# Reglas generales (todos los proyectos)'

export type MemoryAgent = Exclude<agents.AgentName, 'claude-desktop'>

export const MEMORY_AGENTS: readonly MemoryAgent[] = ['claude', 'opencode', 'codex', 'gemini']

export type AgentSelection = readonly agents.AgentName[] | 'detected' | 'all'

export interface SetupOptions extends agents.InstallOptions {
  replaceLegacy?: boolean
}

export function memoryIntegration(): agents.AgentIntegration {
  return { tool: TOOL, version: VERSION, memory: RULES_FILE }
}

export async function integration(): Promise<agents.AgentIntegration> {
  return {
    tool: TOOL,
    version: VERSION,
    description: 'Specialist subagents and shared working rules',
    subagents: (await agentNames()).map((name) => ({ name, file: path.join(AGENTS_DIR, `${name}.md`) })),
    userSkills: [{ name: 'nursery', dir: path.join(PACKAGE_ROOT, 'skills', 'nursery') }],
    memory: RULES_FILE,
  }
}

export function memoryPath(agent: MemoryAgent, options: agents.InstallOptions = {}): string {
  const homes = agents.agentHomes(options.ctx ?? platformContext(), options.homes)
  const base = { claude: homes.claude, opencode: homes.opencode, codex: homes.codex, gemini: homes.gemini }[agent]
  return path.join(base, agents.MEMORY_FILES[agent])
}

export function findLegacy(text: string): { start: number; end: number } | null {
  const block = /<!-- kit:[a-z0-9-]+:begin -->[\s\S]*?<!-- kit:[a-z0-9-]+:end -->/g
  const masked = text.replace(block, (match) => ' '.repeat(match.length))
  const match = new RegExp(`^${LEGACY_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(masked)
  if (!match) return null
  const rest = masked.slice(match.index + match[0].length)
  const next = /^(# |<!-- kit:)/m.exec(rest)
  return { start: match.index, end: next ? match.index + match[0].length + next.index : text.length }
}

export function removeLegacy(text: string): string {
  const range = findLegacy(text)
  if (!range) return text
  const joined = `${text.slice(0, range.start).replace(/\s*$/, '')}\n\n${text.slice(range.end).replace(/^\s*/, '')}`.trim()
  return joined.length > 0 ? `${joined}\n` : ''
}

async function handleLegacy(agent: MemoryAgent, options: SetupOptions): Promise<agents.Step | null> {
  const file = memoryPath(agent, options)
  if (!existsSync(file)) return null
  const text = await readFile(file, 'utf8')
  if (!findLegacy(text)) return null
  if (!options.replaceLegacy) {
    return { agent, item: 'legacy rules', state: 'skipped', detail: `${file} already has the rules without nursery markers; the block was not written to avoid duplicates. Run: nursery setup --replace-legacy`, path: file }
  }
  await copyFile(file, `${file}.legacy-backup`)
  await writeFile(file, removeLegacy(text))
  return { agent, item: 'legacy rules', state: 'removed', detail: `removed the unmarked rules from ${file} (copy in ${file}.legacy-backup)`, path: file }
}

async function resolveSelection(selection: AgentSelection, options: agents.InstallOptions): Promise<agents.AgentName[]> {
  if (selection === 'all') return [...agents.AGENTS]
  if (selection === 'detected') {
    const ctx = options.ctx ?? platformContext()
    return agents.detectAgents(ctx, agents.agentHomes(ctx, options.homes), options.locate)
  }
  return [...selection]
}

export async function installAgents(selection: AgentSelection, options: SetupOptions = {}): Promise<agents.Step[]> {
  const targets = (await resolveSelection(selection, options)).filter((agent): agent is MemoryAgent => agent !== 'claude-desktop')
  const steps: agents.Step[] = []
  const blocked = new Set<MemoryAgent>()
  for (const agent of targets) {
    const legacy = await handleLegacy(agent, options)
    if (!legacy) continue
    steps.push(legacy)
    if (legacy.state === 'skipped') blocked.add(agent)
  }
  if (targets.includes('claude')) {
    steps.push(...(await agents.installClaudePlugin(CLAUDE_PLUGIN, options)))
    if (!blocked.has('claude')) steps.push(...(await agents.installIntegration(memoryIntegration(), { ...options, agents: ['claude'] })))
  }
  const others = targets.filter((agent) => agent !== 'claude')
  if (others.length > 0) {
    const full = await integration()
    const open = others.filter((agent) => !blocked.has(agent))
    const closed = others.filter((agent) => blocked.has(agent))
    if (open.length > 0) steps.push(...(await agents.installIntegration(full, { ...options, agents: open })))
    const { memory: _memory, ...withoutMemory } = full
    if (closed.length > 0) steps.push(...(await agents.installIntegration(withoutMemory, { ...options, agents: closed })))
  }
  return steps
}

export async function uninstallAgents(options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  const steps: agents.Step[] = []
  steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
  steps.push(...(await agents.uninstallIntegration(memoryIntegration(), { ...options, agents: ['claude'] })))
  steps.push(...(await agents.uninstallIntegration(await integration(), { ...options, agents: ['opencode', 'codex', 'gemini'] })))
  return steps
}

export type MemoryState = 'current' | 'stale' | 'missing' | 'legacy'

export interface MemoryReport {
  agent: MemoryAgent
  file: string
  state: MemoryState
}

export async function checkMemory(selection: AgentSelection, options: agents.InstallOptions = {}): Promise<MemoryReport[]> {
  const rules = await readFile(RULES_FILE, 'utf8')
  const targets = (await resolveSelection(selection, options)).filter((agent): agent is MemoryAgent => agent !== 'claude-desktop')
  const reports: MemoryReport[] = []
  for (const agent of targets) {
    const file = memoryPath(agent, options)
    const text = existsSync(file) ? await readFile(file, 'utf8') : ''
    const block = agents.memoryBlock(text, TOOL)
    const expected = agents.renderForAgent(rules, agent).trim()
    const state: MemoryState = findLegacy(text) ? 'legacy' : block === null ? 'missing' : block === expected ? 'current' : 'stale'
    reports.push({ agent, file, state })
  }
  return reports
}
