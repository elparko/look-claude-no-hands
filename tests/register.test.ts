import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, said: (string | object)[], { speakExit = 0, startExit = 0, isMoved = false, isDropping = false, replies = {} as Record<string, string> } = {}) {
  const clock = mock.clock(on)
  const spoken: string[] = []
  const systemSaid: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const models: string[] = []
  const calls: string[] = []
  let quits = 0
  let quit = () => {}
  const ok = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('model.fork', () => ({ value: { isAnswered: true as const, text: 'Deploy finished.', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('audio.speak', (_$, e) => {
    systemSaid.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0]?.endsWith('/voiced')) return ok(startExit)
    const url = e.argv[e.argv.length - 1] ?? ''
    const path = url.replace('http://voice', '').split('?')[0] ?? ''
    calls.push(`${url.replace('http://voice', '')} ${e.init?.stdin ?? ''}`.trim())
    if (replies[path] !== undefined) return ok(0, replies[path])
    if (path === '/speak') {
      if (speakExit === 0) spoken.push(e.init?.stdin ?? '')
      return ok(speakExit, 'done')
    }
    if (path === '/quit' || path === '/leave') {
      quits++
      quit()
    }
    if (path === '/model') models.push(e.init?.stdin ?? '')
    return ok(0, 'ok')
  })
  on('process.spawn', async function* () {
    const line = (msg: object) => ({ stream: 'stdout' as const, text: `${JSON.stringify(msg)}\n` })
    const quitting = new Promise<void>(resolve => (quit = resolve))
    yield line({ ready: true })
    for (const text of said) {
      if (typeof text === 'object') {
        yield line(text)
        continue
      }
      yield line({ start: true })
      yield line({ partial: text.split(' ')[0] })
      yield line({ final: text })
    }
    if (isMoved) {
      yield line({ moved: true })
      return { value: { code: 0, signal: null } }
    }
    await quitting
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return isDropping ? { drop: 'blocked' } : { text: e.text }
  })
  return { clock, spoken, systemSaid, submitted, toasts, models, calls, quits: () => quits }
}

const talk = { command: 'talk', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const turn = { answer: 'Pushed **abc123**.\n\n```sh\ngit log\n```', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

test('voice mode starts the server, greets, and submits what it hears', async ($, on) => {
  const w = world(on, ['check the runner next'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.spoken).toEqual(["I'm listening."])
  expect(w.submitted).toEqual(['check the runner next'])
  await $.command.run(talk)
})

test('a long answer is rewritten for speech and spoken', async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  w.spoken.length = 0
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.spoken).toEqual(['Deploy finished.'])
  await $.command.run(talk)
})

test('a short plain answer is spoken as written, without a rewrite', async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  w.spoken.length = 0
  await $.turn.complete({ ...turn, answer: 'It runs every night at two, on the runner Mac.' })
  await w.clock.advance(0)
  expect(w.spoken).toEqual(['It runs every night at two, on the runner Mac.'])
  await $.command.run(talk)
})

test('turns are not spoken while voice mode is off', async ($, on) => {
  const w = world(on, [])
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.spoken).toEqual([])
})

test('falls back to the system voice when the server cannot speak', async ($, on) => {
  const w = world(on, [], { speakExit: 7 })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.systemSaid).toEqual(["I'm listening."])
  await $.command.run(talk)
})

test('voice mode turns off with a notice when the server does not start', async ($, on) => {
  const w = world(on, ['hello'], { startExit: 1 })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  expect(w.toasts[0]).toContain('did not start')
})

test('noise and "never mind" are not submitted', async ($, on) => {
  const w = world(on, ['...', 'Never mind.', 'run the tests'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['run the tests'])
  await $.command.run(talk)
})

test('words said while Claude works are not submitted as a new prompt, and are sent when the turn ends', async ($, on) => {
  const w = world(on, ['also check the runner'])
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])

  w.spoken.length = 0
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['also check the runner'])
  expect(w.spoken).toEqual([])
  await $.command.run(talk)
})

