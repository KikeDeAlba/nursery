import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { assertConformance } from '@kikedealba/kit/conformance'
import { platformContext } from '@kikedealba/kit/platform'
import { ANTIGRAVITY_RULES_FILE, CAPABILITIES, GEMINI_COMMAND_FILE, GEMINI_POLICY_FILE, binCommand, checkMemory, geminiHooks, geminiIntegration, integration, shellCommand, geminiPolicyPath, findLegacy, memoryPath, installAgents, manifest, removeLegacy, setupTool, uninstallAgents, uninstallTool, LEGACY_HEADING } from '../src/setup.ts'
import { SUBAGENTS_DIR } from '../src/build.ts'
import { VERSION } from '../src/version.ts'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin', 'nursery.ts')

const LEGACY = `# Personal

Keep me.

${LEGACY_HEADING}

## Git
- old rule

# Other

Keep me too.
`

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(path.join(tmpdir(), 'nursery-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = platformContext({
    home,
    env: { PATH: '', XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), KIT_REGISTRY_DIR: path.join(home, 'registry') },
  })
  const homes = agents.agentHomes(ctx)
  return { home, homes, registry: path.join(home, 'registry'), options: { ctx, locate: async () => null } }
}

test('legacy rules are found outside kit blocks and removed with their section only', () => {
  const range = findLegacy(LEGACY)
  assert.ok(range)
  assert.equal(removeLegacy(LEGACY), '# Personal\n\nKeep me.\n\n# Other\n\nKeep me too.\n')
  const managed = `<!-- kit:nursery:begin -->\n${LEGACY_HEADING}\n<!-- kit:nursery:end -->\n`
  assert.equal(findLegacy(managed), null)
})

