import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { platformContext } from '@kikedealba/kit/platform'
import { setSetting } from '@kikedealba/kit/settings'
import { marketplaceDir, renderNursery } from '../src/render.ts'
import { installAgents, prepareClaudeMarketplace } from '../src/setup.ts'

type Cleanup = { after: (fn: () => Promise<void>) => void }

async function sandbox(t: Cleanup) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-migration-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = platformContext({
    home,
    env: {
      PATH: '',
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      KIT_CONFIG_DIR: path.join(home, 'kit'),
      KIT_REGISTRY_DIR: path.join(home, 'registry'),
    },
  })
  return { home, ctx, homes: agents.agentHomes(ctx), options: { ctx, locate: async () => null } }
}

interface FakeOptions {
  failRemove?: boolean
  failAdd?: boolean
  listOutput?: string
  installed?: boolean
}

function fakeClaude(marketplaces: { name: string; source: string; path?: string; repo?: string }[], fake: FakeOptions = {}) {
  const calls: string[] = []
  const plugins: unknown[] = fake.installed === true ? [{ id: 'nursery@nursery', scope: 'user' }] : []
  return {
    calls,
    marketplaces,
    locate: async (command: string) => (command === 'claude' ? '/bin/claude' : null),
    exec: async (_command: string, args: readonly string[]) => {
      const line = args.join(' ')
      calls.push(line)
      if (line === 'plugin marketplace list --json') return fake.listOutput ?? JSON.stringify(marketplaces)
      if (line === 'plugin list --json') return JSON.stringify(plugins)
      if (args[1] === 'marketplace' && args[2] === 'remove') {
        if (fake.failRemove === true) throw new Error('remove exploded\nsecond line')
        marketplaces.splice(0, marketplaces.length)
      }
      if (args[1] === 'marketplace' && args[2] === 'add') {
        if (fake.failAdd === true) throw new Error('add exploded')
        marketplaces.push({ name: 'nursery', source: 'directory', path: args[3] ?? '' })
      }
      if (args[1] === 'install') plugins.push({ id: args[2], scope: 'user' })
      return ''
    },
  }
}

const changes = (calls: string[]): string[] => calls.filter((call) => !call.endsWith('--json'))

test('a local nursery marketplace that is not the rendered one is left alone with a warning', async (t) => {
  const { ctx, options } = await sandbox(t)
  const claude = fakeClaude([{ name: 'nursery', source: 'directory', path: '/old/checkout/nursery' }], { installed: true })
  const steps = await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.deepEqual(changes(claude.calls), [])
  const warning = steps.find((step) => step.item === 'marketplace nursery')
  assert.equal(warning?.state, 'skipped')
  assert.ok(warning?.detail.includes('/old/checkout/nursery') && warning.detail.includes(marketplaceDir(ctx)), warning?.detail)
  assert.ok(steps.some((step) => step.item === 'memory'))
})

test('a marketplace that already points at the rendered folder is left alone, even with a trailing slash or a relative detour', async (t) => {
  const { ctx, options } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  for (const registered of [rendered.marketplace, `${rendered.marketplace}/`, path.join(rendered.marketplace, '..', 'marketplace')]) {
    const claude = fakeClaude([{ name: 'nursery', source: 'directory', path: registered }])
    const steps = await prepareClaudeMarketplace(rendered, { ...options, locate: claude.locate, exec: claude.exec })
    assert.deepEqual(steps, [], registered)
    assert.deepEqual(changes(claude.calls), [], registered)
  }
})

test('a marketplace with another name, or a github one without a repo field, is handled without throwing', async (t) => {
  const { ctx, options } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  const other = fakeClaude([{ name: 'something-else', source: 'github', repo: 'a/b' }])
  assert.deepEqual(await prepareClaudeMarketplace(rendered, { ...options, locate: other.locate, exec: other.exec }), [])
  assert.deepEqual(changes(other.calls), [])
  const bare = fakeClaude([{ name: 'nursery', source: 'git' }])
  const steps = await prepareClaudeMarketplace(rendered, { ...options, locate: bare.locate, exec: bare.exec })
  assert.equal(steps[0]?.state, 'removed')
  assert.match(steps[0]?.detail ?? '', /from git;/)
})

