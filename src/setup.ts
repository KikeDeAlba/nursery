import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext, run, type PlatformContext } from '@kikedealba/kit/platform'
import { defineManifest, registerTool, stableBin, unregisterTool, type ToolManifest } from '@kikedealba/kit/registry'
import { envFor, listProfiles } from '@kikedealba/kit/profiles'
import { NURSERY_ROLES } from '@kikedealba/kit/settings'
import { RULES_FILE, TEMPLATE_SOURCES } from './build.ts'
import { HOOK_EVENTS, type HookEventName } from './flow-types.ts'
import { marketplaceDir, nurseryDataDir, planNursery, renderNursery, renderedDir, type RenderedNursery } from './render.ts'
import { renderTemplate } from './templates.ts'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const TOOL = 'nursery'

export const CLAUDE_PLUGIN: agents.ClaudePluginSpec = { marketplace: 'KikeDeAlba/nursery', marketplaceName: 'nursery', plugin: 'nursery' }

export function claudePlugin(rendered: RenderedNursery): agents.ClaudePluginSpec {
  return { ...CLAUDE_PLUGIN, marketplace: rendered.marketplace }
}

export const CAPABILITIES = ['agents.subagents', 'agents.rules']

export const ANTIGRAVITY_RULES_FILE = path.join(path.dirname(RULES_FILE), 'antigravity.md')

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

export type MemoryAgent = agents.MemoryAgent

export const MEMORY_AGENTS: readonly MemoryAgent[] = ['claude', 'opencode', 'codex', 'gemini', 'antigravity']

export type AgentSelection = readonly agents.AgentName[] | 'detected' | 'all'

export interface SetupOptions extends agents.InstallOptions {
  replaceLegacy?: boolean
  rendered?: RenderedNursery
}

export function memoryIntegration(rendered: RenderedNursery): agents.AgentIntegration {
  return { tool: TOOL, version: VERSION, memory: rendered.rulesFile }
}

export function integration(rendered: RenderedNursery): agents.AgentIntegration {
  return {
    tool: TOOL,
    version: VERSION,
    description: 'Specialist subagents and shared working rules',
    subagents: rendered.agents.map((name) => ({ name, file: path.join(rendered.subagentsDir, `${name}.md`) })),
    userSkills: [{ name: 'nursery', dir: rendered.skillDir }],
    memory: rendered.rulesFile,
    antigravity: { rules: rendered.antigravityRulesFile },
  }
}

async function removalIntegration(ctx?: PlatformContext): Promise<agents.AgentIntegration> {
  const dir = path.join(renderedDir(ctx), 'subagents')
  const rendered = existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith('.md')).map((file) => path.basename(file, '.md')) : []
  const names = [...new Set([...NURSERY_ROLES, ...rendered])]
  return {
    tool: TOOL,
    version: VERSION,
    description: 'Specialist subagents and shared working rules',
    subagents: names.map((name) => ({ name, file: path.join(dir, `${name}.md`) })),
    userSkills: [{ name: 'nursery', dir: path.join(PACKAGE_ROOT, 'skills', 'nursery') }],
    memory: RULES_FILE,
    antigravity: { rules: ANTIGRAVITY_RULES_FILE },
  }
}

function withGemini(base: agents.AgentIntegration, hooks: agents.HookMap): agents.AgentIntegration {
  const { userSkills: _userSkills, ...rest } = base
  return { ...rest, commands: [{ name: 'nursery', file: GEMINI_COMMAND_FILE }], gemini: { hooks } }
}

export const GEMINI_COMMAND_FILE = path.join(PACKAGE_ROOT, 'gemini', 'commands', 'nursery.md')

export const GEMINI_HOOK_NAME = 'nursery-flow'

export const GEMINI_HOOK_TIMEOUT_MS = 10000

export const GEMINI_HOOK_MATCHERS: Partial<Record<HookEventName, string>> = {
  BeforeTool: '.*',
  AfterTool: '^(invoke_agent|ask_user)$',
}

