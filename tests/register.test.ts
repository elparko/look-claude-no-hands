import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, heard: string | string[], { speakExit = 0, startExit = 0 } = {}) {
  const clock = mock.clock(on)
  const queue = typeof heard === 'string' ? [heard] : [...heard]
  const spoken: string[] = []
  const said: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const ok = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('model.fork', () => ({ value: { isAnswered: true as const, text: 'Deploy finished.', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('audio.speak', (_$, e) => {
    said.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0]?.endsWith('/voiced')) return ok(startExit)
    const url = e.argv[e.argv.length - 1] ?? ''
    if (url.endsWith('/speak')) {
      if (speakExit === 0) spoken.push(e.init?.stdin ?? '')
      return ok(speakExit, 'done')
    }
    return ok(0, 'ok')
  })
  on('process.spawn', async function* () {
    const text = queue.length > 1 ? queue.shift()! : queue[0]!
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ partial: text.split(' ')[0] })}\n` }
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ final: text })}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, spoken, said, submitted, toasts }
}

const talk = { command: 'talk', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const turn = { answer: 'Pushed **abc123**.\n\n```sh\ngit log\n```', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

test('voice mode starts the server, greets, and submits what it hears', async ($, on) => {
  const w = world(on, 'check the runner next')
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.spoken).toEqual(["I'm listening."])
  expect(w.submitted).toEqual(['check the runner next'])
})

test('a finished turn is spoken, then the reply heard is submitted', async ($, on) => {
  const w = world(on, 'check the runner next')
  await $.command.run(talk)
  await w.clock.advance(0)
  w.submitted.length = 0
  w.spoken.length = 0

  await $.turn.complete(turn)
  await w.clock.advance(0)

  expect(w.spoken).toEqual(['Deploy finished.'])
  expect(w.submitted).toEqual(['check the runner next'])
})

test('turns are not spoken while voice mode is off', async ($, on) => {
  const w = world(on, 'hello')
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.spoken).toEqual([])
  expect(w.submitted).toEqual([])
})

test('falls back to the system voice when the server cannot speak', async ($, on) => {
  const w = world(on, 'hello', { speakExit: 7 })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.said).toEqual(["I'm listening."])
})

test('voice mode turns off with a notice when the server does not start', async ($, on) => {
  const w = world(on, 'hello', { startExit: 1 })
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])
  expect(w.toasts[0]).toContain('did not start')
})

test('a transcript with no words is not submitted', async ($, on) => {
  const w = world(on, ['...', 'run the tests'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['run the tests'])
})

test('saying never mind discards the transcript', async ($, on) => {
  const w = world(on, ['Never mind.', 'run the tests'])
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['run the tests'])
})

test('a turn that ends without an answer goes back to listening', async ($, on) => {
  const w = world(on, 'try again')
  await $.command.run(talk)
  await w.clock.advance(0)
  w.submitted.length = 0

  await $.turn.complete({ ...turn, reason: 'max_turns' as never })
  await w.clock.advance(0)
  expect(w.submitted).toEqual(['try again'])
})

const band = {
  plugin: 'no-hands',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

test('the band above the prompt shows the voice state only while voice mode is on', async ($, on) => {
  const w = world(on, 'check the runner next')
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  for (const surface of ['vscode', 'terminal', 'desktop'] as const) {
    const off = await $.ui.mount({ ...band, surface })
    expect(JSON.stringify(await off.drawn())).not.toMatch(/working/i)
    await off.unmount()

    await $.command.run(talk)
    await w.clock.advance(0)
    const ui = await $.ui.mount({ ...band, surface })
    const tree = surface === 'vscode' ? await ui.drawn() : await ui.drawn({ in: 'voice' })
    expect(JSON.stringify(tree)).toContain(surface === 'vscode' ? 'working' : 'Working')
    await ui.unmount()
    await $.command.run(talk)
  }
})
