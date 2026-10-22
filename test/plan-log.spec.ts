import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PHASE_LABEL, applyPlanLog, currentBranch, defaultPlansDir, projectName } from '../src/plan-log.ts'

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nursery-plan-log-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const AT = new Date(2026, 9, 22, 9, 5).toISOString()
const LATER = new Date(2026, 9, 22, 14, 30).toISOString()

async function gitRepo(root: string, name: string, branch: string): Promise<string> {
  const repo = path.join(root, name)
  await mkdir(path.join(repo, '.git'), { recursive: true })
  await writeFile(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  return repo
}

test('defaultPlansDir prefers NURSERY_PLANS_DIR and falls back to the gemini home', () => {
  assert.equal(defaultPlansDir({ NURSERY_PLANS_DIR: '/plans' }, '/g'), '/plans')
  assert.equal(defaultPlansDir({ NURSERY_PLANS_DIR: '' }, '/g'), path.join('/g', 'nursery', 'plans'))
  assert.equal(defaultPlansDir({}, '/g'), path.join('/g', 'nursery', 'plans'))
})

test('PHASE_LABEL names every phase in Spanish', () => {
  assert.deepEqual(PHASE_LABEL, {
    explore: 'explorar',
    proposed: 'propuesta en revisión',
    accepted: 'aceptada, en ejecución',
    done: 'terminada',
    replaced: 'reemplazada por otro /nursery',
  })
})

test('projectName and currentBranch read the repository that holds the cwd', async (t) => {
  const root = await sandbox(t)
  const repo = await gitRepo(root, 'my-repo', 'feature/flow')
  const deep = path.join(repo, 'src', 'deep')
  await mkdir(deep, { recursive: true })
  assert.equal(projectName(deep), 'my-repo')
  assert.equal(currentBranch(deep), 'feature/flow')

  await writeFile(path.join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
  assert.equal(currentBranch(repo), null)
})

test('projectName and currentBranch follow a worktree back to its main repository', async (t) => {
  const root = await sandbox(t)
  const repo = await gitRepo(root, 'main-repo', 'develop')
  const gitDir = path.join(repo, '.git', 'worktrees', 'feat')
  await mkdir(gitDir, { recursive: true })
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/x\n')
  const worktree = path.join(root, 'elsewhere', 'feat')
  await mkdir(worktree, { recursive: true })
  await writeFile(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  assert.equal(projectName(worktree), 'main-repo')
  assert.equal(currentBranch(worktree), 'feature/x')
})

test('without git projectName is the sanitized cwd name and currentBranch is null', async (t) => {
  const root = await sandbox(t)
  const plain = path.join(root, 'plain-dir')
  await mkdir(plain)
  assert.equal(projectName(plain), 'plain-dir')
  assert.equal(currentBranch(plain), null)

  const hidden = path.join(root, '..hidden')
  await mkdir(hidden)
  assert.equal(projectName(hidden), 'hidden')

  const dots = path.join(root, '...')
  await mkdir(dots)
  assert.equal(projectName(dots), 'proyecto')

  if (process.platform !== 'win32') {
    const odd = path.join(root, 'a:b*c?d"e<f>g|h')
    await mkdir(odd)
    assert.equal(projectName(odd), 'a-b-c-d-e-f-g-h')
  }
})

test('create writes the plan header and a second create appends a restart', async (t) => {
  const root = await sandbox(t)
  const repo = await gitRepo(root, 'shop', 'develop')
  const file = path.join(root, 'plans', 'shop', 'plan.md')
  const request = `Agrega el endpoint de pagos\ncon pruebas`
  await applyPlanLog([{ kind: 'create', file, at: AT, request, cwd: repo, sessionId: 's1' }])
  assert.equal(
    await readFile(file, 'utf8'),
    `# Agrega el endpoint de pagos\n\n- Fase: explorar\n- Inicio: 2026-10-22 09:05\n- Repo: shop (${repo})\n- Rama: develop\n- Sesión: s1\n\n## Pedido\n\n${request}\n\n## Bitácora\n`,
  )

  await applyPlanLog([{ kind: 'create', file, at: LATER, request: 'otra vez', cwd: repo, sessionId: 's1' }])
  assert.match(await readFile(file, 'utf8'), /## Bitácora\n\n## Reinicio \(14:30\)\n\notra vez\n$/)
})

test('create without request or git uses the fallback texts and cuts the title at 80 characters', async (t) => {
  const root = await sandbox(t)
  const cwd = path.join(root, 'nogit')
  await mkdir(cwd)
  const empty = path.join(root, 'empty.md')
  await applyPlanLog([{ kind: 'create', file: empty, at: AT, request: '  ', cwd, sessionId: 's2' }])
  const text = await readFile(empty, 'utf8')
  assert.match(text, /^# Pedido sin texto\n/)
  assert.match(text, /\n- Rama: sin git\n/)
  assert.match(text, /\n## Pedido\n\n\(vacío\)\n\n## Bitácora\n$/)

  const long = path.join(root, 'long.md')
  await applyPlanLog([{ kind: 'create', file: long, at: AT, request: 'x'.repeat(100), cwd, sessionId: 's2' }])
  assert.match(await readFile(long, 'utf8'), new RegExp(`^# ${'x'.repeat(80)}\\n`))
})

test('each log entry is appended with its exact format', async (t) => {
  const root = await sandbox(t)
  const file = path.join(root, 'plan.md')
  await applyPlanLog([{ kind: 'create', file, at: AT, request: 'pedido', cwd: root, sessionId: 's1' }])
  const base = await readFile(file, 'utf8')

  await applyPlanLog([
    { kind: 'proposal', file, at: AT, version: 2, text: 'La propuesta' },
    { kind: 'accepted', file, at: AT, via: 'dialog' },
    { kind: 'accepted', file, at: AT, via: 'text' },
    { kind: 'correction', file, at: AT, via: 'dialog', text: '' },
    { kind: 'correction', file, at: AT, via: 'text', text: 'cambia X' },
    { kind: 'dismissed', file, at: AT },
    { kind: 'agent', file, at: AT, agent: 'researcher', task: 'mira el repo', outcome: 'goal', detail: '' },
    { kind: 'agent', file, at: AT, agent: 'developer', task: 'implementa', outcome: 'partial', detail: 'MAX_TURNS' },
    { kind: 'agent', file, at: AT, agent: 'devops', task: 'despliega', outcome: 'failed', detail: 'sin permisos' },
    { kind: 'validation', file, at: AT, qa: true, review: true, result: 'done', attempt: 0 },
    { kind: 'validation', file, at: AT, qa: true, review: false, result: 'retry', attempt: 1 },
    { kind: 'validation', file, at: AT, qa: false, review: false, result: 'gave-up', attempt: 2 },
    { kind: 'replaced', file, at: AT },
  ])

  assert.equal(
    (await readFile(file, 'utf8')).slice(base.length),
    [
      '\n### Propuesta v2 (09:05)\n\nLa propuesta\n',
      '\n### Aceptada (09:05)\n\n',
      '\n### Aceptada (09:05, por texto)\n\n',
      '\n### Corrección del usuario (09:05)\n\n(sin detalle)\n',
      '\n### Corrección del usuario (09:05, por texto)\n\ncambia X\n',
      '\n### Diálogo cerrado sin respuesta (09:05)\n',
      '- 09:05 `researcher`: mira el repo — terminó\n',
      '- 09:05 `developer`: implementa — terminó incompleto (MAX_TURNS)\n',
      '- 09:05 `devops`: despliega — falló: sin permisos\n',
      '- 09:05 Validación: qa-automation sí, code-reviewer sí — terminada\n',
      '- 09:05 Validación: qa-automation sí, code-reviewer no — reintento 1 de 2\n',
      '- 09:05 Validación: qa-automation no, code-reviewer no — sin validar tras 2 reintentos\n',
      '\n### Reemplazado por un /nursery nuevo (09:05)\n',
    ].join(''),
  )
})

test('phase rewrites only the phase line and leaves no temp files', async (t) => {
  const root = await sandbox(t)
  const file = path.join(root, 'plan.md')
  await applyPlanLog([{ kind: 'create', file, at: AT, request: '- Fase: no tocar', cwd: root, sessionId: 's1' }])
  const before = await readFile(file, 'utf8')
  for (const phase of ['proposed', 'accepted', 'done', 'replaced'] as const) {
    await applyPlanLog([{ kind: 'phase', file, phase }])
    const text = await readFile(file, 'utf8')
    assert.equal(text, before.replace('- Fase: explorar', `- Fase: ${PHASE_LABEL[phase]}`))
  }
  assert.match(await readFile(file, 'utf8'), /\n- Fase: no tocar\n/)
  assert.deepEqual(await readdir(root), ['plan.md'])
})

test('a failing entry goes to stderr and the rest still apply', async (t) => {
  const root = await sandbox(t)
  const file = path.join(root, 'plan.md')
  const missing = path.join(root, 'missing.md')
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    await applyPlanLog([
      { kind: 'phase', file: missing, phase: 'done' },
      { kind: 'create', file, at: AT, request: 'pedido', cwd: root, sessionId: 's1' },
    ])
  } finally {
    process.stderr.write = original
  }
  assert.equal(writes.length, 1)
  assert.match(writes[0] ?? '', /^nursery plan-log: phase /)
  assert.ok(!existsSync(missing))
  assert.ok(existsSync(file))
})