test('a clean install writes rules and subagents for every agent, and a second run changes nothing', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents('all', options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.ok(steps.some((step) => step.agent === 'claude' && step.item === 'plugin nursery@nursery' && step.state === 'unavailable'))

  const claude = await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8')
  assert.match(claude, /<!-- kit:nursery:begin -->\n# Reglas generales/)
  assert.match(claude, /EnterWorktree/)
  assert.ok(!existsSync(path.join(homes.claude, 'agents')))

  for (const file of [path.join(homes.opencode, 'AGENTS.md'), path.join(homes.codex, 'AGENTS.md'), path.join(homes.gemini, 'GEMINI.md')]) {
    const text = await readFile(file, 'utf8')
    assert.match(text, /Cero rastro de IA/)
    assert.doesNotMatch(text, /EnterWorktree/)
  }
  assert.match(await readFile(path.join(homes.opencode, 'agents', 'developer.md'), 'utf8'), /mode: subagent/)
  assert.match(await readFile(path.join(homes.codex, 'agents', 'security.toml'), 'utf8'), /model_reasoning_effort = "high"/)
  assert.match(await readFile(path.join(homes.gemini, 'extensions', 'nursery', 'agents', 'code-reviewer.md'), 'utf8'), /kind: local/)
  assert.match(await readFile(path.join(homes.gemini, 'extensions', 'nursery', 'agents', 'researcher.md'), 'utf8'), /^max_turns: 60$/m)
  assert.match(await readFile(path.join(homes.opencode, 'agents', 'researcher.md'), 'utf8'), /^steps: 30$/m)
  assert.ok(existsSync(path.join(homes.codex, 'prompts', 'nursery.md')))

  assert.ok((await checkMemory('all', options)).every((report) => report.state === 'current'))
  const again = await installAgents(['claude', 'opencode', 'codex'], options)
  assert.deepEqual(again.filter((step) => step.item === 'memory').map((step) => step.state), ['present', 'present', 'present'])

  await uninstallAgents(options)
  assert.equal(await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8'), '')
  assert.ok(!existsSync(path.join(homes.opencode, 'agents', 'developer.md')))
})

test('the other tools install the portable subagents', async () => {
  const subagents = (await integration()).subagents ?? []
  assert.equal(subagents.length, 10)
  for (const subagent of subagents) assert.equal(subagent.file, path.join(SUBAGENTS_DIR, `${subagent.name}.md`))
})

test('unmarked rules block the memory block until --replace-legacy', async (t) => {
  const { homes, options } = await sandbox(t)
  await mkdir(homes.claude, { recursive: true })
  const file = path.join(homes.claude, 'CLAUDE.md')
  await writeFile(file, LEGACY)

  const steps = await installAgents(['claude'], options)
  assert.ok(steps.some((step) => step.item === 'legacy rules' && step.state === 'skipped'))
  assert.equal(await readFile(file, 'utf8'), LEGACY)
  assert.deepEqual((await checkMemory(['claude'], options)).map((report) => report.state), ['legacy'])

  const replaced = await installAgents(['claude'], { ...options, replaceLegacy: true })
  assert.ok(replaced.some((step) => step.item === 'legacy rules' && step.state === 'removed'))
  const text = await readFile(file, 'utf8')
  assert.match(text, /^# Personal\n\nKeep me\.\n\n# Other\n\nKeep me too\.\n\n<!-- kit:nursery:begin -->/)
  assert.equal(text.match(/# Reglas generales/g)?.length, 1)
  assert.equal(await readFile(`${file}.legacy-backup`, 'utf8'), LEGACY)
  assert.deepEqual((await checkMemory(['claude'], options)).map((report) => report.state), ['current'])
})

test('nursery passes the kit conformance checks', async () => {
  await assertConformance([process.execPath, BIN], manifest())
})

test('setup registers nursery in the kit registry and uninstall removes it', async (t) => {
  const { registry, options } = await sandbox(t)
  const file = path.join(registry, 'nursery.json')
  const result = await setupTool(['opencode'], options)
  assert.equal(result.manifest, file)
  const registered = JSON.parse(await readFile(file, 'utf8')) as { name: string; version: string; capabilities: string[]; emits: string[]; subscribes: unknown[]; bin: string[] }
  assert.equal(registered.name, 'nursery')
  assert.equal(registered.version, VERSION)
  assert.deepEqual(registered.capabilities, CAPABILITIES)
  assert.deepEqual(registered.capabilities, ['agents.subagents', 'agents.rules'])
  assert.deepEqual(registered.emits, [])
  assert.deepEqual(registered.subscribes, [])
  assert.equal(registered.bin[0], process.execPath)

  const removed = await uninstallTool(options)
  assert.equal(removed.unregistered, true)
  assert.ok(!existsSync(file))
  assert.equal((await uninstallTool(options)).unregistered, false)
})

test('setup registers nursery even when an agent step fails', async (t) => {
  const { homes, registry, options } = await sandbox(t)
  await mkdir(path.dirname(homes.opencode), { recursive: true })
  await writeFile(homes.opencode, 'not a directory')
  const result = await setupTool(['opencode'], options)
  assert.ok(result.steps.some((step) => step.state === 'failed'))
  assert.ok(existsSync(path.join(registry, 'nursery.json')))
})

test('usage errors with --json come back as an error envelope with exit 2', async (t) => {
  const { home, registry } = await sandbox(t)
  for (const args of [['setup', '--agents', 'bogus', '--json'], ['setup', '--bogus', '--json']]) {
    const run = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, KIT_REGISTRY_DIR: registry } })
    assert.equal(run.status, 2, args.join(' '))
    const lines = run.stdout.trim().split('\n')
    assert.equal(lines.length, 1, args.join(' '))
    const envelope = JSON.parse(lines[0] ?? '') as { ok: boolean; command: string; error: { code: string; message: string } }
    assert.equal(envelope.ok, false)
    assert.equal(envelope.command, 'setup')
    assert.equal(envelope.error.code, 'USAGE')
    assert.ok(envelope.error.message.length > 0)
  }
  assert.ok(!existsSync(path.join(registry, 'nursery.json')))
})

test('researcher is installed for opencode and codex and named in the rules block', async (t) => {
  const { homes, options } = await sandbox(t)
  await installAgents(['opencode', 'codex'], options)
  assert.match(await readFile(path.join(homes.opencode, 'agents', 'researcher.md'), 'utf8'), /mode: subagent/)
  assert.ok(existsSync(path.join(homes.codex, 'agents', 'researcher.toml')))
  for (const file of [path.join(homes.opencode, 'AGENTS.md'), path.join(homes.codex, 'AGENTS.md')]) {
    assert.match(await readFile(file, 'utf8'), /empieza con `researcher`/)
  }
})

test('the CLI reports capabilities as one json line and rejects unknown commands', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

  const ok = run('capabilities', '--json')
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout.trimEnd().split('\n').length, 1)
  const okEnvelope = JSON.parse(ok.stdout) as { ok: boolean; data: { capabilities: string[] } }
  assert.equal(okEnvelope.ok, true)
  assert.deepEqual(okEnvelope.data.capabilities, CAPABILITIES)

  const bad = run('bogus', '--json')
  assert.notEqual(bad.status, 0)
  assert.equal((JSON.parse(bad.stdout) as { ok: boolean }).ok, false)

  const plain = run('bogus')
  assert.equal(plain.status, 2)
  assert.match(plain.stdout + plain.stderr, /Uso:/)
})