export function shellCommand(parts: readonly string[], platform: PlatformContext['platform']): string {
  if (platform === 'win32') return `& ${parts.map((part) => `'${part.replace(/['‘’‚‛]/g, (m) => m + m)}'`).join(' ')}`
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

export async function geminiIntegration(rendered: RenderedNursery, ctx?: PlatformContext): Promise<agents.AgentIntegration> {
  return withGemini(integration(rendered), await geminiHooks(ctx))
}

export function memoryPath(agent: MemoryAgent, options: agents.InstallOptions = {}): string {
  return agents.memoryFile(agent, agents.agentHomes(options.ctx ?? platformContext(), options.homes))
}

export function geminiPolicyPath(options: agents.InstallOptions = {}): string {
  return path.join(agents.agentHomes(options.ctx ?? platformContext(), options.homes).gemini, 'policies', 'nursery.toml')
}

async function installGeminiPolicy(options: agents.InstallOptions, source: string): Promise<agents.Step> {
  const file = geminiPolicyPath(options)
  const policy = await readFile(source, 'utf8')
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
  const rendered = path.join(renderedDir(options.ctx), 'gemini-plan.toml')
  const known = [await readFile(GEMINI_POLICY_FILE, 'utf8'), ...(existsSync(rendered) ? [await readFile(rendered, 'utf8')] : [])]
  if (!known.includes(await readFile(file, 'utf8'))) {
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

async function handleLegacy(agent: MemoryAgent, file: string, options: SetupOptions): Promise<agents.Step | null> {
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

function errorText(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error)
}

interface ClaudeCli {
  claude: string
  exec: (command: string, args: readonly string[]) => Promise<void | string>
}

async function claudeCli(options: agents.InstallOptions): Promise<ClaudeCli | null> {
  const ctx = options.ctx ?? platformContext()
  const claude = await (options.locate ?? ((command: string) => agents.findAgentBinary('claude', { ctx })))('claude')
  if (!claude) return null
  const exec = options.exec ?? (async (command: string, args: readonly string[]) => (await run(command, args, { env: ctx.env, timeoutMs: 120_000 })).stdout)
  return { claude, exec }
}

async function listJson(cli: ClaudeCli, args: readonly string[]): Promise<Record<string, unknown>[] | null> {
  try {
    const parsed: unknown = JSON.parse(String((await cli.exec(cli.claude, args)) ?? ''))
    if (!Array.isArray(parsed)) return null
    return parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
  } catch {
    return null
  }
}

function pluginId(): string {
  return `${CLAUDE_PLUGIN.plugin}@${CLAUDE_PLUGIN.marketplaceName}`
}

async function installedPlugin(cli: ClaudeCli): Promise<Record<string, unknown> | null> {
  return (await listJson(cli, ['plugin', 'list', '--json']))?.find((entry) => entry['id'] === pluginId() && (entry['scope'] === undefined || entry['scope'] === 'user')) ?? null
}

type MarketplaceState = 'absent' | 'local' | 'replaced' | 'foreign' | 'failed'

interface MarketplacePreparation {
  state: MarketplaceState
  steps: agents.Step[]
  wasDisabled: boolean
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

async function prepareMarketplace(rendered: RenderedNursery, cli: ClaudeCli): Promise<MarketplacePreparation> {
  const item = `marketplace ${CLAUDE_PLUGIN.marketplaceName}`
  const listed = await listJson(cli, ['plugin', 'marketplace', 'list', '--json'])
  const entry = listed?.find((candidate) => candidate['name'] === CLAUDE_PLUGIN.marketplaceName)
  if (!entry) return { state: 'absent', steps: [], wasDisabled: false }
  const directory = entry['source'] === 'directory' && typeof entry['path'] === 'string' ? entry['path'] : null
  if (directory !== null && samePath(directory, rendered.marketplace)) return { state: 'local', steps: [], wasDisabled: false }
  if (directory !== null) {
    const detail = `marketplace nursery points to ${directory}, not to ${rendered.marketplace}; it was left alone and the plugin was not installed. Run: claude plugin marketplace remove nursery && nursery setup`
    return { state: 'foreign', steps: [{ agent: 'claude', item, state: 'skipped', detail }], wasDisabled: false }
  }
  const wasDisabled = (await installedPlugin(cli))?.['enabled'] === false
  const origin = typeof entry['repo'] === 'string' ? entry['repo'] : typeof entry['url'] === 'string' ? entry['url'] : String(entry['source'] ?? 'unknown')
  try {
    await cli.exec(cli.claude, ['plugin', 'marketplace', 'remove', CLAUDE_PLUGIN.marketplaceName])
    return { state: 'replaced', steps: [{ agent: 'claude', item, state: 'removed', detail: `removed the marketplace from ${origin}; nursery now installs from ${rendered.marketplace}` }], wasDisabled }
  } catch (error) {
    return { state: 'failed', steps: [{ agent: 'claude', item, state: 'failed', detail: `claude plugin marketplace remove failed: ${errorText(error)}` }], wasDisabled }
  }
}

export async function prepareClaudeMarketplace(rendered: RenderedNursery, options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  const cli = await claudeCli(options)
  return cli ? (await prepareMarketplace(rendered, cli)).steps : []
}

async function installClaude(rendered: RenderedNursery, options: agents.InstallOptions): Promise<agents.Step[]> {
  const cli = await claudeCli(options)
  if (!cli) return agents.installClaudePlugin(claudePlugin(rendered), options)
  const prepared = await prepareMarketplace(rendered, cli)
  const steps = [...prepared.steps]
  if (prepared.state === 'foreign' || prepared.state === 'failed') return steps
  if (prepared.state === 'local') {
    const current = await installedPlugin(cli)
    if (current?.['version'] === rendered.version) {
      steps.push({ agent: 'claude', item: `plugin ${pluginId()}`, state: 'present', detail: `plugin ${pluginId()} unchanged (${rendered.version})` })
      return steps
    }
  }
  const installed = await agents.installClaudePlugin(claudePlugin(rendered), options)
  steps.push(...installed)
  if (prepared.wasDisabled && !installed.some((step) => step.state === 'failed')) {
    try {
      await cli.exec(cli.claude, ['plugin', 'disable', pluginId(), '--scope', 'user'])
      steps.push({ agent: 'claude', item: `plugin ${pluginId()}`, state: 'skipped', detail: `plugin ${pluginId()} was disabled before the migration and stays disabled` })
    } catch (error) {
      steps.push({ agent: 'claude', item: `plugin ${pluginId()}`, state: 'failed', detail: `could not disable ${pluginId()} again: ${errorText(error)}` })
    }
  }
  return steps
}

async function removeLocalMarketplace(options: agents.InstallOptions): Promise<agents.Step[]> {
  const cli = await claudeCli(options)
  if (!cli) return []
  const local = marketplaceDir(options.ctx)
  const entry = (await listJson(cli, ['plugin', 'marketplace', 'list', '--json']))?.find((candidate) => candidate['name'] === CLAUDE_PLUGIN.marketplaceName)
  if (!entry || entry['source'] !== 'directory' || typeof entry['path'] !== 'string' || !samePath(entry['path'], local)) return []
  const item = `marketplace ${CLAUDE_PLUGIN.marketplaceName}`
  try {
    await cli.exec(cli.claude, ['plugin', 'marketplace', 'remove', CLAUDE_PLUGIN.marketplaceName])
    return [{ agent: 'claude', item, state: 'removed', detail: `removed the local marketplace ${local}` }]
  } catch (error) {
    return [{ agent: 'claude', item, state: 'failed', detail: `claude plugin marketplace remove failed: ${errorText(error)}` }]
  }
}

function excludedSteps(rendered: RenderedNursery, targets: readonly MemoryAgent[]): agents.Step[] {
  return rendered.excluded.filter((entry) => targets.includes(entry.harness)).map((entry) => ({ agent: entry.harness, item: `subagent ${entry.agent}`, state: 'skipped' as const, detail: entry.detail }))
}

function withoutExcluded(base: agents.AgentIntegration, rendered: RenderedNursery, harness: MemoryAgent): agents.AgentIntegration {
  const skip = new Set(rendered.excluded.filter((entry) => entry.harness === harness).map((entry) => entry.agent))
  return skip.size === 0 ? base : { ...base, subagents: (base.subagents ?? []).filter((subagent) => !skip.has(subagent.name)) }
}

function unsupportedSteps(rendered: RenderedNursery, targets: readonly MemoryAgent[]): agents.Step[] {
  return rendered.unsupported
    .filter((entry) => targets.includes(entry.harness))
    .map((entry) => ({ agent: entry.harness, item: `subagent ${entry.agent}`, state: 'skipped' as const, detail: `${entry.field}: ${entry.value} has no equivalent in ${entry.harness}; it was not applied` }))
}

async function pruneSubagents(rendered: RenderedNursery, targets: readonly MemoryAgent[], options: agents.InstallOptions): Promise<agents.Step[]> {
  const homes = agents.agentHomes(options.ctx ?? platformContext(), options.homes)
  const steps: agents.Step[] = []
  for (const agent of targets) {
    if (agent !== 'opencode' && agent !== 'codex') continue
    for (const name of rendered.stale) {
      const file = agent === 'opencode' ? path.join(homes.opencode, 'agents', `${name}.md`) : path.join(homes.codex, 'agents', `${name}.toml`)
      if (!existsSync(file)) continue
      await rm(file, { force: true })
      steps.push({ agent, item: `subagent ${name}`, state: 'removed', detail: `removed ${file}; ${name} is not enabled`, path: file })
    }
  }
  return steps
}

export async function installAgents(selection: AgentSelection, options: SetupOptions = {}): Promise<agents.Step[]> {
  const targets = (await resolveSelection(selection, options)).filter((agent): agent is MemoryAgent => agent !== 'claude-desktop')
  const rendered = options.rendered ?? (await renderNursery(options.ctx))
  const steps: agents.Step[] = [...unsupportedSteps(rendered, targets), ...excludedSteps(rendered, targets)]
  const blocked = new Set<MemoryAgent>()
  const handled = new Map<string, agents.Step | null>()
  for (const agent of targets) {
    const file = path.resolve(memoryPath(agent, options))
    const seen = handled.has(file)
    const legacy = seen ? (handled.get(file) ?? null) : await handleLegacy(agent, file, options)
    handled.set(file, legacy)
    if (!legacy) continue
    if (!seen) steps.push(legacy)
    if (legacy.state === 'skipped') blocked.add(agent)
  }
  if (targets.includes('claude')) {
    steps.push(...(await installClaude(rendered, options)))
    if (!blocked.has('claude')) steps.push(...(await agents.installIntegration(memoryIntegration(rendered), { ...options, agents: ['claude'] })))
  }
  const others = targets.filter((agent) => agent === 'opencode' || agent === 'codex')
  if (others.length > 0) {
    steps.push(...(await installSplit(integration(rendered), others, blocked, options)))
    steps.push(...(await pruneSubagents(rendered, others, options)))
  }
  if (targets.includes('antigravity')) steps.push(...(await installSplit(withoutExcluded(integration(rendered), rendered, 'antigravity'), ['antigravity'], blocked, options)))
  if (targets.includes('gemini')) steps.push(...(await installSplit(await geminiIntegration(rendered, options.ctx), ['gemini'], blocked, options)))
  if (targets.includes('gemini')) steps.push(await installGeminiPolicy(options, rendered.policyFile))
  return steps
}

export interface UninstallOptions extends agents.InstallOptions {
  harnesses?: readonly MemoryAgent[]
}

export async function uninstallAgents(options: UninstallOptions = {}): Promise<agents.Step[]> {
  const wanted = new Set<MemoryAgent>(options.harnesses ?? MEMORY_AGENTS)
  const steps: agents.Step[] = []
  const removal = await removalIntegration(options.ctx)
  if (wanted.has('claude')) {
    steps.push(...(await agents.uninstallClaudePlugin(CLAUDE_PLUGIN, options)))
    steps.push(...(await removeLocalMarketplace(options)))
    steps.push(...(await agents.uninstallIntegration({ tool: TOOL, version: VERSION, memory: RULES_FILE }, { ...options, agents: ['claude'] })))
  }
  const others = (['opencode', 'codex', 'antigravity'] as const).filter((agent) => wanted.has(agent))
  if (others.length > 0) steps.push(...(await agents.uninstallIntegration(removal, { ...options, agents: others })))
  if (wanted.has('gemini')) {
    steps.push(...(await agents.uninstallIntegration(withGemini(removal, await geminiHooks(options.ctx)), { ...options, agents: ['gemini'] })))
    const policy = await uninstallGeminiPolicy(options)
    if (policy) steps.push(policy)
  }
  return steps
}

export interface SetupResult {
  manifest: string
  steps: agents.Step[]
  warnings: string[]
  invalidAgents: RenderedNursery['invalidAgents']
}

export async function setupTool(selection: AgentSelection, options: SetupOptions = {}): Promise<SetupResult> {
  const manifestPath = await register(options.ctx)
  const rendered = options.rendered ?? (await renderNursery(options.ctx))
  return { manifest: manifestPath, steps: await installAgents(selection, { ...options, rendered }), warnings: rendered.warnings, invalidAgents: rendered.invalidAgents }
}

export async function currentRules(ctx?: PlatformContext): Promise<string> {
  const { config } = await planNursery(ctx)
  return renderTemplate(await readFile(TEMPLATE_SOURCES.rules, 'utf8'), config)
}

export interface UninstallResult {
  unregistered: boolean
  steps: agents.Step[]
}

export async function uninstallTool(options: agents.InstallOptions = {}): Promise<UninstallResult> {
  const ctx = options.ctx ?? platformContext()
  const profiles = await listProfiles(ctx).then((list) => list.profiles, () => null)
  const steps: agents.Step[] = []
  if (profiles === null) steps.push(...(await uninstallAgents(options)))
  for (const profile of profiles ?? []) {
    const scoped = { ...options, ctx: { ...ctx, env: envFor(profile, 'all', ctx.env) } }
    steps.push(...(await uninstallAgents(profile.builtin ? scoped : { ...scoped, harnesses: ['claude', 'codex'] })))
  }
  await rm(nurseryDataDir(ctx), { recursive: true, force: true })
  return { unregistered: await unregister(options.ctx), steps }
}

export type MemoryState = 'current' | 'stale' | 'missing' | 'legacy'

export interface MemoryReport {
  agent: MemoryAgent
  file: string
  state: MemoryState
}

export async function checkMemory(selection: AgentSelection, options: agents.InstallOptions = {}): Promise<MemoryReport[]> {
  const rules = await currentRules(options.ctx)
  const targets = (await resolveSelection(selection, options)).filter((agent): agent is MemoryAgent => agent !== 'claude-desktop')
  const reports: MemoryReport[] = []
  for (const agent of targets) {
    const file = memoryPath(agent, options)
    const text = existsSync(file) ? await readFile(file, 'utf8') : ''
    const block = agents.memoryBlock(text, TOOL)
    const expected = agents.renderMemory(rules, agent).trim()
    const state: MemoryState = findLegacy(text) ? 'legacy' : block === null ? 'missing' : block === expected ? 'current' : 'stale'
    reports.push({ agent, file, state })
  }
  return reports
}
