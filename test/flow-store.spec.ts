import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { flowDir, loadState, saveState, sessionLockPath, statePath, withSessionLock } from '../src/flow-store.ts'
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

test('saveState keeps the state private to the user', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await sandbox(t)
  const file = statePath(path.join(dir, 'nested', 'flow'), 's1')
  const previous = process.umask(0o022)
  try {
    await saveState(file, sampleState('s1'))
  } finally {
    process.umask(previous)
  }
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700)
  assert.equal((await stat(path.join(dir, 'nested'))).mode & 0o777, 0o700)
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

  await writeFile(file, JSON.stringify({ ...sampleState('s1'), phase: 'bogus' }))
  assert.equal(await loadState(file), null)

  await writeFile(file, JSON.stringify({ ...sampleState('s1'), planPath: 42 }))
  assert.equal(await loadState(file), null)
})

test('loadState rejects a plan path outside the plans directory', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const state = sampleState('s1')
  await saveState(file, state)
  assert.deepEqual(await loadState(file, '/plans'), state)
  assert.deepEqual(await loadState(file, '/plans/'), state)
  for (const planPath of ['/plans-evil/x.md', '/plans/../etc/x.md', '/plans', '/other/x.md', 'relative/x.md']) {
    await saveState(file, { ...state, planPath })
    assert.equal(await loadState(file, '/plans'), null, planPath)
  }
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  assert.ok(child.pid)
  return child.pid
}

async function plantLock(file: string, pid: number, ageMs = 0): Promise<void> {
  const lock = sessionLockPath(file)
  await writeFile(lock, `${pid}\nplanted\n`)
  const when = new Date(Date.now() - ageMs)
  await utimes(lock, when, when)
}

test('withSessionLock runs the callbacks one at a time and releases the lock', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(path.join(dir, 'flow'), 's1')
  const order: string[] = []
  const run = (name: string) =>
    withSessionLock(file, async () => {
      order.push(`${name}:in`)
      await delay(30)
      order.push(`${name}:out`)
      return name
    })
  assert.deepEqual(await Promise.all([run('a'), run('b')]), ['a', 'b'])
  assert.equal(order.length, 4)
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i]?.replace(':in', ':out'), order[i + 1])
  assert.deepEqual(await readdir(path.join(dir, 'flow')), [])
})

test('withSessionLock releases the lock when the callback throws', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await assert.rejects(withSessionLock(file, async () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(await readdir(dir), [])
})

test('withSessionLock keeps a live owner exclusive past the stale age', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const options = { timeoutMs: 3000, staleMs: 150 }
  let inside = 0
  let overlap = false
  const run = () =>
    withSessionLock(file, async () => {
      inside += 1
      if (inside > 1) overlap = true
      await delay(600)
      inside -= 1
    }, options)
  const first = run()
  await delay(20)
  await Promise.all([first, run()])
  assert.equal(overlap, false)
  assert.deepEqual(await readdir(dir), [])
})

test('withSessionLock takes over a fresh lock left by a dead process right away', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await plantLock(file, deadPid())
  const started = Date.now()
  assert.equal(await withSessionLock(file, async () => 'ran', { timeoutMs: 2000, staleMs: 60_000 }), 'ran')
  assert.ok(Date.now() - started < 1000)
  assert.deepEqual(await readdir(dir), [])
})

test('withSessionLock takes over a lock that stopped its heartbeat within the default timeout', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await plantLock(file, process.ppid, 3000)
  assert.equal(await withSessionLock(file, async () => 'ran'), 'ran')
  assert.deepEqual(await readdir(dir), [])
})

test('withSessionLock gives up with ELOCKED while a live owner holds the lock', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  await plantLock(file, process.ppid)
  let ran = false
  const started = Date.now()
  await assert.rejects(withSessionLock(file, async () => { ran = true }, { timeoutMs: 100, staleMs: 60_000 }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'ELOCKED')
    assert.match(error.message, /timed out/)
    return true
  })
  assert.ok(Date.now() - started >= 100)
  assert.equal(ran, false)
  assert.ok(existsSync(sessionLockPath(file)))
})

test('waiters on a lock left by a dead process take it over once and run one at a time', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const pid = deadPid()
  for (let round = 0; round < 12; round += 1) {
    await plantLock(file, pid)
    let inside = 0
    let overlap = false
    let runs = 0
    const run = () =>
      withSessionLock(file, async () => {
        inside += 1
        runs += 1
        if (inside > 1) overlap = true
        await delay(2)
        inside -= 1
      }, { timeoutMs: 2000, staleMs: 60_000 })
    await Promise.all(Array.from({ length: 4 }, run))
    assert.equal(overlap, false, `round ${round}`)
    assert.equal(runs, 4, `round ${round}`)
    assert.deepEqual(await readdir(dir), [], `round ${round}`)
  }
})

test('withSessionLock removes stale lock directories left by older versions', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const old = new Date(Date.now() - 60_000)
  for (const leftover of [`${file}.lock`, `${file}.lock.break`]) {
    await mkdir(leftover)
    await writeFile(path.join(leftover, 'owner'), 'dead')
    await utimes(leftover, old, old)
  }
  assert.equal(await withSessionLock(file, async () => 'ran', { timeoutMs: 500 }), 'ran')
  assert.deepEqual(await readdir(dir), [])
})