test('gemini gets the plan-mode policy for read-only subagents, kept in sync and removed on uninstall', async (t) => {
  const { homes, options } = await sandbox(t)
  const file = path.join(homes.gemini, 'policies', 'nursery.toml')
  assert.equal(geminiPolicyPath(options), file)
  const policy = await readFile(GEMINI_POLICY_FILE, 'utf8')

  const first = await installAgents(['gemini'], options)
  assert.deepEqual(first.filter((step) => step.item === 'plan policy').map((step) => [step.agent, step.state, step.path]), [['gemini', 'installed', file]])
  assert.equal(await readFile(file, 'utf8'), policy)
  assert.match(policy, /toolName = "invoke_agent"/)
  assert.match(policy, /modes = \["plan"\]/)

  const second = await installAgents(['gemini'], options)
  assert.deepEqual(second.filter((step) => step.item === 'plan policy').map((step) => step.state), ['present'])

  await writeFile(file, '# stale\n')
  const third = await installAgents(['gemini'], options)
  const updated = third.filter((step) => step.item === 'plan policy')
  assert.deepEqual(updated.map((step) => step.state), ['installed'])
  assert.match(updated[0]!.detail, /nursery\.toml\.bak/)
  assert.equal(await readFile(file, 'utf8'), policy)
  assert.equal(await readFile(`${file}.bak`, 'utf8'), '# stale\n')

  const removed = await uninstallAgents(options)
  assert.deepEqual(removed.filter((step) => step.item === 'plan policy').map((step) => [step.agent, step.state]), [['gemini', 'removed']])
  assert.ok(!existsSync(file))
})

test('the gemini plan policy is not written when gemini is not a target', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents(['claude'], options)
  assert.ok(!steps.some((step) => step.item === 'plan policy'))
  assert.ok(!existsSync(path.join(homes.gemini, 'policies', 'nursery.toml')))
})

test('uninstall leaves an edited gemini plan policy in place', async (t) => {
  const { homes, options } = await sandbox(t)
  const file = path.join(homes.gemini, 'policies', 'nursery.toml')
  await installAgents(['gemini'], options)
  await writeFile(file, '# mine\n')

  const removed = await uninstallAgents(options)
  const steps = removed.filter((step) => step.item === 'plan policy')
  assert.deepEqual(steps.map((step) => [step.agent, step.state, step.path]), [['gemini', 'skipped', file]])
  assert.match(steps[0]!.detail, /differs/)
  assert.equal(await readFile(file, 'utf8'), '# mine\n')
})

const BEFORE_TOOL_MATCHER = '.*'

