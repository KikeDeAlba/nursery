import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import { PACKAGE_ROOT } from './version.ts'

export const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src', 'agents')
export const CONVENTIONS_DIR = path.join(PACKAGE_ROOT, 'src', 'conventions')
export const AGENTS_DIR = path.join(PACKAGE_ROOT, 'agents')
export const SUBAGENTS_DIR = path.join(PACKAGE_ROOT, 'subagents')
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

function claudeAgent(content: string): string {
  return agents.renderForAgent(content, 'claude')
}

function outputs(built: readonly BuiltAgent[], agentsDir: string, subagentsDir: string): { dir: string; files: Map<string, string> }[] {
  return [
    { dir: agentsDir, files: new Map(built.map((agent) => [`${agent.name}.md`, claudeAgent(agent.content)])) },
    { dir: subagentsDir, files: new Map(built.map((agent) => [`${agent.name}.md`, agent.content])) },
  ]
}

export async function staleAgents(built: readonly BuiltAgent[], agentsDir: string = AGENTS_DIR, subagentsDir: string = SUBAGENTS_DIR): Promise<string[]> {
  const stale: string[] = []
  for (const { dir, files } of outputs(built, agentsDir, subagentsDir)) {
    const label = (file: string): string => `${path.basename(dir)}/${path.basename(file, '.md')}`
    for (const [file, content] of files) {
      const target = path.join(dir, file)
      if (!existsSync(target) || (await readFile(target, 'utf8')) !== content) stale.push(label(file))
    }
    if (existsSync(dir)) for (const file of await markdownFiles(dir)) if (!files.has(file)) stale.push(label(file))
  }
  return stale
}

export async function writeAgents(built: readonly BuiltAgent[], agentsDir: string = AGENTS_DIR, subagentsDir: string = SUBAGENTS_DIR): Promise<void> {
  for (const { dir, files } of outputs(built, agentsDir, subagentsDir)) {
    await mkdir(dir, { recursive: true })
    for (const [file, content] of files) await writeFile(path.join(dir, file), content)
  }
}

export async function agentNames(outputDir: string = AGENTS_DIR): Promise<string[]> {
  return (await markdownFiles(outputDir)).map((file) => path.basename(file, '.md'))
}
