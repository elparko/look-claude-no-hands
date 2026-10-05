import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, said: string[], { speakExit = 0, startExit = 0 } = {}) {
  const clock = mock.clock(on)
  const spoken: string[] = []
  const systemSaid: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
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
    if (url.endsWith('/speak')) {
      if (speakExit === 0) spoken.push(e.init?.stdin ?? '')
      return ok(speakExit, 'done')
    }
    if (url.endsWith('/quit')) quit()
    return ok(0, 'ok')
  })
  on('process.spawn', async function* () {
    const line = (msg: object) => ({ stream: 'stdout' as const, text: `${JSON.stringify(msg)}\n` })
    const quitting = new Promise<void>(resolve => (quit = resolve))
    yield line({ ready: true })
    for (const text of said) {
      yield line({ start: true })
      yield line({ partial: text.split(' ')[0] })
      yield line({ final: text })
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
    return { text: e.text }
  })
  return { clock, spoken, systemSaid, submitted, toasts }
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