function expectedHooks(bin: string) {
  const hook = (event: string) => [{ type: 'command', name: 'nursery-flow', command: `${bin} gemini-hook ${event}`, timeout: 10000 }]
  return {
    hooks: {
      BeforeAgent: [{ hooks: hook('BeforeAgent') }],
      BeforeTool: [{ matcher: BEFORE_TOOL_MATCHER, hooks: hook('BeforeTool') }],
      AfterTool: [{ matcher: '^(invoke_agent|ask_user)$', hooks: hook('AfterTool') }],
      AfterAgent: [{ hooks: hook('AfterAgent') }],
    },
  }
}

test('shellCommand quotes every part for a POSIX shell or for PowerShell', () => {
  assert.equal(shellCommand(['/usr/bin/node', "/it's/bin.js"], 'darwin'), `'/usr/bin/node' '/it'\\''s/bin.js'`)
  assert.equal(shellCommand(['/usr/bin/node', '/a b/bin.js'], 'linux'), `'/usr/bin/node' '/a b/bin.js'`)
  assert.equal(shellCommand(['C:\\Program Files\\nodejs\\node.exe', "C:\\it's\\bin.js"], 'win32'), `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\it''s\\bin.js'`)
  assert.equal(shellCommand(['C:\\a‘b’c‚d‛e\\node.exe'], 'win32'), `& 'C:\\a‘‘b’’c‚‚d‛‛e\\node.exe'`)
  assert.equal(shellCommand(["C:\\it’s'\\bin.js"], 'win32'), `& 'C:\\it’’s''\\bin.js'`)
})

