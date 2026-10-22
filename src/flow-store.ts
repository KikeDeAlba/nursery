import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { FlowState } from './flow-types.ts'

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

const LOCK_RETRY_MS = 20
const LOCK_OWNER = 'owner'
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

async function lockOwner(lock: string): Promise<string | null> {
  try {
    return await readFile(path.join(lock, LOCK_OWNER), 'utf8')
  } catch {
    return null
  }
}

async function acquire(lock: string, token: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: DIR_MODE })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
  try {
    await writeFile(path.join(lock, LOCK_OWNER), token, { mode: FILE_MODE })
  } catch (error) {
    await rm(lock, { recursive: true, force: true })
    throw error
  }
  return true
}

async function breakStale(lock: string, token: string, staleMs: number): Promise<void> {
  const grave = `${lock}.${token}.stale`
  try {
    await rename(lock, grave)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  const info = await stat(grave)
  if (Date.now() - info.mtimeMs <= staleMs) {
    try {
      await rename(grave, lock)
      return
    } catch {
      await rm(grave, { recursive: true, force: true })
      return
    }
  }
  await rm(grave, { recursive: true, force: true })
}

export async function withSessionLock<T>(file: string, fn: () => Promise<T>, { timeoutMs = 4000, staleMs = 10000 }: LockOptions = {}): Promise<T> {
  const lock = `${file}.lock`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  await mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE })
  const started = Date.now()
  for (;;) {
    if (await acquire(lock, token)) break
    try {
      const info = await stat(lock)
      if (Date.now() - info.mtimeMs > staleMs) {
        await breakStale(lock, token, staleMs)
        continue
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for ${lock}`)
    await sleep(LOCK_RETRY_MS)
  }
  try {
    return await fn()
  } finally {
    if ((await lockOwner(lock)) === token) await rm(lock, { recursive: true, force: true })
  }
}
