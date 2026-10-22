import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { defineManifest, registerTool, stableBin, unregisterTool, type ToolManifest } from '@kikedealba/kit/registry'
import { RULES_FILE, SUBAGENTS_DIR, agentNames } from './build.ts'
import { HOOK_EVENTS, type HookEventName } from './flow-types.ts'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const TOOL = 'nursery'

export const CLAUDE_PLUGIN: agents.ClaudePluginSpec = { marketplace: 'KikeDeAlba/nursery', marketplaceName: 'nursery', plugin: 'nursery' }

export const CAPABILITIES = ['agents.subagents', 'agents.rules']

export const GEMINI_POLICY_FILE = path.join(path.dirname(RULES_FILE), 'gemini-plan.toml')

export const INSTALL_HINT = 'npm install -g @kikedealba/nursery && nursery setup'

export function binEntry(): string {
  const built = path.join(PACKAGE_ROOT, 'dist', 'bin', 'nursery.js')
  return existsSync(built) ? built : path.join(PACKAGE_ROOT, 'src', 'bin', 'nursery.ts')
}

export function binCommand(): string[] {
  return [process.execPath, binEntry()]
}

export async function stableBinCommand(ctx?: PlatformContext): Promise<string[]> {
  return stableBin(TOOL, VERSION, binCommand(), ctx)
}

export function manifest(bin: readonly string[] = binCommand()): ToolManifest {
  return defineManifest({
    name: TOOL,
    version: VERSION,
    description: 'Specialist subagents and shared working rules for coding agents',
    bin: [...bin],
    capabilities: [...CAPABILITIES],
    homepage: 'https://github.com/KikeDeAlba/nursery',
    install: INSTALL_HINT,
  })
}

export async function register(ctx?: PlatformContext): Promise<string> {
  return registerTool(manifest(await stableBinCommand(ctx)), ctx)
}

export async function unregister(ctx?: PlatformContext): Promise<boolean> {
  return unregisterTool(TOOL, ctx)
}

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
    subagents: (await agentNames(SUBAGENTS_DIR)).map((name) => ({ name, file: path.join(SUBAGENTS_DIR, `${name}.md`) })),
    userSkills: [{ name: 'nursery', dir: path.join(PACKAGE_ROOT, 'skills', 'nursery') }],
    memory: RULES_FILE,
  }
}

export const GEMINI_COMMAND_FILE = path.join(PACKAGE_ROOT, 'commands', 'gemini', 'nursery.md')

export const GEMINI_HOOK_NAME = 'nursery-flow'

export const GEMINI_HOOK_TIMEOUT_MS = 10000

export const GEMINI_HOOK_MATCHERS: Partial<Record<HookEventName, string>> = {
  BeforeTool: '^(read_file|read_many_files|grep_search|glob|list_directory|google_web_search|web_fetch|write_file|replace|run_shell_command|invoke_agent|ask_user)$',
  AfterTool: '^(invoke_agent|ask_user)$',
}

export function shellCommand(parts: readonly string[], platform: PlatformContext['platform']): string {
  if (platform === 'win32') return `& ${parts.map((part) => `'${part.replace(/'/g, "''")}'`).join(' ')}`
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')
}

export async function geminiHooks(ctx: PlatformContext = platformContext()): Promise<agents.HookMap> {
  const bin = shellCommand(binCommand(), ctx.platform)
  const hooks: agents.HookMap = {}
  for (const event of HOOK_EVENTS) {
    const matcher = GEMINI_HOOK_MATCHERS[event]
    const hook: agents.HookCommand = { type: 'command', name: GEMINI_HOOK_NAME, command: `${bin} gemini-hook ${event}`, timeout: GEMINI_HOOK_TIMEOUT_MS }
    hooks[event] = [matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] }]
  }
  return hooks
}

export async function geminiIntegration(ctx?: PlatformContext): Promise<agents.AgentIntegration> {
  const { userSkills: _userSkills, ...base } = await integration()
  return {
    ...base,
    commands: [{ name: 'nursery', file: GEMINI_COMMAND_FILE }],
    gemini: { hooks: await geminiHooks(ctx) },
  }
}

