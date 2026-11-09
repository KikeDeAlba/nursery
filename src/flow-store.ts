import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '@kikedealba/kit/atomic'
import type { FlowState } from './flow-types.ts'

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

const LOCK_TIMEOUT_MS = 4000
const LOCK_STALE_MS = 2000
const LEGACY_LOCK_STALE_MS = 10_000
export const FILE_MODE = 0o600
export const DIR_MODE = 0o700

export function flowDir(geminiHome: string): string {
  return path.join(geminiHome, 'tmp', 'nursery-flow')
}

export function statePath(dir: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`)
  return path.join(dir, `${sessionId}.json`)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

const PHASES: readonly string[] = ['explore', 'proposed', 'accepted', 'done']

export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function loadState(file: string, plansDir?: string): Promise<FlowState | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const state = value as Partial<FlowState>
  if (state.version !== 1) return null
  if (state.sessionId !== path.basename(file, '.json')) return null
  if (typeof state.phase !== 'string' || !PHASES.includes(state.phase)) return null
  if (typeof state.planPath !== 'string') return null
  if (plansDir !== undefined && state.phase !== 'done' && !isInside(plansDir, state.planPath)) return null
  return state as FlowState
}

export async function saveState(file: string, state: FlowState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export interface LockOptions {
  timeoutMs?: number
  staleMs?: number
}

export function sessionLockPath(file: string): string {
  return `${file}.session.lock`
}

async function removeLegacyLocks(file: string): Promise<void> {
  for (const legacy of [`${file}.lock`, `${file}.lock.break`]) {
    const info = await lstat(legacy).catch(() => null)
    if (info?.isDirectory() && Date.now() - info.mtimeMs > LEGACY_LOCK_STALE_MS) await rm(legacy, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function withSessionLock<T>(file: string, fn: () => Promise<T>, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS }: LockOptions = {}): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE })
  return withFileLock(`${file}.session`, async () => {
    await removeLegacyLocks(file)
    return fn()
  }, { timeoutMs, staleMs })
}
