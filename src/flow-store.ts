import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { FlowState } from './flow-types.ts'

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

const LOCK_RETRY_MS = 20

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

export async function loadState(file: string): Promise<FlowState | null> {
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
  return state as FlowState
}

export async function saveState(file: string, state: FlowState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
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

export async function withSessionLock<T>(file: string, fn: () => Promise<T>, { timeoutMs = 4000, staleMs = 10000 }: LockOptions = {}): Promise<T> {
  const lock = `${file}.lock`
  await mkdir(path.dirname(file), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    try {
      const info = await stat(lock)
      if (Date.now() - info.mtimeMs > staleMs) {
        await rm(lock, { recursive: true, force: true })
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
    await rm(lock, { recursive: true, force: true })
  }
}
