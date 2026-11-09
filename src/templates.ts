import { NURSERY_ROLES, RULE_FLAGS } from '@kikedealba/kit/settings'

export type RuleFlag = (typeof RULE_FLAGS)[number]

export interface TemplateConfig {
  maxParallel: number
  baseBranch: string
  rules: Record<RuleFlag, boolean>
  enabled: readonly string[]
}

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  maxParallel: 10,
  baseBranch: 'develop',
  rules: Object.fromEntries(RULE_FLAGS.map((flag) => [flag, true])) as Record<RuleFlag, boolean>,
  enabled: [...NURSERY_ROLES],
}

const RULE_OPEN = /^:::\s*rule\s+(\S+)\s*$/
const ANY_OPEN = /^:::\s*\S+.*$/
const CLOSE = /^:::\s*$/
const PLACEHOLDER = /\{\{\s*((?:agents|rules)\.[A-Za-z0-9.]+)\s*\}\}/g

function isRuleFlag(value: string): value is RuleFlag {
  return (RULE_FLAGS as readonly string[]).includes(value)
}

function applyRuleBlocks(text: string, rules: Record<RuleFlag, boolean>): string {
  const output: string[] = []
  const stack: { rule: boolean; keep: boolean }[] = []
  const keeping = (): boolean => stack.every((frame) => frame.keep)
  for (const [index, line] of text.split('\n').entries()) {
    const rule = RULE_OPEN.exec(line)
    if (rule) {
      const flag = rule[1] ?? ''
      if (!isRuleFlag(flag)) throw new Error(`unknown rule block "${flag}" on line ${index + 1}; use ${RULE_FLAGS.join(', ')}`)
      stack.push({ rule: true, keep: rules[flag] })
      continue
    }
    if (CLOSE.test(line) && stack.length > 0) {
      const frame = stack.pop()
      if (frame && !frame.rule && keeping()) output.push(line)
      continue
    }
    if (ANY_OPEN.test(line) && !CLOSE.test(line)) {
      if (keeping()) output.push(line)
      stack.push({ rule: false, keep: true })
      continue
    }
    if (keeping()) output.push(line)
  }
  if (stack.some((frame) => frame.rule)) throw new Error('unclosed rule block')
  return output.join('\n')
}

function placeholderValue(key: string, config: TemplateConfig): string {
  if (key === 'agents.maxParallel') return String(config.maxParallel)
  if (key === 'rules.baseBranch') return config.baseBranch
  if (key === 'agents.enabled') return config.enabled.join(', ')
  throw new Error(`unknown placeholder {{${key}}}`)
}

export function renderTemplate(text: string, config: TemplateConfig = DEFAULT_TEMPLATE_CONFIG): string {
  const blocks = applyRuleBlocks(text, config.rules)
  return blocks.replace(PLACEHOLDER, (_match, key: string) => placeholderValue(key, config)).replace(/\n{3,}/g, '\n\n')
}