const band = {
  plugin: 'no-hands',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

test('the band above the prompt shows the voice state only while voice mode is on', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['check the runner next'])
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  const surfaces = ['vscode', 'terminal', 'desktop'] as const
  for (const surface of surfaces) {
    const off = await $.ui.mount({ ...band, surface })
    expect(JSON.stringify(await off.drawn())).not.toMatch(/working/i)
    await off.unmount()
  }

  await $.command.run(talk)
  await w.clock.advance(0)
  for (const surface of surfaces) {
    const ui = await $.ui.mount({ ...band, surface })
    const tree = surface === 'vscode' ? await ui.drawn() : await ui.drawn({ in: 'voice' })
    expect(JSON.stringify(tree)).toContain(surface === 'vscode' ? 'working' : 'Working')
    await ui.unmount()
  }
  await $.command.run(talk)
})

test('the band shows the last spoken reply in a box', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'All nine tests passed.' })
  await w.clock.advance(0)
  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  const tree = JSON.stringify(await ui.drawn({ in: 'voice' }))
  expect(tree).toContain('All nine tests passed.')
  expect(tree).toContain('round')
  await ui.unmount()
  await $.command.run(talk)
})

test('words said while Claude works show as a numbered queue', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['also check the runner', 'and the logs'])
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  const tree = JSON.stringify(await ui.drawn({ in: 'voice' }))
  expect(tree).toContain('also check the runner')
  expect(tree).toContain('and the logs')
  await ui.unmount()
  await $.command.run(talk)
})

test('/talk level sets the mic level and rejects bad values', async ($, on) => {
  world(on, [])
  const bad = await $.command.run({ ...talk, args: 'level loud' })
  expect(JSON.stringify(bad)).toContain('Usage')
  const good = await $.command.run({ ...talk, args: 'level 0.06' })
  expect(JSON.stringify(good)).toContain('0.06')
})

test('/talk voice switches the voice and plays a sample', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  w.spoken.length = 0
  const bad = await $.command.run({ ...talk, args: 'voice robot' })
  expect(JSON.stringify(bad)).toContain('am_michael')
  await $.command.run({ ...talk, args: 'voice bm_george' })
  await w.clock.advance(0)
  expect(w.spoken).toEqual(['This is how I sound now.'])
  await $.command.run(talk)
})

test('turning voice off and on during startup greets once', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await $.command.run(talk)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.spoken).toEqual(["I'm listening."])
  await $.command.run(talk)
})

test('"cancel" removes the last queued item and "send now" stops the turn and sends the rest', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['check the runner', 'and the logs', 'cancel', 'send now'])
  const aborted: string[] = []
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  expect(aborted).toEqual(['t1'])
  expect(w.submitted).toEqual(['check the runner'])
  expect(w.spoken).toContain('Removed.')
  await $.command.run(talk)
})

test('a question asked while Claude works is answered on the side, not queued', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['what branch are we on?'])
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  expect(w.spoken).toContain('Deploy finished.')
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

test('the panel shows the last thing sent to Claude', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['check the runner next'])
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  await $.command.run(talk)
  await w.clock.advance(0)
  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  const tree = JSON.stringify(await ui.drawn({ in: 'voice' }))
  expect(tree).toContain('Sent')
  expect(tree).toContain('check the runner next')
  await ui.unmount()
  await $.command.run(talk)
})

test('a session start while voice mode is on does not start a second listener', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(0)
  expect(w.spoken).toEqual(["I'm listening."])
  await $.command.run(talk)
})

