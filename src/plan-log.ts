import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Phase, PlanLogEntry } from './flow-types.ts'
import { MAX_VALIDATION_RETRIES } from './flow.ts'

export const PHASE_LABEL: Record<Phase | 'replaced', string> = {
  explore: 'explorar',
  proposed: 'propuesta en revisión',
  accepted: 'aceptada, en ejecución',
  done: 'terminada',
  replaced: 'reemplazada por otro /nursery',
}

const TITLE_MAX = 80

export function defaultPlansDir(env: NodeJS.ProcessEnv, geminiHome: string): string {
  return env['NURSERY_PLANS_DIR'] || path.join(geminiHome, 'nursery', 'plans')
}

interface GitLocation {
  project: string
  gitDir: string
}

function findGit(cwd: string): GitLocation | null {
  let dir = path.resolve(cwd)
  for (;;) {
    const candidate = path.join(dir, '.git')
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return { project: path.basename(dir), gitDir: candidate }
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(candidate, 'utf8'))
        if (match?.[1]) {
          const gitDir = path.resolve(dir, match[1])
          const worktree = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitDir)
          return { project: path.basename(worktree?.[1] ?? dir), gitDir }
        }
      } catch {
        return null
      }
      return { project: path.basename(dir), gitDir: candidate }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function projectName(cwd: string): string {
  const raw = findGit(cwd)?.project ?? path.basename(path.resolve(cwd))
  const clean = raw.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '')
  return clean.length > 0 ? clean : 'proyecto'
}

export function currentBranch(cwd: string): string | null {
  const git = findGit(cwd)
  if (!git) return null
  try {
    const head = readFileSync(path.join(git.gitDir, 'HEAD'), 'utf8')
    return /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null
  } catch {
    return null
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(at: string): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function day(at: string): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function title(request: string): string {
  const first = request.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return first.length > 0 ? first.slice(0, TITLE_MAX) : 'Pedido sin texto'
}

function createText(entry: Extract<PlanLogEntry, { kind: 'create' }>): string {
  const request = entry.request.trim()
  return [
    `# ${title(request)}`,
    '',
    `- Fase: ${PHASE_LABEL.explore}`,
    `- Inicio: ${day(entry.at)} ${clock(entry.at)}`,
    `- Repo: ${projectName(entry.cwd)} (${entry.cwd})`,
    `- Rama: ${currentBranch(entry.cwd) ?? 'sin git'}`,
    `- Sesión: ${entry.sessionId}`,
    '',
    '## Pedido',
    '',
    request.length > 0 ? request : '(vacío)',
    '',
    '## Bitácora',
    '',
  ].join('\n')
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

function via(value: 'dialog' | 'text'): string {
  return value === 'text' ? ', por texto' : ''
}

function agentLine(entry: Extract<PlanLogEntry, { kind: 'agent' }>): string {
  const outcome = entry.outcome === 'goal' ? 'terminó' : entry.outcome === 'partial' ? `terminó incompleto (${entry.detail})` : `falló: ${entry.detail}`
  return `- ${clock(entry.at)} \`${entry.agent}\`: ${entry.task} — ${outcome}\n`
}

function validationLine(entry: Extract<PlanLogEntry, { kind: 'validation' }>): string {
  const yes = (done: boolean) => (done ? 'sí' : 'no')
  const result =
    entry.result === 'done'
      ? 'terminada'
      : entry.result === 'retry'
        ? `reintento ${entry.attempt} de ${MAX_VALIDATION_RETRIES}`
        : `sin validar tras ${MAX_VALIDATION_RETRIES} reintentos`
  return `- ${clock(entry.at)} Validación: qa-automation ${yes(entry.qa)}, code-reviewer ${yes(entry.review)} — ${result}\n`
}

async function applyEntry(entry: PlanLogEntry): Promise<void> {
  switch (entry.kind) {
    case 'create': {
      if (existsSync(entry.file)) {
        await appendFile(entry.file, `\n## Reinicio (${clock(entry.at)})\n\n${entry.request.trim()}\n`)
        return
      }
      await mkdir(path.dirname(entry.file), { recursive: true })
      await writeFile(entry.file, createText(entry))
      return
    }
    case 'phase': {
      const text = await readFile(entry.file, 'utf8')
      await writeAtomic(entry.file, text.replace(/^- Fase: .*$/m, `- Fase: ${PHASE_LABEL[entry.phase]}`))
      return
    }
    case 'proposal':
      await appendFile(entry.file, `\n### Propuesta v${entry.version} (${clock(entry.at)})\n\n${entry.text}\n`)
      return
    case 'accepted':
      await appendFile(entry.file, `\n### Aceptada (${clock(entry.at)}${via(entry.via)})\n\n`)
      return
    case 'correction':
      await appendFile(entry.file, `\n### Corrección del usuario (${clock(entry.at)}${via(entry.via)})\n\n${entry.text.length > 0 ? entry.text : '(sin detalle)'}\n`)
      return
    case 'dismissed':
      await appendFile(entry.file, `\n### Diálogo cerrado sin respuesta (${clock(entry.at)})\n`)
      return
    case 'agent':
      await appendFile(entry.file, agentLine(entry))
      return
    case 'validation':
      await appendFile(entry.file, validationLine(entry))
      return
    case 'replaced':
      await appendFile(entry.file, `\n### Reemplazado por un /nursery nuevo (${clock(entry.at)})\n`)
      return
  }
}

export async function applyPlanLog(entries: readonly PlanLogEntry[]): Promise<void> {
  for (const entry of entries) {
    try {
      await applyEntry(entry)
    } catch (error) {
      process.stderr.write(`nursery plan-log: ${entry.kind} ${entry.file}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}