test('the gemini hooks use the PowerShell call operator on windows', async (t) => {
  const { home } = await sandbox(t)
  const ctx = platformContext({ platform: 'win32', home, env: { PATH: '' } })
  const hooks = await geminiHooks(ctx)
  assert.deepEqual(Object.keys(hooks), ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent'])
  assert.equal(hooks['BeforeTool']?.[0]?.hooks[0]?.command, `${shellCommand(binCommand(), 'win32')} gemini-hook BeforeTool`)
  assert.match(hooks['BeforeTool']?.[0]?.hooks[0]?.command ?? '', /^& '[^']+' '[^']+' gemini-hook BeforeTool$/)
})

test('only the gemini integration carries the flow command and hooks', async () => {
  const shared = await integration()
  assert.deepEqual(shared.userSkills?.map((skill) => skill.name), ['nursery'])
  assert.equal(shared.commands, undefined)
  assert.equal(shared.gemini, undefined)

  const gemini = await geminiIntegration()
  assert.equal(gemini.userSkills, undefined)
  assert.deepEqual(gemini.commands, [{ name: 'nursery', file: GEMINI_COMMAND_FILE }])
  assert.deepEqual(Object.keys(gemini.gemini?.hooks ?? {}), ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent'])
  assert.equal(gemini.memory, shared.memory)
  assert.deepEqual(gemini.subagents, shared.subagents)
})

test('installing gemini writes the flow hooks and the /nursery command into the extension', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents(['gemini'], options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  const root = path.join(homes.gemini, 'extensions', 'nursery')

  const hooksFile = path.join(root, 'hooks', 'hooks.json')
  const hooks = JSON.parse(await readFile(hooksFile, 'utf8')) as unknown
  const bin = shellCommand(binCommand(), process.platform === 'win32' ? 'win32' : 'darwin')
  assert.deepEqual(hooks, expectedHooks(bin))
  assert.match(bin, process.platform === 'win32' ? /^& '/ : /^'/)
  assert.ok(steps.some((step) => step.agent === 'gemini' && step.item === 'hooks' && step.state === 'installed' && step.path === hooksFile))

  const toml = await readFile(path.join(root, 'commands', 'nursery.toml'), 'utf8')
  assert.equal(toml, agents.commandToGeminiToml(await readFile(GEMINI_COMMAND_FILE, 'utf8')))
  assert.match(toml, /\[nursery-flow\]/)
  assert.match(toml, /\{\{args\}\}/)
  assert.doesNotMatch(toml, /\$ARGUMENTS/)
  assert.match(await readFile(path.join(root, 'agents', 'researcher.md'), 'utf8'), /kind: local/)
  assert.match(await readFile(path.join(homes.gemini, 'GEMINI.md'), 'utf8'), /Cero rastro de IA/)

  await uninstallAgents(options)
  assert.ok(!existsSync(root))
})

test('opencode and codex keep the nursery command from the skill and get no hooks', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents(['opencode', 'codex'], options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.ok(!steps.some((step) => step.item === 'hooks'))
  assert.ok(!existsSync(path.join(homes.codex, 'hooks.json')))
  assert.ok(!existsSync(path.join(homes.gemini, 'extensions', 'nursery')))
  for (const file of [path.join(homes.opencode, 'commands', 'nursery.md'), path.join(homes.codex, 'prompts', 'nursery.md')]) {
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /\[nursery-flow\]/, file)
    assert.ok(text.length > 0, file)
  }
})

test('blocked legacy rules keep the gemini memory out but still install the flow hooks', async (t) => {
  const { homes, options } = await sandbox(t)
  await mkdir(homes.gemini, { recursive: true })
  const file = path.join(homes.gemini, 'GEMINI.md')
  await writeFile(file, LEGACY)
  const steps = await installAgents(['gemini'], options)
  assert.ok(steps.some((step) => step.agent === 'gemini' && step.item === 'legacy rules' && step.state === 'skipped'))
  assert.equal(await readFile(file, 'utf8'), LEGACY)
  assert.ok(existsSync(path.join(homes.gemini, 'extensions', 'nursery', 'hooks', 'hooks.json')))
  assert.ok(existsSync(path.join(homes.gemini, 'extensions', 'nursery', 'commands', 'nursery.toml')))
})

function fakeAgy(homes: { antigravity: string }) {
  const calls: string[] = []
  const plugins = path.join(homes.antigravity, 'plugins')
  return {
    calls,
    locate: async (command: string) => (command === 'agy' ? '/bin/agy' : null),
    exec: async (command: string, args: readonly string[]) => {
      if (command !== '/bin/agy') throw new Error(`unexpected command ${command}`)
      calls.push(args.join(' '))
      const [verb, action, target] = args
      if (verb !== 'plugin') throw new Error(`unknown agy command ${args.join(' ')}`)
      if (action === 'list') {
        const names = await readdir(plugins).catch(() => [] as string[])
        return JSON.stringify(names.map((name) => ({ name, enabled: true, path: path.join(plugins, name) })))
      }
      if (action === 'validate') return JSON.stringify({ ok: true })
      if (action === 'install' && target) {
        const { name } = JSON.parse(await readFile(path.join(target, 'plugin.json'), 'utf8')) as { name: string }
        await rm(path.join(plugins, name), { recursive: true, force: true })
        await cp(target, path.join(plugins, name), { recursive: true })
        return ''
      }
      if (action === 'uninstall' && target) {
        await rm(path.join(plugins, target), { recursive: true, force: true })
        return ''
      }
      throw new Error(`unknown agy command ${args.join(' ')}`)
    },
  }
}

async function antigravitySandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const box = await sandbox(t)
  const agy = fakeAgy(box.homes)
  return { ...box, agy, options: { ...box.options, locate: agy.locate, exec: agy.exec } }
}

const blockCount = (text: string) => text.match(/<!-- kit:nursery:begin -->/g)?.length ?? 0

test('the shared integration points antigravity at its own rules file', async () => {
  assert.deepEqual((await integration()).antigravity, { rules: ANTIGRAVITY_RULES_FILE })
  assert.ok(existsSync(ANTIGRAVITY_RULES_FILE))
})

