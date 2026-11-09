import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { NURSERY_ROLES, RULE_FLAGS, getSettingEntry, type SettingValue } from '@kikedealba/kit/settings'
import { READ_ONLY_ROLES, type RuleFlag, type TemplateConfig } from './templates.ts'

export const OVERRIDE_FIELDS = ['model', 'maxTurns', 'effort'] as const

export type OverrideField = (typeof OVERRIDE_FIELDS)[number]

export type AgentOverrides = Partial<Record<OverrideField, string>>

export interface NurseryConfig extends TemplateConfig {
  overrides: Record<string, AgentOverrides>
}

async function userValue(key: string, ctx: PlatformContext): Promise<SettingValue | undefined> {
  const entry = await getSettingEntry(key, ctx)
  return entry.source === 'user' ? entry.value : undefined
}

async function value<T extends SettingValue>(key: string, fallback: T, ctx: PlatformContext): Promise<T> {
  const entry = await getSettingEntry(key, ctx)
  return (entry.value ?? fallback) as T
}

export async function loadConfig(userAgents: readonly string[], ctx: PlatformContext = platformContext()): Promise<NurseryConfig> {
  const roles = [...NURSERY_ROLES, ...userAgents]
  const rules = {} as Record<RuleFlag, boolean>
  for (const flag of RULE_FLAGS) rules[flag] = await value(`rules.${flag}`, true, ctx)
  const enabledSetting = await userValue('agents.enabled', ctx)
  const wanted = Array.isArray(enabledSetting) ? new Set(enabledSetting) : null
  const enabled = roles.filter((role) => wanted === null || wanted.has(role))
  const overrides: Record<string, AgentOverrides> = {}
  for (const role of roles) {
    const fields: AgentOverrides = {}
    for (const field of OVERRIDE_FIELDS) {
      const set = await userValue(`agents.${role}.${field}`, ctx)
      if (set !== undefined) fields[field] = String(set)
    }
    if (Object.keys(fields).length > 0) overrides[role] = fields
  }
  return {
    maxParallel: await value('agents.maxParallel', 10, ctx),
    baseBranch: await value('rules.baseBranch', 'develop', ctx),
    rules,
    enabled,
    readOnly: READ_ONLY_ROLES,
    overrides,
  }
}
