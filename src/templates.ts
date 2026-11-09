import { NURSERY_ROLES, RULE_FLAGS } from '@kikedealba/kit/settings'

export type RuleFlag = (typeof RULE_FLAGS)[number]

export interface TemplateConfig {
  maxParallel: number
  baseBranch: string
  rules: Record<RuleFlag, boolean>
  enabled: readonly string[]
  readOnly: readonly string[]
}

export const READ_ONLY_ROLES: readonly string[] = ['researcher', 'analyst', 'architect', 'sre', 'security', 'code-reviewer']

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  maxParallel: 10,
  baseBranch: 'develop',
  rules: Object.fromEntries(RULE_FLAGS.map((flag) => [flag, true])) as Record<RuleFlag, boolean>,
  enabled: [...NURSERY_ROLES],
  readOnly: READ_ONLY_ROLES,
}

const BLOCK_OPEN = /^:::\s*(rule|role)\s+(.+?)\s*$/
const ANY_OPEN = /^:::\s*\S+.*$/
const CLOSE = /^:::\s*$/
const PLACEHOLDER = /\{\{((?:agents|rules)\.[A-Za-z0-9.]+)\}\}/g
const SPACED_PLACEHOLDER = /\{\{\s+(?:agents|rules)\.[^}]*\}\}|\{\{(?:agents|rules)\.[^}]*\s+\}\}/
const LINE_PLACEHOLDERS = new Set(['rules.afterImplementation'])

function isRuleFlag(value: string): value is RuleFlag {
  return (RULE_FLAGS as readonly string[]).includes(value)
}

function roleCondition(spec: string, enabled: readonly string[], line: number): boolean {
  const names = spec.split(/[\s,]+/).filter((name) => name.length > 0)
  if (names.length === 0) throw new Error(`empty role block on line ${line}`)
  return names.every((name) => (name.startsWith('!') ? !enabled.includes(name.slice(1)) : enabled.includes(name)))
}

function applyBlocks(text: string, config: TemplateConfig): string {
  const output: string[] = []
  const stack: { own: boolean; keep: boolean }[] = []
  const keeping = (): boolean => stack.every((frame) => frame.keep)
  for (const [index, line] of text.split('\n').entries()) {
    const block = BLOCK_OPEN.exec(line)
    if (block) {
      const spec = block[2] ?? ''
      if (block[1] === 'rule') {
        if (!isRuleFlag(spec)) throw new Error(`unknown rule block "${spec}" on line ${index + 1}; use ${RULE_FLAGS.join(', ')}`)
        stack.push({ own: true, keep: config.rules[spec] })
      } else stack.push({ own: true, keep: roleCondition(spec, config.enabled, index + 1) })
      continue
    }
    if (CLOSE.test(line) && stack.length > 0) {
      const frame = stack.pop()
      if (frame && !frame.own && keeping()) output.push(line)
      continue
    }
    if (ANY_OPEN.test(line) && !CLOSE.test(line)) {
      if (keeping()) output.push(line)
      stack.push({ own: false, keep: true })
      continue
    }
    if (keeping()) output.push(line)
  }
  if (stack.some((frame) => frame.own)) throw new Error('unclosed rule or role block')
  return output.join('\n')
}

function joinSpanish(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`
}

function afterImplementation(enabled: readonly string[]): string {
  const reviewers = ['qa-automation', 'code-reviewer'].filter((role) => enabled.includes(role))
  const security = enabled.includes('security')
  if (reviewers.length > 0) return `- Tras implementar, siempre ${joinSpanish(reviewers)} antes del MR${security ? '; si toca IAM, red, secretos o pagos, también security' : ''}.`
  if (security) return '- Tras implementar, si toca IAM, red, secretos o pagos, pasa por security antes del MR.'
  return ''
}

function parallelExample(enabled: readonly string[]): string {
  const developer = enabled.includes('developer')
  const devops = enabled.includes('devops')
  if (developer && devops) return ': dos developer en módulos distintos, o developer y devops en repos distintos'
  if (developer) return ': dos developer en módulos distintos'
  if (devops) return ': dos devops en repos distintos'
  return ''
}

const EXAMPLE_ROLES = ['researcher', 'developer', 'code-reviewer']

function examples(enabled: readonly string[]): string[] {
  const preferred = EXAMPLE_ROLES.filter((name) => enabled.includes(name))
  return [...preferred, ...enabled.filter((name) => !preferred.includes(name))].slice(0, 3)
}

function placeholderValue(key: string, config: TemplateConfig): string {
  const readOnly = config.readOnly.filter((name) => config.enabled.includes(name))
  if (key === 'agents.maxParallel') return String(config.maxParallel)
  if (key === 'rules.baseBranch') return config.baseBranch
  if (key === 'agents.enabled') return config.enabled.join(', ')
  if (key === 'agents.examples') return `${examples(config.enabled).map((name) => `\`${name}\``).join(', ')}…`
  if (key === 'agents.readOnlyList') return readOnly.length > 0 ? ` (${readOnly.join(', ')})` : ''
  if (key === 'agents.planAllowed') return readOnly.join('|')
  if (key === 'rules.afterImplementation') return afterImplementation(config.enabled)
  if (key === 'rules.parallelExample') return parallelExample(config.enabled)
  throw new Error(`unknown placeholder {{${key}}}`)
}

function dropEmptyLinePlaceholders(text: string, config: TemplateConfig): string {
  return text
    .split('\n')
    .filter((line) => {
      const match = /^\{\{([A-Za-z0-9.]+)\}\}$/.exec(line.trim())
      return !(match && LINE_PLACEHOLDERS.has(match[1] ?? '') && placeholderValue(match[1] ?? '', config) === '')
    })
    .join('\n')
}

export function renderTemplate(text: string, config: TemplateConfig = DEFAULT_TEMPLATE_CONFIG): string {
  const spaced = SPACED_PLACEHOLDER.exec(text)
  if (spaced) throw new Error(`placeholders cannot contain spaces: ${spaced[0]}`)
  const blocks = dropEmptyLinePlaceholders(applyBlocks(text, config), config)
  return blocks.replace(PLACEHOLDER, (_match, key: string) => placeholderValue(key, config)).replace(/\n{3,}/g, '\n\n')
}
