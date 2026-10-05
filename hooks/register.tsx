import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoicePhase } from '../types'

const phase = atom({ plugin: 'no-hands', key: 'phase' } as const, null)
const words = atom({ plugin: 'no-hands', key: 'words' } as const, '')

const VOICE_SECTION =
  'Voice mode is on: the user hears your replies read aloud. ' +
  'When a request needs tool calls, write one sentence before the first tool call that starts with ' +
  '"Plan:" and names the steps in under 12 plain words, for example "Plan: run the tests, then push." ' +
  'No code, file paths or markdown in it.'

const SPOKEN_PROMPT =
  'Voice mode is on. Write what I will hear about this turn, in as few words as possible. ' +
  'If you did work, start with "Done:" and say what you did and the result in one or two short sentences, ' +
  'for example "Done: all tests passed and it is pushed." ' +
  'If you only answered a question, give the answer in one or two short sentences. ' +
  'Plain words only: no code, file paths, URLs, markdown, or lists. ' +
  'If you need a decision from me, end with one short question. Output only the words to speak.'

const DISCARD = /^\W*never ?mind\W*$/i

type Heard = { partial?: string; final?: string; timeout?: boolean; stopped?: boolean; error?: string }

let isActive = false
let listenId = 0
let speech: Promise<void> = Promise.resolve()

function socket($: EngineInterface) {
  return `${$.plugin.root}/.voiced.sock`
}

async function call($: EngineInterface, path: string, body = '') {
  const argv = ['curl', '-s', '--unix-socket', socket($), '-X', 'POST', '--data-binary', '@-', `http://voice${path}`]
  const r = await $.process.run(argv, { stdin: body, timeoutMs: 300_000 }).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout : undefined
}

function plain(text: string) {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#*_>|]/g, '')
    .split(/\n\s*\n/)
    .find(p => p.trim().length > 0) ?? ''
  return prose.trim().slice(0, 500)
}

function speak($: EngineInterface, text: string) {
  const id = listenId
  speech = speech.then(async () => {
    if (!text || id !== listenId || !isActive) return
    if ((await call($, '/speak', text)) === undefined) await $.audio.speak(text).catch(() => {})
  })
  return speech
}

function show($: EngineInterface, next: VoicePhase | null) {
  void update($, phase, () => next)
}

function hear($: EngineInterface, text: string) {
  void update($, words, () => text)
}

function interrupt($: EngineInterface) {
  listenId++
  void call($, '/stop')
}

function turnOff($: EngineInterface, why?: string) {
  isActive = false
  listenId++
  void call($, '/quit')
  show($, null)
  hear($, '')
  if (why) $.ui.toast(why)
}

async function listen($: EngineInterface) {
  const id = ++listenId
  show($, 'listening')
  hear($, '')
  let heard: string | undefined
  let why = 'Voice mode off: could not reach the voice server.'
  try {
    let pending = ''
    const stream = $.process.spawn({ argv: ['curl', '-sN', '--unix-socket', socket($), 'http://voice/listen'] })
    for await (const { stream: pipe, text } of stream) {
      if (pipe !== 'stdout') continue
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const msg = JSON.parse(line) as Heard
        if (id !== listenId) continue
        if (msg.partial !== undefined) hear($, msg.partial)
        if (msg.final !== undefined) heard = msg.final
        if (msg.timeout) why = 'Voice mode off: nothing heard for 3 minutes.'
        if (msg.error) why = `Voice mode off: ${msg.error}`
      }
    }
  } catch {}

  if (id !== listenId || !isActive) return
  if (heard === undefined) return turnOff($, why)
  if (!/[a-z0-9]/i.test(heard) || DISCARD.test(heard)) return listen($)
  hear($, heard)
  show($, 'working')
  await $.prompt.submit({ text: heard, asUser: true })
  hear($, '')
}

async function respond($: EngineInterface, answer: string) {
  show($, 'preparing')
  const forked = await $.model.fork({ prompt: SPOKEN_PROMPT }).catch(() => undefined)
  if (!isActive) return
  const spoken = forked?.isAnswered ? forked.text.trim() : plain(answer) || 'Done.'
  show($, 'speaking')
  const id = listenId
  await speak($, spoken.slice(0, 4000))
  if (isActive && id === listenId) await listen($)
}

async function start($: EngineInterface) {
  show($, 'loading')
  const r = await $.process.run([`${$.plugin.root}/voiced`, socket($)], { timeoutMs: 600_000 }).catch(() => undefined)
  if (!isActive) return
  if (r?.exitCode !== 0) return turnOff($, `Voice mode off: the voice server did not start. ${r?.stdout.trim() ?? ''}`)
  show($, 'speaking')
  const id = listenId
  await speak($, "I'm listening.")
  if (isActive && id === listenId) await listen($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'talk',
      description: 'Hands-free voice mode: speaks each reply, then listens for yours. Run again to stop.',
    })
    return next(e)
  })

  on('command.run', { command: 'talk' }, async $ => {
    if (isActive) {
      turnOff($)
      return { text: 'Voice mode off.' }
    }
    isActive = true
    $.clock.after(0, () => void start($))
    return { text: 'Voice mode on. Pause, or say "go ahead", to send. Run /talk again to end it.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!isActive) return result
    return { ...result, sections: [...result.sections, { id: 'no-hands-voice', text: VOICE_SECTION, scope: 'session' as const }] }
  })

  on('turn.step', async function* ($, e, next) {
    if (!isActive || e.agentId !== undefined || e.index !== 0) return yield* next(e)
    let preface = ''
    const steps = next(e)
    for await (const chunk of steps) {
      if (chunk.kind === 'text') preface += chunk.text
      if (chunk.kind === 'stop' && chunk.stopReason === 'tool_use') {
        const sentences = plain(preface).match(/[^.!?]+[.!?]?/g) ?? []
        void speak($, sentences.slice(0, 2).join(' ').trim())
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isActive || e.agentId !== undefined) return result
    if (e.isAborted) {
      turnOff($, 'Voice mode paused. Run /talk to resume.')
      return result
    }
    const answer = e.reason === 'answer' ? e.answer : undefined
    $.clock.after(0, () => void (answer === undefined ? listen($) : respond($, answer)))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, phase)
    if (!current || e.props.hasSurvey) return next(e)
    const said = await read($, words)
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="voice" module="./indicator.tsx" props={{ phase: current, words: said }} />
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="green">Voice: {current}</Text>
        {said ? <Text dimColor>{said}</Text> : null}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (isActive && e.origin.kind === 'composer') {
      interrupt($)
      hear($, '')
      show($, 'working')
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (isActive) turnOff($)
    return next(e)
  })
}
