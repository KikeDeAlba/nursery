import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { NURSERY_ROLES, SETTING_DEFS, USER_AGENT_NAME_PATTERN, parseSettingValue, userAgentsDir } from '@kikedealba/kit/settings'
import { renderAgent, type BuiltAgent } from './build.ts'

export const USER_AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Skill', 'WebFetch', 'WebSearch'] as const

export const USER_AGENT_FIELDS = ['name', 'description', 'tools', 'model', 'effort', 'maxTurns', 'source', 'createdAt'] as const

export const USER_AGENT_DESCRIPTION_MAX = 300

export const RESERVED_AGENT_NAMES: readonly string[] = [
  ...new Set(
    SETTING_DEFS.map((def) => def.pattern.split('.'))
      .filter((parts) => parts.length === 2 && parts[0] === 'agents')
      .map((parts) => (parts[1] ?? '').toLowerCase()),
  ),
]

const SETTINGS_PROBE = 'user-agent'
const PUBLISHED_FIELDS = ['name', 'description', 'tools', 'model', 'effort', 'maxTurns'] as const
const FIELD_LINE = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(.*))?$/
const PLAIN_UNSAFE = /^[-?:,[\]{}#&*!|>'"%@`\s]|: | #|\s$/

export type UserAgentField = (typeof USER_AGENT_FIELDS)[number]

export interface UserAgentValidation {
  ok: boolean
  errors: string[]
}

export interface InvalidUserAgent {
  name: string
  file: string
  errors: string[]
}

export interface UserAgent extends BuiltAgent {
  file: string
  attributes: Partial<Record<UserAgentField, string>>
}

export interface UserAgents {
  valid: UserAgent[]
  invalid: InvalidUserAgent[]
}

interface ParsedUserAgent {
  attributes: Partial<Record<UserAgentField, string>>
  body: string
  errors: string[]
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return quoted ? (quoted[1] ?? '') : value
}

function parseUserAgent(raw: string): ParsedUserAgent {
  const text = raw.replace(/\r\n/g, '\n')
  const errors: string[] = []
  if (!text.startsWith('---\n')) return { attributes: {}, body: '', errors: ['missing frontmatter'] }
  const end = text.indexOf('\n---\n', 3)
  const close = end === -1 && text.endsWith('\n---') ? text.length - 4 : end
  if (close === -1) return { attributes: {}, body: '', errors: ['missing frontmatter'] }
  const attributes: Partial<Record<UserAgentField, string>> = {}
  for (const line of text.slice(4, close).split('\n')) {
    if (line.trim().length === 0) continue
    const match = FIELD_LINE.exec(line)
    if (!match) {
      errors.push(`unsupported frontmatter line: ${JSON.stringify(line)}`)
      continue
    }
    const key = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    if (!(USER_AGENT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`unknown frontmatter key "${key}"; use ${USER_AGENT_FIELDS.join(', ')}`)
      continue
    }
    if (key in attributes) {
      errors.push(`duplicate frontmatter key "${key}"`)
      continue
    }
    if (/^[|>]/.test(value)) {
      errors.push(`"${key}" uses a block scalar; write it on one line`)
      continue
    }
    attributes[key as UserAgentField] = unquote(value)
  }
  const rest = text.slice(close + 4)
  return { attributes, body: rest.startsWith('\n') ? rest.slice(1) : rest, errors }
}

function yamlValue(value: string): string | null {
  if (!PLAIN_UNSAFE.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`
  return null
}

function rebuild(attributes: Partial<Record<UserAgentField, string>>, body: string): { text: string; errors: string[] } {
  const errors: string[] = []
  const lines = ['---']
  for (const field of PUBLISHED_FIELDS) {
    const value = attributes[field]
    if (value === undefined) continue
    const safe = yamlValue(value)
    if (safe === null) errors.push(`${field} mixes single and double quotes or backslashes and cannot be written safely`)
    else lines.push(`${field}: ${safe}`)
  }
  lines.push('---')
  return { text: `${lines.join('\n')}\n${body}`, errors }
}

function checkAttributes(name: string, attributes: Partial<Record<UserAgentField, string>>, body: string): string[] {
  const errors: string[] = []
  const declared = attributes.name ?? ''
  if (!USER_AGENT_NAME_PATTERN.test(declared)) errors.push(`name must match ${USER_AGENT_NAME_PATTERN.source}`)
  if (declared !== name) errors.push(`name "${declared}" must match the file name "${name}"`)
  if ((NURSERY_ROLES as readonly string[]).includes(declared)) errors.push(`name "${declared}" is a nursery role`)
  if (RESERVED_AGENT_NAMES.includes(declared.toLowerCase())) errors.push(`name "${declared}" is reserved by the agents settings`)
  const description = attributes.description ?? ''
  if (description.trim().length === 0) errors.push('description is required')
  if (description.length > USER_AGENT_DESCRIPTION_MAX) errors.push(`description has ${description.length} characters; the limit is ${USER_AGENT_DESCRIPTION_MAX}`)
  if (attributes.tools !== undefined) {
    const tools = attributes.tools.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0)
    if (tools.length === 0) errors.push('tools is empty; list at least one tool or drop the key')
    const unknownTools = tools.filter((tool) => !(USER_AGENT_TOOLS as readonly string[]).includes(tool))
    if (unknownTools.length > 0) errors.push(`unknown tools: ${unknownTools.join(', ')}; use ${USER_AGENT_TOOLS.join(', ')}`)
    if (new Set(tools).size !== tools.length) errors.push('tools has duplicates')
  }
  for (const field of ['model', 'effort', 'maxTurns'] as const) {
    const value = attributes[field]
    if (value === undefined) continue
    if (field === 'maxTurns' && !/^\d+$/.test(value)) {
      errors.push('maxTurns must be an integer from 1 to 500')
      continue
    }
    try {
      parseSettingValue(`agents.${SETTINGS_PROBE}.${field}`, value)
    } catch (error) {
      errors.push(`${field}: ${(error instanceof Error ? error.message : String(error)).replace(`agents.${SETTINGS_PROBE}.`, '')}`)
    }
  }
  if (body.trim().length === 0) errors.push('body is empty')
  return errors
}

function compile(fileName: string, raw: string, fragments: ReadonlyMap<string, string>): { errors: string[]; content: string; attributes: Partial<Record<UserAgentField, string>> } {
  const name = fileName.replace(/\.md$/, '')
  const parsed = parseUserAgent(raw)
  if (parsed.errors.includes('missing frontmatter')) return { errors: parsed.errors, content: '', attributes: {} }
  const errors = [...parsed.errors, ...checkAttributes(name, parsed.attributes, parsed.body)]
  const rebuilt = rebuild(parsed.attributes, parsed.body)
  errors.push(...rebuilt.errors)
  let content = ''
  if (errors.length === 0) {
    try {
      content = renderAgent(rebuilt.text, fragments)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { errors, content, attributes: parsed.attributes }
}

export function validateUserAgent(fileName: string, text: string, fragments: ReadonlyMap<string, string> = new Map()): UserAgentValidation {
  const { errors } = compile(fileName, text, fragments)
  return { ok: errors.length === 0, errors }
}

function readError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EISDIR') return 'is a directory, not a file'
  if (code === 'ENOENT') return 'cannot be read: it is a broken symbolic link'
  return `cannot be read: ${error instanceof Error ? error.message : String(error)}`
}

export async function loadUserAgents(fragments: ReadonlyMap<string, string>, ctx: PlatformContext = platformContext()): Promise<UserAgents> {
  const dir = userAgentsDir(ctx)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return { valid: [], invalid: [] }
  }
  const result: UserAgents = { valid: [], invalid: [] }
  for (const file of files) {
    const full = path.join(dir, file)
    const name = path.basename(file, '.md')
    let text: string
    try {
      if ((await stat(full)).isDirectory()) throw Object.assign(new Error('directory'), { code: 'EISDIR' })
      text = await readFile(full, 'utf8')
    } catch (error) {
      result.invalid.push({ name, file: full, errors: [readError(error)] })
      continue
    }
    const compiled = compile(file, text, fragments)
    if (compiled.errors.length > 0) result.invalid.push({ name, file: full, errors: compiled.errors })
    else result.valid.push({ name, file: full, content: compiled.content, attributes: compiled.attributes })
  }
  return result
}
