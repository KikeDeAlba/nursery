import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from './version.ts'

export const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src', 'agents')
export const CONVENTIONS_DIR = path.join(PACKAGE_ROOT, 'src', 'conventions')
export const AGENTS_DIR = path.join(PACKAGE_ROOT, 'agents')
export const RULES_FILE = path.join(PACKAGE_ROOT, 'rules', 'RULES.md')

const INCLUDE = /^@include\s+([a-z0-9-]+)\s*$/

export interface BuiltAgent {
  name: string
  content: string
}

export function renderAgent(source: string, fragments: ReadonlyMap<string, string>): string {
  const lines = source.split('\n').map((line) => {
    const match = INCLUDE.exec(line)
    if (!match) return line
    const fragment = fragments.get(match[1] ?? '')
    if (fragment === undefined) throw new Error(`unknown include: ${match[1]}`)
    return fragment.trim()
  })
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

async function markdownFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
}

export async function loadFragments(dir: string = CONVENTIONS_DIR): Promise<Map<string, string>> {
  const fragments = new Map<string, string>()
  for (const file of await markdownFiles(dir)) fragments.set(path.basename(file, '.md'), await readFile(path.join(dir, file), 'utf8'))
  return fragments
}

export async function buildAgents(sourceDir: string = SOURCE_DIR, conventionsDir: string = CONVENTIONS_DIR): Promise<BuiltAgent[]> {
  const fragments = await loadFragments(conventionsDir)
  const built: BuiltAgent[] = []
  for (const file of await markdownFiles(sourceDir)) {
    built.push({ name: path.basename(file, '.md'), content: renderAgent(await readFile(path.join(sourceDir, file), 'utf8'), fragments) })
  }
  return built
}

export async function staleAgents(built: readonly BuiltAgent[], outputDir: string = AGENTS_DIR): Promise<string[]> {
  const stale: string[] = []
  for (const agent of built) {
    const file = path.join(outputDir, `${agent.name}.md`)
    if (!existsSync(file) || (await readFile(file, 'utf8')) !== agent.content) stale.push(agent.name)
  }
  const expected = new Set(built.map((agent) => `${agent.name}.md`))
  if (existsSync(outputDir)) for (const file of await markdownFiles(outputDir)) if (!expected.has(file)) stale.push(path.basename(file, '.md'))
  return stale
}

export async function writeAgents(built: readonly BuiltAgent[], outputDir: string = AGENTS_DIR): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  for (const agent of built) await writeFile(path.join(outputDir, `${agent.name}.md`), agent.content)
}

export async function agentNames(outputDir: string = AGENTS_DIR): Promise<string[]> {
  return (await markdownFiles(outputDir)).map((file) => path.basename(file, '.md'))
}
