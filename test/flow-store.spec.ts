import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { flowDir, loadState, saveState, statePath, withSessionLock } from '../src/flow-store.ts'
import type { FlowState } from '../src/flow-types.ts'

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nursery-flow-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function sampleState(sessionId: string): FlowState {
  return {
    version: 1,
    sessionId,
    cwd: '/repo',
    request: 'agrega el endpoint',
    planPath: '/plans/repo/2026-10-22-1000-agrega-el-endpoint.md',
    phase: 'explore',
    startedAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    activeAgents: 0,
    researched: false,
    reads: { used: 0, limit: 8 },
    proposals: 0,
    corrections: 0,
    changed: false,
    validation: { qa: false, review: false },
    retries: { validation: 0, gaveUp: false },
  }
}

test('flowDir and statePath place one json file per session under the gemini tmp dir', () => {
  assert.equal(flowDir('/home/u/.gemini'), path.join('/home/u/.gemini', 'tmp', 'nursery-flow'))
  assert.equal(statePath('/d', 'abc-1.2_3'), path.join('/d', 'abc-1.2_3.json'))
})

test('statePath rejects session ids that could escape the directory', () => {
  for (const id of ['', '../x', 'a/b', 'a\\b', 'a b', 'x'.repeat(129)]) {
    assert.throws(() => statePath('/d', id), /invalid session id/, JSON.stringify(id))
  }
  assert.doesNotThrow(() => statePath('/d', 'x'.repeat(128)))
})

test('saveState writes atomically and loadState reads it back', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(path.join(dir, 'nested', 'flow'), 's1')
  const state = sampleState('s1')
  await saveState(file, state)
  assert.deepEqual(await loadState(file), state)
  assert.deepEqual(await readdir(path.dirname(file)), ['s1.json'])

  const next = { ...state, phase: 'proposed' as const, proposals: 1 }
  await saveState(file, next)
  assert.deepEqual(await loadState(file), next)
  assert.deepEqual(await readdir(path.dirname(file)), ['s1.json'])
})

test('loadState returns null for a missing, corrupt, other-version or other-session file', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  assert.equal(await loadState(file), null)

  await writeFile(file, '{not json')
  assert.equal(await loadState(file), null)

  await writeFile(file, 'null')
  assert.equal(await loadState(file), null)

  await writeFile(file, JSON.stringify({ ...sampleState('s1'), version: 2 }))
  assert.equal(await loadState(file), null)

  await writeFile(file, JSON.stringify(sampleState('s2')))
  assert.equal(await loadState(file), null)
})

test('withSessionLock runs the callbacks one at a time and releases the lock', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(path.join(dir, 'flow'), 's1')
  const order: string[] = []
  const run = (name: string) =>
    withSessionLock(file, async () => {
      order.push(`${name}:in`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push(`${name}:out`)
      return name
    })
  assert.deepEqual(await Promise.all([run('a'), run('b')]), ['a', 'b'])
  assert.equal(order.length, 4)
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i]?.replace(':in', ':out'), order[i + 1])
  assert.ok(!existsSync(`${file}.lock`))
})

test('withSessionLock releases the lock when the callback throws', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await assert.rejects(withSessionLock(file, async () => { throw new Error('boom') }), /boom/)
  assert.ok(!existsSync(`${file}.lock`))
})

test('withSessionLock removes a stale lock and goes ahead', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await mkdir(`${file}.lock`)
  const old = new Date(Date.now() - 60_000)
  await utimes(`${file}.lock`, old, old)
  assert.equal(await withSessionLock(file, async () => 'ran', { timeoutMs: 200, staleMs: 10_000 }), 'ran')
  assert.ok(!existsSync(`${file}.lock`))
})

test('withSessionLock gives up after the timeout while a fresh lock is held', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await mkdir(`${file}.lock`)
  let ran = false
  const started = Date.now()
  await assert.rejects(withSessionLock(file, async () => { ran = true }, { timeoutMs: 100, staleMs: 10_000 }), /timed out/)
  assert.ok(Date.now() - started >= 100)
  assert.equal(ran, false)
  assert.ok(existsSync(`${file}.lock`))
  assert.equal(await readFile(path.join(dir, 's1.json'), 'utf8').catch(() => null), null)
})
