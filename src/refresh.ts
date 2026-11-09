import { agents } from '@kikedealba/kit'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { PROFILE_HARNESSES, envFor, getProfile, listProfiles, type Profile } from '@kikedealba/kit/profiles'
import { renderNursery, type RenderedNursery } from './render.ts'
import { installAgents, type AgentSelection, type MemoryAgent, type SetupOptions } from './setup.ts'
import type { InvalidUserAgent } from './user-agents.ts'

export interface ProfileRefresh {
  profile: string
  builtin: boolean
  agents: MemoryAgent[]
  steps: agents.Step[]
}

export interface RefreshResult {
  marketplace: string
  version: string
  agents: string[]
  userAgents: string[]
  invalidAgents: InvalidUserAgent[]
  profiles: ProfileRefresh[]
}

export interface RefreshOptions extends Omit<SetupOptions, 'rendered' | 'homes'> {
  profile?: string
}

function profileContext(profile: Profile, ctx: PlatformContext): PlatformContext {
  return { ...ctx, env: envFor(profile, 'all', ctx.env) }
}

async function detectByBinary(ctx: PlatformContext, options: RefreshOptions): Promise<agents.AgentName[]> {
  const locate = options.locate ?? ((command: string) => agents.findAgentBinary(command as agents.AgentName, { ctx }))
  const found: agents.AgentName[] = []
  for (const harness of PROFILE_HARNESSES) {
    const binary = agents.AGENT_BINARIES[harness]
    if (binary !== null && (await locate(binary)) !== null) found.push(harness)
  }
  return found
}

async function profileTargets(profile: Profile, selection: AgentSelection, ctx: PlatformContext, options: RefreshOptions): Promise<MemoryAgent[]> {
  let names: agents.AgentName[]
  if (selection === 'all') names = [...agents.AGENTS]
  else if (selection === 'detected' && profile.builtin) names = await agents.detectAgents(ctx, agents.agentHomes(ctx), options.locate)
  else if (selection === 'detected') names = await detectByBinary(ctx, options)
  else names = [...selection]
  const targets = names.filter((name): name is MemoryAgent => name !== 'claude-desktop')
  if (profile.builtin) return targets
  return targets.filter((name) => (PROFILE_HARNESSES as readonly string[]).includes(name) && profile[name as (typeof PROFILE_HARNESSES)[number]] !== null)
}

export async function refreshProfiles(selection: AgentSelection, options: RefreshOptions = {}): Promise<RefreshResult> {
  const ctx = options.ctx ?? platformContext()
  const profiles = options.profile !== undefined ? [await getProfile(options.profile, ctx)] : (await listProfiles(ctx)).profiles
  const rendered: RenderedNursery = await renderNursery(ctx, { strict: true })
  const results: ProfileRefresh[] = []
  for (const profile of profiles) {
    const scoped = profileContext(profile, ctx)
    const targets = await profileTargets(profile, selection, scoped, options)
    const steps = targets.length > 0 ? await installAgents(targets, { ...options, ctx: scoped, rendered }) : []
    results.push({ profile: profile.name, builtin: profile.builtin, agents: targets, steps })
  }
  return {
    marketplace: rendered.marketplace,
    version: rendered.version,
    agents: rendered.agents,
    userAgents: rendered.userAgents,
    invalidAgents: rendered.invalidAgents,
    profiles: results,
  }
}