test('when removing the old marketplace fails nothing else is added or installed, and the failure is reported', async (t) => {
  const { options } = await sandbox(t)
  const claude = fakeClaude([{ name: 'nursery', source: 'github', repo: 'KikeDeAlba/nursery' }], { failRemove: true })
  const steps = await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  const failed = steps.filter((step) => step.state === 'failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0]?.detail ?? '', /remove failed: remove exploded$/)
  assert.deepEqual(changes(claude.calls), ['plugin marketplace remove nursery'])
})

test('when adding the local marketplace fails after the old one was removed the install reports it and does not install the plugin', async (t) => {
  const { options } = await sandbox(t)
  const claude = fakeClaude([{ name: 'nursery', source: 'github', repo: 'KikeDeAlba/nursery' }], { failAdd: true })
  const steps = await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  assert.ok(steps.some((step) => step.state === 'failed' && /marketplace add failed/.test(step.detail)))
  assert.ok(!changes(claude.calls).some((call) => call.startsWith('plugin install')))
})

test('unparseable or non-array marketplace output makes the migration a no-op instead of a crash', async (t) => {
  const { ctx, options } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  for (const output of ['', 'not json', '{"name":"nursery"}', 'null', '[1,"x"]', '[]']) {
    const claude = fakeClaude([], { listOutput: output })
    const steps = await prepareClaudeMarketplace(rendered, { ...options, locate: claude.locate, exec: claude.exec })
    assert.deepEqual(steps, [], output)
    assert.deepEqual(changes(claude.calls), [], output)
  }
})

test('without claude on PATH the migration does nothing and the install reports it as unavailable', async (t) => {
  const { ctx, options } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  assert.deepEqual(await prepareClaudeMarketplace(rendered, options), [])
  const steps = await installAgents(['claude'], options)
  assert.ok(steps.some((step) => step.agent === 'claude' && step.state === 'unavailable'))
})

test('an existing kit:nursery block with old rules is replaced in place, keeping the text around it and not duplicating', async (t) => {
  const { ctx, homes, options } = await sandbox(t)
  const memory = path.join(homes.claude, 'CLAUDE.md')
  await mkdir(homes.claude, { recursive: true })
  await writeFile(memory, '# Mine\n\nbefore\n\n<!-- kit:nursery:begin -->\n# Old rules\nmáximo 99 agentes\n<!-- kit:nursery:end -->\n\n<!-- kit:other:begin -->\nkeep\n<!-- kit:other:end -->\n\nafter\n')
  await setSetting('agents.maxParallel', 6, ctx)
  const claude = fakeClaude([{ name: 'nursery', source: 'github', repo: 'KikeDeAlba/nursery' }])
  for (let run = 0; run < 2; run += 1) await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  const text = await readFile(memory, 'utf8')
  assert.equal(text.match(/<!-- kit:nursery:begin -->/g)?.length, 1)
  assert.equal(text.match(/<!-- kit:nursery:end -->/g)?.length, 1)
  assert.match(text, /máximo 6 agentes/)
  assert.doesNotMatch(text, /máximo 99|Old rules/)
  assert.match(text, /^# Mine\n\nbefore\n/)
  assert.match(text, /<!-- kit:other:begin -->\nkeep\n<!-- kit:other:end -->/)
  assert.match(text, /after\n$/)
})

test('a half-written kit:nursery block (begin without end) is not silently doubled', async (t) => {
  const { homes, options } = await sandbox(t)
  const memory = path.join(homes.claude, 'CLAUDE.md')
  await mkdir(homes.claude, { recursive: true })
  await writeFile(memory, 'intro\n<!-- kit:nursery:begin -->\ndangling rules\n')
  const claude = fakeClaude([])
  const steps = await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  const text = await readFile(memory, 'utf8')
  assert.ok(text.includes('intro'))
  assert.ok((text.match(/<!-- kit:nursery:begin -->/g)?.length ?? 0) <= 1 || steps.some((step) => step.state === 'failed' || step.state === 'skipped'), text)
})

test('the plugin is updated, not reinstalled, when a setting changes the rendered version after the migration', async (t) => {
  const { ctx, options } = await sandbox(t)
  const claude = fakeClaude([{ name: 'nursery', source: 'github', repo: 'KikeDeAlba/nursery' }])
  await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  const first = (await renderNursery(ctx)).version
  await setSetting('agents.enabled', 'developer', ctx)
  claude.calls.length = 0
  await installAgents(['claude'], { ...options, locate: claude.locate, exec: claude.exec })
  const second = (await renderNursery(ctx)).version
  assert.notEqual(first, second)
  assert.deepEqual(changes(claude.calls), ['plugin marketplace update nursery', 'plugin update nursery@nursery --scope user'])
})

test('a null entry in the marketplace list does not crash the migration', async (t) => {
  const { ctx, options } = await sandbox(t)
  const rendered = await renderNursery(ctx)
  const claude = fakeClaude([], { listOutput: '[null,{"name":"nursery","source":"github","repo":"a/b"}]' })
  const steps = await prepareClaudeMarketplace(rendered, { ...options, locate: claude.locate, exec: claude.exec })
  assert.equal(steps[0]?.state, 'removed')
})