test('setup for antigravity installs the plugin through agy, and a second run changes nothing', async (t) => {
  const { homes, agy, options } = await antigravitySandbox(t)
  const steps = await installAgents(['antigravity'], options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.deepEqual(steps.filter((step) => step.item === 'plugin').map((step) => [step.agent, step.state]), [['antigravity', 'installed']])
  assert.deepEqual(steps.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]), [['antigravity', 'installed']])
  assert.ok(agy.calls.some((call) => /^plugin validate .+ --strict --json$/.test(call)))
  assert.ok(!steps.some((step) => step.item === 'plan policy'))
  assert.ok(!existsSync(path.join(homes.gemini, 'extensions', 'nursery')))

  const plugin = path.join(homes.antigravity, 'plugins', 'nursery')
  assert.equal((JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8')) as { name: string }).name, 'nursery')
  const names = (await integration()).subagents?.map((subagent) => subagent.name) ?? []
  assert.equal(names.length, 10)
  assert.deepEqual((await readdir(path.join(plugin, 'agents'))).sort(), names.map((name) => `${name}.md`).sort())
  assert.match(await readFile(path.join(plugin, 'skills', 'nursery', 'SKILL.md'), 'utf8'), /^---\nname: nursery\n/)
  const rules = await readFile(path.join(plugin, 'rules', 'nursery.md'), 'utf8')
  assert.match(rules, /^---\ntrigger: always_on\n---\n/)
  assert.match(rules, /invoke_subagent/)
  assert.equal(memoryPath('antigravity', options), path.join(homes.gemini, 'GEMINI.md'))
  assert.match(await readFile(memoryPath('antigravity', options), 'utf8'), /Cero rastro de IA/)

  agy.calls.length = 0
  const again = await installAgents(['antigravity'], options)
  assert.deepEqual(again.filter((step) => step.item === 'plugin' || step.item === 'memory').map((step) => [step.item, step.state]), [['memory', 'present'], ['plugin', 'present']])
  assert.ok(!agy.calls.some((call) => call.startsWith('plugin install')))
  assert.deepEqual((await checkMemory(['antigravity'], options)).map((report) => report.state), ['current'])
})

test('gemini and antigravity together keep a single rules block in GEMINI.md and both check as current', async (t) => {
  const { homes, options } = await antigravitySandbox(t)
  const steps = await installAgents(['gemini', 'antigravity'], options)
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  const file = path.join(homes.gemini, 'GEMINI.md')
  assert.equal(blockCount(await readFile(file, 'utf8')), 1)
  assert.deepEqual((await checkMemory(['gemini', 'antigravity'], options)).map((report) => [report.agent, report.file, report.state]), [['gemini', file, 'current'], ['antigravity', file, 'current']])
  assert.deepEqual(steps.filter((step) => step.item === 'plan policy').map((step) => step.agent), ['gemini'])

  await installAgents(['antigravity', 'gemini'], options)
  assert.equal(blockCount(await readFile(file, 'utf8')), 1)
})

for (const first of ['gemini', 'antigravity'] as const) {
  test(`removing ${first} first keeps the shared GEMINI.md block until the other one is gone`, async (t) => {
    const { homes, options } = await antigravitySandbox(t)
    await installAgents(['gemini', 'antigravity'], options)
    const file = path.join(homes.gemini, 'GEMINI.md')
    const partial = await agents.uninstallIntegration(first === 'gemini' ? await geminiIntegration(options.ctx) : await integration(), { ...options, agents: [first] })
    assert.deepEqual(partial.filter((step) => step.item === 'memory').map((step) => step.state), ['skipped'])
    assert.equal(blockCount(await readFile(file, 'utf8')), 1)

    const rest = await uninstallAgents(options)
    assert.deepEqual(rest.filter((step) => step.state === 'failed'), [])
    assert.equal(blockCount(await readFile(file, 'utf8')), 0)
    assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'nursery')))
    assert.ok(!existsSync(path.join(homes.gemini, 'extensions', 'nursery')))
  })
}

