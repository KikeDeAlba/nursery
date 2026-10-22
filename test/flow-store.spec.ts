import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
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

test('withSessionLock writes its own token and leaves a lock it no longer owns', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const lock = `${file}.lock`
  let token = ''
  await withSessionLock(file, async () => {
    token = await readFile(path.join(lock, 'owner'), 'utf8')
    assert.match(token, new RegExp(`^${process.pid}-[0-9a-f]{16}$`))
    if (process.platform !== 'win32') assert.equal((await stat(lock)).mode & 0o777, 0o700)
  })
  assert.ok(!existsSync(lock))

  await withSessionLock(file, async () => {
    await rm(lock, { recursive: true, force: true })
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner'), 'someone-else')
  })
  assert.ok(existsSync(lock), 'a lock owned by another process was removed')
  assert.equal(await readFile(path.join(lock, 'owner'), 'utf8'), 'someone-else')

  const other = await withSessionLock(file, async () => readFile(path.join(lock, 'owner'), 'utf8'), { timeoutMs: 50, staleMs: 10_000 }).catch((error: Error) => error.message)
  assert.match(String(other), /timed out/)
})

test('two waiters on a stale lock break it once and run one at a time', async (t) => {
  const dir = await sandbox(t)
  const file = statePath(dir, 's1')
  const lock = `${file}.lock`
  await mkdir(lock)
  await writeFile(path.join(lock, 'owner'), 'dead')
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  let inside = 0
  let overlap = false
  const run = () =>
    withSessionLock(file, async () => {
      inside += 1
      if (inside > 1) overlap = true
      await new Promise((resolve) => setTimeout(resolve, 30))
      inside -= 1
    }, { timeoutMs: 1000, staleMs: 10_000 })
  await Promise.all([run(), run(), run()])
  assert.equal(overlap, false)
  assert.ok(!existsSync(lock))
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.stale')), [])
})
