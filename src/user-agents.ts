import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { AGENT_EFFORTS, NURSERY_ROLES, USER_AGENT_NAME_PATTERN, userAgentsDir } from '@kikedealba/kit/settings'
import { renderAgent, type BuiltAgent } from './build.ts'

export const USER_AGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'Skill', 'WebFetch', 'WebSearch'] as const

export const USER_AGENT_DESCRIPTION_MAX = 300

const MODEL_PATTERN = /^[a-z0-9.\-[\]]+$/

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
  attributes: Record<string, string>
}

export interface UserAgents {
  valid: UserAgent[]
  invalid: InvalidUserAgent[]
}

export function validateUserAgent(fileName: string, text: string, fragments: ReadonlyMap<string, string> = new Map()): UserAgentValidation {
  const errors: string[] = []
  const name = fileName.replace(/\.md$/, '')
  if (!text.startsWith('---\n') || text.indexOf('\n---', 4) === -1) return { ok: false, errors: ['missing frontmatter'] }
  const { attributes, body } = agents.parseFrontmatter(text)
  const declared = attributes['name'] ?? ''
  if (!USER_AGENT_NAME_PATTERN.test(declared)) errors.push(`name must match ${USER_AGENT_NAME_PATTERN.source}`)
  if (declared !== name) errors.push(`name "${declared}" must match the file name "${name}"`)
  if ((NURSERY_ROLES as readonly string[]).includes(declared)) errors.push(`name "${declared}" is a nursery role`)
  const description = attributes['description'] ?? ''
  if (description.trim().length === 0) errors.push('description is required')
  if (description.length > USER_AGENT_DESCRIPTION_MAX) errors.push(`description has ${description.length} characters; the limit is ${USER_AGENT_DESCRIPTION_MAX}`)
  const tools = (attributes['tools'] ?? '').split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0)
  const unknownTools = tools.filter((tool) => !(USER_AGENT_TOOLS as readonly string[]).includes(tool))
  if (unknownTools.length > 0) errors.push(`unknown tools: ${unknownTools.join(', ')}; use ${USER_AGENT_TOOLS.join(', ')}`)
  const model = attributes['model']
  if (model !== undefined && !MODEL_PATTERN.test(model)) errors.push(`model must match ${MODEL_PATTERN.source}`)
  const effort = attributes['effort']
  if (effort !== undefined && !(AGENT_EFFORTS as readonly string[]).includes(effort)) errors.push(`effort must be one of ${AGENT_EFFORTS.join(', ')}`)
  const maxTurns = attributes['maxTurns']
  if (maxTurns !== undefined) {
    const turns = /^\d+$/.test(maxTurns) ? Number.parseInt(maxTurns, 10) : Number.NaN
    if (!(turns >= 1 && turns <= 500)) errors.push('maxTurns must be an integer from 1 to 500')
  }
  if (body.trim().length === 0) errors.push('body is empty')
  else {
    try {
      renderAgent(text, fragments)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: errors.length === 0, errors }
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
    const text = await readFile(full, 'utf8')
    const validation = validateUserAgent(file, text, fragments)
    if (!validation.ok) {
      result.invalid.push({ name, file: full, errors: validation.errors })
      continue
    }
    result.valid.push({ name, file: full, content: renderAgent(text, fragments), attributes: agents.parseFrontmatter(text).attributes })
  }
  return result
}
