import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { agents } from '@kikedealba/kit'
import { successEnvelope, writeJson } from '@kikedealba/kit/envelope'
import { agentNames, buildAgents, staleAgents, writeAgents, AGENTS_DIR } from './build.ts'
import { checkMemory, installAgents, uninstallAgents, type AgentSelection } from './setup.ts'
import { SCHEMA_VERSION, VERSION } from './version.ts'

const HELP = `nursery ${VERSION}

Uso:
  nursery setup [--agents claude,opencode,codex,gemini|all|detected] [--replace-legacy] [--json]
  nursery uninstall [--json]
  nursery check [--agents ...] [--json]
  nursery list [--json]
  nursery build [--check]
  nursery --version`

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function readAgents(raw: string | undefined): AgentSelection {
  if (raw === undefined || raw === 'detected') return 'detected'
  if (raw === 'all') return 'all'
  const names = raw.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  const unknown = names.filter((name) => !(agents.AGENTS as readonly string[]).includes(name))
  if (unknown.length > 0) throw new Error(`Unknown agent: ${unknown.join(', ')}. Use ${agents.AGENTS.join(', ')}, all or detected.`)
  return names as agents.AgentName[]
}

function printSteps(steps: readonly agents.Step[]): void {
  for (const step of steps) out(`${step.state === 'failed' || step.state === 'unavailable' || step.item === 'legacy rules' ? '!' : '-'} ${step.agent}: ${step.detail}`)
}

async function setup(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { agents: { type: 'string' }, 'replace-legacy': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } } })
  const steps = await installAgents(readAgents(values.agents), { replaceLegacy: values['replace-legacy'] })
  if (values.json) writeJson(successEnvelope(SCHEMA_VERSION, 'setup', { steps }))
  else printSteps(steps)
  return steps.some((step) => step.state === 'failed') ? 1 : 0
}

async function uninstall(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean', default: false } } })
  const steps = await uninstallAgents()
  if (values.json) writeJson(successEnvelope(SCHEMA_VERSION, 'uninstall', { steps }))
  else printSteps(steps.filter((step) => step.state === 'removed'))
  return 0
}

async function check(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { agents: { type: 'string' }, json: { type: 'boolean', default: false } } })
  const reports = await checkMemory(readAgents(values.agents))
  if (values.json) writeJson(successEnvelope(SCHEMA_VERSION, 'check', { memory: reports }))
  else for (const report of reports) out(`${report.state === 'current' ? '-' : '!'} ${report.agent}: ${report.state} (${report.file})`)
  return reports.every((report) => report.state === 'current') ? 0 : 1
}

async function list(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean', default: false } } })
  const rows = await Promise.all(
    (await agentNames()).map(async (name) => {
      const { attributes } = agents.parseFrontmatter(await readFile(path.join(AGENTS_DIR, `${name}.md`), 'utf8'))
      return { name, model: attributes['model'] ?? 'inherit', effort: attributes['effort'] ?? '', description: attributes['description'] ?? '' }
    }),
  )
  if (values.json) writeJson(successEnvelope(SCHEMA_VERSION, 'list', { agents: rows }))
  else for (const row of rows) out(`${row.name.padEnd(14)} ${`${row.model}/${row.effort}`.padEnd(24)} ${row.description}`)
  return 0
}

async function build(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean', default: false } } })
  const built = await buildAgents()
  const stale = await staleAgents(built)
  if (values.check) {
    if (stale.length > 0) out(`! out of date: ${stale.join(', ')}. Run: pnpm build:agents`)
    return stale.length > 0 ? 1 : 0
  }
  await writeAgents(built)
  out(`- ${built.length} agents written to ${AGENTS_DIR}`)
  return 0
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === '--version' || command === '-v') {
      out(VERSION)
      return 0
    }
    if (command === 'setup') return await setup(rest)
    if (command === 'uninstall') return await uninstall(rest)
    if (command === 'check') return await check(rest)
    if (command === 'list') return await list(rest)
    if (command === 'build') return await build(rest)
    out(HELP)
    return command === undefined || command === 'help' || command === '--help' ? 0 : 2
  } catch (error) {
    process.stderr.write(`nursery: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