test('legacy rules in the shared GEMINI.md are reported once and block both agents', async (t) => {
  const { homes, options } = await antigravitySandbox(t)
  await mkdir(homes.gemini, { recursive: true })
  const file = path.join(homes.gemini, 'GEMINI.md')
  await writeFile(file, LEGACY)
  const steps = await installAgents(['gemini', 'antigravity'], options)
  assert.deepEqual(steps.filter((step) => step.item === 'legacy rules').map((step) => [step.agent, step.state]), [['gemini', 'skipped']])
  assert.ok(!steps.some((step) => step.item === 'memory'))
  assert.equal(await readFile(file, 'utf8'), LEGACY)
  assert.ok(existsSync(path.join(homes.antigravity, 'plugins', 'nursery', 'plugin.json')))
  assert.deepEqual((await checkMemory(['gemini', 'antigravity'], options)).map((report) => report.state), ['legacy', 'legacy'])

  const replaced = await installAgents(['gemini', 'antigravity'], { ...options, replaceLegacy: true })
  assert.deepEqual(replaced.filter((step) => step.item === 'legacy rules').map((step) => step.state), ['removed'])
  assert.equal(blockCount(await readFile(file, 'utf8')), 1)
  assert.equal(await readFile(`${file}.legacy-backup`, 'utf8'), LEGACY)
})

test('without agy on PATH the antigravity plugin is unavailable but the rules block is still written', async (t) => {
  const { homes, options } = await sandbox(t)
  const steps = await installAgents(['antigravity'], options)
  assert.deepEqual(steps.filter((step) => step.item === 'plugin').map((step) => [step.agent, step.state]), [['antigravity', 'unavailable']])
  assert.deepEqual(steps.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]), [['antigravity', 'installed']])
  assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'nursery')))

  const removed = await uninstallAgents(options)
  assert.deepEqual(removed.filter((step) => step.agent === 'antigravity' && step.item === 'plugin').map((step) => step.state), ['unavailable'])
})

test('a failing agy plugin validate stops the install before agy plugin install runs', async (t) => {
  const { homes, agy, options } = await antigravitySandbox(t)
  const exec = async (command: string, args: readonly string[]) => {
    if (args[0] === 'plugin' && args[1] === 'validate') {
      agy.calls.push(args.join(' '))
      throw new Error('invalid plugin')
    }
    return agy.exec(command, args)
  }
  const steps = await installAgents(['antigravity'], { ...options, exec })
  const plugin = steps.filter((step) => step.item === 'plugin')
  assert.deepEqual(plugin.map((step) => [step.agent, step.state]), [['antigravity', 'failed']])
  assert.match(plugin[0]?.detail ?? '', /validate failed/)
  assert.ok(agy.calls.some((call) => call.startsWith('plugin validate')))
  assert.ok(!agy.calls.some((call) => call.startsWith('plugin install')))
  assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'nursery')))
})

test('uninstall skips the antigravity plugin when it is not installed', async (t) => {
  const { agy, options } = await antigravitySandbox(t)
  const steps = await uninstallAgents(options)
  assert.deepEqual(steps.filter((step) => step.agent === 'antigravity' && step.item === 'plugin').map((step) => step.state), ['skipped'])
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.ok(!agy.calls.some((call) => call.startsWith('plugin uninstall')))
})

test('gemini is detected by its extensions folder or binary, not by the ~/.gemini folder agy creates', async (t) => {
  const { homes, options } = await sandbox(t)
  const detected = async (locate: (command: string) => Promise<string | null> = options.locate) => (await checkMemory('detected', { ...options, locate })).map((report) => report.agent)

  await mkdir(homes.gemini, { recursive: true })
  assert.deepEqual(await detected(), [])

  await mkdir(homes.antigravity, { recursive: true })
  assert.deepEqual(await detected(), ['antigravity'])

  assert.deepEqual(await detected(async (command: string) => (command === 'gemini' ? '/bin/gemini' : null)), ['gemini', 'antigravity'])

  await mkdir(path.join(homes.gemini, 'extensions'), { recursive: true })
  assert.deepEqual(await detected(), ['gemini', 'antigravity'])
})