export function memoryPath(agent: MemoryAgent, options: agents.InstallOptions = {}): string {
  const homes = agents.agentHomes(options.ctx ?? platformContext(), options.homes)
  const base = { claude: homes.claude, opencode: homes.opencode, codex: homes.codex, gemini: homes.gemini }[agent]
  return path.join(base, agents.MEMORY_FILES[agent])
}

export function geminiPolicyPath(options: agents.InstallOptions = {}): string {
  return path.join(agents.agentHomes(options.ctx ?? platformContext(), options.homes).gemini, 'policies', 'nursery.toml')
}

async function installGeminiPolicy(options: agents.InstallOptions): Promise<agents.Step> {
  const file = geminiPolicyPath(options)
  const policy = await readFile(GEMINI_POLICY_FILE, 'utf8')
  const current = existsSync(file) ? await readFile(file, 'utf8') : null
  if (current === policy) return { agent: 'gemini', item: 'plan policy', state: 'present', detail: `${file} is up to date`, path: file }
  await mkdir(path.dirname(file), { recursive: true })
  if (current !== null) await copyFile(file, `${file}.bak`)
  await writeFile(file, policy)
  const detail = current === null ? `wrote ${file}` : `updated ${file} (copy of the previous one in ${file}.bak)`
  return { agent: 'gemini', item: 'plan policy', state: 'installed', detail, path: file }
}

async function uninstallGeminiPolicy(options: agents.InstallOptions): Promise<agents.Step | null> {
  const file = geminiPolicyPath(options)
  if (!existsSync(file)) return null
  const policy = await readFile(GEMINI_POLICY_FILE, 'utf8')
  if ((await readFile(file, 'utf8')) !== policy) {
    return { agent: 'gemini', item: 'plan policy', state: 'skipped', detail: `${file} differs from the nursery policy; it was left in place`, path: file }
  }
  await rm(file, { force: true })
  return { agent: 'gemini', item: 'plan policy', state: 'removed', detail: `removed ${file}`, path: file }
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

async function installSplit(full: agents.AgentIntegration, targets: readonly MemoryAgent[], blocked: ReadonlySet<MemoryAgent>, options: SetupOptions): Promise<agents.Step[]> {
  const steps: agents.Step[] = []
  const open = targets.filter((agent) => !blocked.has(agent))
  const closed = targets.filter((agent) => blocked.has(agent))
  if (open.length > 0) steps.push(...(await agents.installIntegration(full, { ...options, agents: open })))
  const { memory: _memory, ...withoutMemory } = full
  if (closed.length > 0) steps.push(...(await agents.installIntegration(withoutMemory, { ...options, agents: closed })))
  return steps
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
  const others = targets.filter((agent) => agent === 'opencode' || agent === 'codex')
  if (others.length > 0) steps.push(...(await installSplit(await integration(), others, blocked, options)))
  if (targets.includes('gemini')) steps.push(...(await installSplit(await geminiIntegration(options.ctx), ['gemini'], blocked, options)))
  if (targets.includes('gemini')) steps.push(await installGeminiPolicy(options))
  return steps
}

export async function uninstallAgents(options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  const steps: agents.Step[] = []
  steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
  steps.push(...(await agents.uninstallIntegration(memoryIntegration(), { ...options, agents: ['claude'] })))
  steps.push(...(await agents.uninstallIntegration(await integration(), { ...options, agents: ['opencode', 'codex'] })))
  steps.push(...(await agents.uninstallIntegration(await geminiIntegration(options.ctx), { ...options, agents: ['gemini'] })))
  const policy = await uninstallGeminiPolicy(options)
  if (policy) steps.push(policy)
  return steps
}

export interface SetupResult {
  manifest: string
  steps: agents.Step[]
}

export async function setupTool(selection: AgentSelection, options: SetupOptions = {}): Promise<SetupResult> {
  const manifestPath = await register(options.ctx)
  return { manifest: manifestPath, steps: await installAgents(selection, options) }
}

export interface UninstallResult {
  unregistered: boolean
  steps: agents.Step[]
}

export async function uninstallTool(options: agents.InstallOptions = {}): Promise<UninstallResult> {
  const steps = await uninstallAgents(options)
  return { unregistered: await unregister(options.ctx), steps }
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