function spawnable(on: On, extra: { teammateId?: string } = {}) {
  let n = 0
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}`, ...extra }))
}

async function spawnReviewer($: { agent: { spawn: (input: never) => Promise<unknown> } }) {
  await $.agent.spawn({ prompt: 'Review the diff.', description: 'review the diff', name: 'reviewer', subagentType: 'Explore' } as never)
}

test('a spawned agent shows in the band with its current step', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  spawnable(on)
  await spawnReviewer($)
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
  await $.command.run(talk)
  await w.clock.advance(0)
  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  const tree = JSON.stringify(await ui.drawn({ in: 'voice' }))
  expect(tree).toContain('reviewer')
  expect(tree).toContain('Bash: npm test')
  await ui.unmount()
  await $.command.run(talk)
})

test('"tell the reviewer to …" sends the words to that agent', { timeoutMs: 20_000 }, async ($, on) => {
  const messages: string[] = []
  on('session.send', (_$, e) => {
    messages.push(`${e.to} ${e.text}`)
    return { isDelivered: true as const }
  })
  spawnable(on)
  const w = world(on, ['Tell the reviewer to skip the tests.'])
  await spawnReviewer($)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(messages.length).toBe(1)
  expect(messages[0]).toContain('a1')
  expect(messages[0]).toContain('skip the tests')
  expect(w.spoken).toContain('Sent to agent 1, reviewer.')
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

test('"stop agent one" stops that agent', { timeoutMs: 20_000 }, async ($, on) => {
  const stopped: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskStop') stopped.push(String((e as { task_id?: string }).task_id))
    return { result: {}, text: 'ok' } as never
  })
  spawnable(on)
  const w = world(on, ['Stop agent one.'])
  await spawnReviewer($)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(stopped).toEqual(['reviewer'])
  expect(w.spoken).toContain('Stopped agent 1, reviewer.')
  await $.command.run(talk)
})

test('"stop" alone stops the main work, not an agent', { timeoutMs: 20_000 }, async ($, on) => {
  const stopped: string[] = []
  const aborted: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskStop') stopped.push('x')
    return { result: {}, text: 'ok' } as never
  })
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  spawnable(on)
  const w = world(on, ['Stop.'])
  await spawnReviewer($)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(stopped).toEqual([])
  expect(aborted).toEqual(['t1'])
  expect(w.spoken).toContain('Stopped.')
  await $.command.run(talk)
})

for (const phrase of ['Pause.', 'Okay, hold on.', 'Wait, stop.']) {
  test(`"${phrase}" stops the main work`, { timeoutMs: 20_000 }, async ($, on) => {
    const aborted: string[] = []
    on('turn.abort', (_$, e) => {
      aborted.push(e.turnId)
      return { value: undefined }
    })
    const w = world(on, [phrase])
    await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
    await $.command.run(talk)
    await w.clock.advance(0)
    expect(aborted).toEqual(['t1'])
    expect(w.spoken).toContain('Stopped.')
    await $.command.run(talk)
  })
}

test('"stop" with words from an agent\'s task does not stop that agent', { timeoutMs: 20_000 }, async ($, on) => {
  const stopped: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskStop') stopped.push('x')
    return { result: {}, text: 'ok' } as never
  })
  spawnable(on)
  const w = world(on, ['Kill the server.'])
  await $.agent.spawn({ prompt: 'Restart it.', description: 'restart the dev server' } as never)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(stopped).toEqual([])
  expect(w.submitted).toEqual(['Kill the server.'])
  await $.command.run(talk)
})

test('agent numbers as Whisper spells them reach the right agent', { timeoutMs: 20_000 }, async ($, on) => {
  const stopped: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'TaskStop') stopped.push(String((e as { task_id?: string }).task_id))
    return { result: {}, text: 'ok' } as never
  })
  spawnable(on)
  const w = world(on, ['Stop agent to.', 'Stop agent number won.'])
  await spawnReviewer($)
  await spawnReviewer($)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(stopped).toEqual(['reviewer', 'reviewer'])
  expect(w.spoken).toContain('Stopped agent 2, reviewer.')
  expect(w.spoken).toContain('Stopped agent 1, reviewer.')
  await $.command.run(talk)
})

test('a teammate goes idle after a turn instead of done', { timeoutMs: 20_000 }, async ($, on) => {
  spawnable(on, { teammateId: 'scout@team' })
  const w = world(on, ['Agent status.'])
  await $.agent.spawn({ prompt: 'Scout.', description: 'scout the tests', name: 'scout' } as never)
  await $.turn.complete({ ...turn, agentId: 'a1' })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.spoken.some(line => line.startsWith('1 running.'))).toBe(true)
  await $.command.run(talk)
})

test('agents that finish while Claude works are announced together', { timeoutMs: 20_000 }, async ($, on) => {
  spawnable(on)
  const w = world(on, [])
  await spawnReviewer($)
  await spawnReviewer($)
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.start({ text: 'review', turnId: 't1' } as never)
  await $.turn.complete({ ...turn, agentId: 'a1' })
  await $.turn.complete({ ...turn, agentId: 'a2' })
  await w.clock.advance(5000)
  expect(w.spoken).toContain('2 agents ended: agents 1, 2.')
  await $.command.run(talk)
})

test('an agent stopped by voice is not announced again as failed', { timeoutMs: 20_000 }, async ($, on) => {
  on('tool.call', () => ({ result: {}, text: 'ok' }) as never)
  spawnable(on)
  const w = world(on, ['Stop agent one.'])
  await spawnReviewer($)
  await $.turn.start({ text: 'review', turnId: 't1' } as never)
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, agentId: 'a1', isAborted: true, reason: 'aborted' as never })
  await w.clock.advance(5000)
  expect(w.spoken).toContain('Stopped agent 1, reviewer.')
  expect(w.spoken.filter(line => line.includes('agent 1, reviewer')).length).toBe(1)
  await $.command.run(talk)
})

test('a spoken slash command is read back and runs after an okay', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: string[] = []
  on('command.list', () => ({ value: [{ name: 'compact', description: '', source: 'builtin' }, { name: 'code-review', description: '', source: 'builtin' }, { name: 'goal', description: '', source: 'builtin' }] }) as never)
  on('command.run', (_$, e) => {
    ran.push(`${e.command}|${e.args}`)
    return { text: 'ok' }
  })
  const w = world(on, ['Slash code review high.', 'Yes.', 'Okay, slash goal.', 'Finish the audit fixes.', 'Go ahead.', 'Finish the tests, slash goal.', 'No.', 'Slash the budget in half.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(ran).toEqual(['code-review|high', 'goal|Finish the audit fixes'])
  expect(w.spoken).toContain('Run code review with: high. Okay?')
  expect(w.spoken).toContain('What should the goal be? Or say "run it" to run it as is.')
  expect(w.spoken).toContain('Run goal with: finish the tests. Okay?')
  expect(w.spoken).toContain('Dropped.')
  expect(w.submitted).toEqual(['Slash the budget in half.'])
  await $.command.run(talk)
})

test('a pending slash command drops on any reply that starts with no, cancel, or stop', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: string[] = []
  on('command.list', () => ({ value: [{ name: 'goal', description: '', source: 'builtin' }] }) as never)
  on('command.run', (_$, e) => {
    ran.push(`${e.command}|${e.args}`)
    return { text: 'ok' }
  })
  const w = world(on, ['Slash goal.', 'No, I do not want that.', 'Slash goal finish it.', 'Okay, cancel the command.', 'Slash goal.', 'Stop.', 'Fix the tests.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(ran).toEqual([])
  expect(w.spoken.filter(t => t === 'Dropped.').length).toBe(3)
  expect(w.submitted).toEqual(['Fix the tests.'])
  await $.command.run(talk)
})

const goalCmd = (args: string) => ({ ...talk, command: 'goal', args })

function crons(on: On) {
  const deleted: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'CronList') return { result: { jobs: [{ id: 'c1', cron: '*/5 * * * *', humanSchedule: 'every 5 minutes', prompt: 'check CI', recurring: true }] }, text: '' } as never
    if (e.tool === 'CronDelete') {
      deleted.push(e.id)
      return { result: { id: e.id }, text: 'ok' } as never
    }
    return { result: {}, text: 'ok' } as never
  })
  return deleted
}

function goals(on: On) {
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`${e.command}|${e.args}`)
    return { text: e.args === 'clear' ? 'Goal cleared: x' : `Goal set: ${e.args}` }
  })
  return ran
}

test('"clear goal" runs /goal clear once a goal is set', { timeoutMs: 20_000 }, async ($, on) => {
  const ran = goals(on)
  const w = world(on, ['Clear the goal.', 'Clear goal.'])
  await $.command.run(goalCmd('finish the tests'))
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(ran).toEqual(['goal|finish the tests', 'goal|clear'])
  expect(w.spoken).toContain('Goal cleared.')
  expect(w.spoken).toContain('No goal is set.')
  await $.command.run(talk)
})

test('"stop loop" deletes the recurring cron jobs', { timeoutMs: 20_000 }, async ($, on) => {
  const deleted = crons(on)
  const w = world(on, ['Stop the loop.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(deleted).toEqual(['c1'])
  expect(w.spoken).toContain('Loop stopped.')
  await $.command.run(talk)
})

test('"stop" also clears the goal and stops the loop', { timeoutMs: 20_000 }, async ($, on) => {
  const ran = goals(on)
  const deleted = crons(on)
  const aborted: string[] = []
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  const w = world(on, ['Stop.'])
  await $.command.run(goalCmd('finish the tests'))
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(aborted).toEqual(['t1'])
  expect(ran).toContain('goal|clear')
  expect(deleted).toEqual(['c1'])
  expect(w.spoken).toContain('Stopped, and cleared the goal and stopped the loop.')
  await $.command.run(talk)
})

test('a slash command with no answer drops after 30 seconds', { timeoutMs: 20_000 }, async ($, on) => {
  const ran = goals(on)
  on('command.list', () => ({ value: [{ name: 'goal', description: '', source: 'builtin' }] }) as never)
  const w = world(on, ['Slash goal.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  await w.clock.advance(30_000)
  expect(ran).toEqual([])
  expect(w.spoken).toContain('Dropped the goal command. No answer came.')
  await $.command.run(talk)
})

test('a goal whose check ends the turn leaves the panel', { timeoutMs: 20_000 }, async ($, on) => {
  const ran = goals(on)
  const w = world(on, ['Clear goal.'])
  await $.command.run(goalCmd('finish the tests'))
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.session.append({ message: { type: 'attachment', name: 'goal_status', content: [] }, door: 'attachment', origin: { kind: 'engine' } } as never).catch(() => {})
  await $.turn.complete({ ...turn, answer: 'All tests pass.' })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(ran).toEqual(['goal|finish the tests'])
  expect(w.spoken).toContain('No goal is set.')
  await $.command.run(talk)
})

test('"mute" ignores speech until "unmute"', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['Mute.', 'Check the runner.', 'Unmute.', 'Check the runner again.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['Check the runner again.'])
  expect(w.spoken).toContain('Muted. Say unmute to come back.')
  expect(w.spoken).toContain('Unmuted.')
  await $.command.run(talk)
})

test('"deafen" ignores speech and keeps replies on screen until /talk unmute', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['Deafen.', 'Check the runner.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'It runs every night at two.' })
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  expect(w.spoken).toContain('Deafened. Say unmute to come back.')
  expect(w.spoken).not.toContain('It runs every night at two.')
  await $.command.run({ ...talk, args: 'unmute' })
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'It runs every night at three.' })
  await w.clock.advance(0)
  expect(w.spoken).toContain('It runs every night at three.')
  await $.command.run(talk)
})

const two = (waiting: object = { label: 'fa-reader', state: 'asking', rank: 3, floor: false }) => ({
  sessions: [{ label: 'ORION', state: 'idle', rank: 0, floor: true }, waiting],
  holder: 'ORION',
  floor: true,
  mute: '',
})

test('with one session, "next" and "switch to" are ordinary speech', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['Switch to the settings page.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['Switch to the settings page.'])
  expect(w.calls.some(c => c.startsWith('/floor'))).toBe(false)
  await $.command.run(talk)
})

test('"next" passes the mic to the next waiting session', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [two(), 'Next.'], { replies: { '/next': 'ok fa-reader' } })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.calls.some(c => c.startsWith('/next?session='))).toBe(true)
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

test('"switch to" moves the mic, and falls through to a prompt when no session matches', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [two(), 'Switch to fa reader.'], { replies: { '/floor': 'ok fa-reader' } })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.calls).toContain('/floor fa reader')
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

test('"switch to" with no matching session is sent as a prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [two(), 'Go to the settings page.'], { replies: { '/floor': 'none' } })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['Go to the settings page.'])
  await $.command.run(talk)
})

test('"what\'s waiting" names the other sessions and what they hold', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [two({ label: 'fa-reader', state: 'waiting', rank: 3, floor: false }), "What's waiting?"])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.spoken).toContain('fa-reader has a question.')
  await $.command.run(talk)
})

test('a finished answer is sent to the server as a ranked result', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'Two nights are missing. Should I backfill them?' })
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'The backfill failed on night two.' })
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, answer: 'Backfilled both nights.' })
  await w.clock.advance(0)
  const ranks = w.calls.filter(c => c.includes('kind=result')).map(c => c.match(/rank=(\d)/)?.[1])
  expect(ranks).toEqual(['3', '2', '1'])
  await $.command.run(talk)
})

test('mute set in another session applies here', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [{ ...two(), mute: 'muted' }, 'Check the runner.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

async function panel($: Parameters<Parameters<typeof test>[2]>[0]) {
  return $.ui.mount({ plugin: 'no-hands', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
}

test('panel buttons mute, deafen, and turn voice off', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  const ui = await panel($)
  await ui.press({ key: 'mic', in: 'voice' } as never)
  await w.clock.advance(0)
  await ui.press({ key: 'sound', in: 'voice' } as never)
  await w.clock.advance(0)
  await ui.press({ key: 'mic', in: 'voice' } as never)
  await w.clock.advance(0)
  expect(w.calls).toContain('/mute muted')
  expect(w.calls).toContain('/mute deafened')
  expect(w.spoken).toContain('Unmuted.')
  await ui.press({ key: 'off', in: 'voice' } as never)
  await w.clock.advance(0)
  expect(w.toasts).toContain('Voice mode off.')
})

test('the stop button stops the main work', { timeoutMs: 20_000 }, async ($, on) => {
  const aborted: string[] = []
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  const ui = await panel($)
  await ui.press({ key: 'stop', in: 'voice' } as never)
  await w.clock.advance(0)
  expect(aborted).toEqual(['t1'])
  await $.command.run(talk)
})

test('words queued before "stop" are dropped, not sent with a later turn', { timeoutMs: 20_000 }, async ($, on) => {
  on('turn.abort', () => ({ value: undefined }))
  const w = world(on, ['also check the logs', 'Stop.'])
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  await $.turn.complete({ ...turn, isAborted: true, reason: 'aborted' as never })
  await w.clock.advance(0)
  expect(w.spoken).toContain('Dropped the queued message.')
  await $.turn.start({ text: 'what time is it', turnId: 't2' } as never)
  await $.turn.complete({ ...turn, answer: 'It is noon.', turnId: 't2' })
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  expect(w.spoken).toContain('It is noon.')
  await $.command.run(talk)
})

test('a prompt another hook blocks does not leave voice stuck working', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['run the tests', 'and check the logs'], { isDropping: true })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['run the tests', 'and check the logs'])
  await $.command.run(talk)
})

test('"next" while Claude is idle is sent as a prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['Next.'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['Next.'])
  await $.command.run(talk)
})

test('another session taking the mic turns voice off here without stopping the server', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [], { isMoved: true })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.toasts[0]).toContain('another Claude Code session')
  expect(w.quits()).toBe(0)
})

test('"clear cue" empties the queue', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, ['also check the runner', 'Clear cue.'])
  await $.command.run(talk)
  await $.turn.start({ text: 'run the tests', turnId: 't1' } as never)
  await w.clock.advance(0)
  expect(w.spoken).toContain('Cleared.')
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  await $.command.run(talk)
})

test('/talk model switches the speech recognition model and rejects unknown names', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, [])
  await $.command.run(talk)
  await w.clock.advance(0)
  const bad = await $.command.run({ ...talk, args: 'model huge' })
  expect(JSON.stringify(bad)).toContain('Usage')
  await $.command.run({ ...talk, args: 'model small' })
  await w.clock.advance(0)
  expect(w.models).toEqual(['small'])
  expect(w.spoken).toContain('Switched to the small model.')
  await $.command.run(talk)
})
