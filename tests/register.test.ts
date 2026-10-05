import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

function world(on: On, heard: string) {
  const clock = mock.clock(on)
  const spoken: string[] = []
  const submitted: string[] = []
  on('model.fork', () => ({ value: { isAnswered: true as const, text: 'Deploy finished.', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  on('audio.speak', (_$, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: heard, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, spoken, submitted }
}

const talk = { command: 'talk', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const turn = { answer: 'Pushed **abc123**.\n\n```sh\ngit log\n```', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }

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

test('saying stop listening ends voice mode without submitting', async ($, on) => {
  const w = world(on, 'Stop listening.')
  await $.command.run(talk)
  await w.clock.advance(0)
  expect(w.submitted).toEqual([])

  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.spoken).not.toContain('Deploy finished.')
})

test('turns are not spoken while voice mode is off', async ($, on) => {
  const w = world(on, 'hello')
  await $.turn.complete(turn)
  await w.clock.advance(0)
  expect(w.spoken).toEqual([])
  expect(w.submitted).toEqual([])
})
