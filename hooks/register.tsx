import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoicePhase } from '../types'

const phase = atom({ plugin: 'no-hands', key: 'phase' } as const, null)
const words = atom({ plugin: 'no-hands', key: 'words' } as const, '')
const reply = atom({ plugin: 'no-hands', key: 'reply' } as const, '')
const queue = atom({ plugin: 'no-hands', key: 'queue' } as const, [] as string[])

const VOICE_SECTION =
  'Voice mode is on: the user is talking with you out loud and hears your text read aloud. ' +
  'Talk the way a sharp colleague would across the desk. ' +
  'Answer questions directly, in a sentence or two, unless they ask you to explain more. ' +
  'Before work that needs tool calls, give a one-sentence heads-up of what you are about to do, in plain words. ' +
  'During long work, a short line between steps when something worth knowing happens: a result, a surprise, a change of plan. ' +
  'Never restate the request, narrate routine steps, hedge, or add caveats that do not change what the user should do. ' +
  'No code, file paths or markdown in anything meant to be heard. ' +
  'The user may speak while you work; their words arrive as a note after a tool result. Treat them as a message from the user.'

const SPOKEN_PROMPT =
  'I am listening, not reading. Tell me what matters from this turn the way a sharp colleague would across the desk. ' +
  'If I asked a question, answer it. If you did work, lead with the result and anything I need to know: ' +
  'a failure, a surprise, or a decision for me. ' +
  'Skip what I already know: do not restate my request, list steps, or read out code, file paths, URLs or numbers I do not need. ' +
  'Usually one to three sentences; more only if I asked for an explanation. No labels, no lists, no filler. ' +
  'Ask a question only if you need a decision from me. Output only the words to speak.'

const UPDATE_GAP_MS = 20_000
const SHORT_ANSWER = 300
const DISCARD = /^\W*never ?mind\W*$/i

type Heard = { ready?: boolean; start?: boolean; partial?: string; final?: string; error?: string }

let isActive = false
let isHearing = false
let isWorking = false
let isPreparing = false
let speakingCount = 0
let speechId = 0
let sessionId = 0
let lastSpokenAt = 0
let pending: string[] = []
let micLevel: string | undefined
let voiceName: string | undefined

const VOICES =
  'American women: af_heart (default), af_bella, af_nicole, af_sarah, af_nova, af_sky. ' +
  'American men: am_michael, am_fenrir, am_puck, am_eric, am_liam, am_adam. ' +
  'British women: bf_emma, bf_isabella, bf_alice, bf_lily. British men: bm_george, bm_fable, bm_lewis, bm_daniel.'
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

function isSpeakable(answer: string) {
  return answer.length <= SHORT_ANSWER && !/[`#*|\[\]/<>]|\n\s*[-\d]/.test(answer)
}

function refresh($: EngineInterface) {
  const next: VoicePhase | null = !isActive
    ? null
    : isHearing
      ? 'listening'
      : speakingCount > 0
        ? 'speaking'
        : isPreparing
          ? 'preparing'
          : isWorking
            ? 'working'
            : 'listening'
  void update($, phase, () => next)
}

function hear($: EngineInterface, text: string) {
  void update($, words, () => text)
}

function showReply($: EngineInterface, text: string) {
  void update($, reply, () => text)
}

function takePending($: EngineInterface) {
  const text = pending.join('\n')
  pending = []
  void update($, queue, () => [])
  return text
}

function speak($: EngineInterface, text: string) {
  const id = speechId
  lastSpokenAt = Date.now()
  speech = speech.then(async () => {
    if (!text || id !== speechId || !isActive) return
    speakingCount++
    showReply($, text)
    refresh($)
    const result = await call($, '/speak', text)
    speakingCount--
    refresh($)
    if (result === undefined && isActive && !isHearing) await $.audio.speak(text).catch(() => {})
  })
  return speech
}

function silence($: EngineInterface) {
  speechId++
  void call($, '/stop')
}

function turnOff($: EngineInterface, why?: string) {
  isActive = false
  isHearing = false
  sessionId++
  speechId++
  takePending($)
  void call($, '/quit')
  refresh($)
  hear($, '')
  showReply($, '')
  if (why) $.ui.toast(why)
}

function onHeard($: EngineInterface, text: string) {
  hear($, '')
  if (!/[a-z0-9]/i.test(text) || DISCARD.test(text)) return
  if (isWorking) {
    pending.push(text)
    void update($, queue, () => [...pending])
    return
  }
  isWorking = true
  refresh($)
  void $.prompt.submit({ text, asUser: true })
}

async function converse($: EngineInterface) {
  const id = sessionId
  let why = 'Voice mode off: lost the connection to the voice server.'
  try {
    let rest = ''
    const stream = $.process.spawn({ argv: ['curl', '-sN', '--unix-socket', socket($), 'http://voice/listen'] })
    for await (const { stream: pipe, text } of stream) {
      if (id !== sessionId) return
      if (pipe !== 'stdout') continue
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const msg = JSON.parse(line) as Heard
        if (msg.ready) void speak($, "I'm listening.")
        if (msg.start) {
          isHearing = true
          speechId++
          showReply($, '')
          refresh($)
        }
        if (msg.partial !== undefined && isHearing) hear($, msg.partial)
        if (msg.final !== undefined) {
          isHearing = false
          refresh($)
          onHeard($, msg.final.trim())
        }
        if (msg.error) why = `Voice mode off: ${msg.error}`
      }
    }
  } catch {}
  if (id === sessionId && isActive) turnOff($, why)
}

async function start($: EngineInterface) {
  refresh($)
  void update($, phase, () => 'loading')
  const env: Record<string, string> = {
    ...(micLevel ? { NO_HANDS_LEVEL: micLevel } : {}),
    ...(voiceName ? { NO_HANDS_VOICE: voiceName } : {}),
  }
  const r = await $.process.run([`${$.plugin.root}/voiced`, socket($)], { env, timeoutMs: 600_000 }).catch(() => undefined)
  if (!isActive) return
  if (r?.exitCode !== 0) return turnOff($, `Voice mode off: the voice server did not start. ${r?.stdout.trim() ?? ''}`)
  refresh($)
  await converse($)
}

async function respond($: EngineInterface, answer: string) {
  if (pending.length > 0) {
    const text = takePending($)
    isWorking = true
    refresh($)
    void $.prompt.submit({ text, asUser: true })
    return
  }
  let spoken = answer.trim()
  if (!isSpeakable(spoken)) {
    isPreparing = true
    refresh($)
    const forked = await $.model.fork({ prompt: SPOKEN_PROMPT }).catch(() => undefined)
    isPreparing = false
    refresh($)
    spoken = forked?.isAnswered ? forked.text.trim() : plain(answer) || 'Done.'
  }
  if (isActive && !isWorking) await speak($, spoken.slice(0, 4000))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'talk',
      description: 'Hands-free voice mode: talk to Claude and hear its replies. Run again to stop.',
    })
    return next(e)
  })

  on('command.run', { command: 'talk' }, async ($, e) => {
    const [word, value] = e.args.trim().split(/\s+/)
    if (word === 'level') {
      if (!value || !(Number(value) > 0 && Number(value) < 1)) {
        return { text: 'Usage: /talk level 0.05. A number from 0 to 1; the default is 0.03. Higher ignores more background sound.' }
      }
      micLevel = value
      if (isActive) await call($, '/level', value)
      return { text: `Mic level set to ${value}. Sound below it is ignored.` }
    }
    if (word === 'voice') {
      if (!value || !/^[ab][fm]_[a-z]+$/.test(value)) return { text: `Usage: /talk voice am_michael. ${VOICES}` }
      voiceName = value
      if (isActive) {
        await call($, '/voice', value)
        void speak($, 'This is how I sound now.')
      }
      return { text: `Voice set to ${value}.` }
    }
    if (isActive) {
      turnOff($)
      return { text: 'Voice mode off.' }
    }
    isActive = true
    isWorking = false
    $.clock.after(0, () => void start($))
    return { text: 'Voice mode on. Talk any time; pause to send. /talk level 0.05 ignores more background sound. Run /talk again to end it.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!isActive) return result
    return { ...result, sections: [...result.sections, { id: 'no-hands-voice', text: VOICE_SECTION, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (isActive) {
      isWorking = true
      showReply($, '')
      refresh($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!isActive || e.agentId !== undefined) return yield* next(e)
    const isDue = e.index === 0 || Date.now() - lastSpokenAt >= UPDATE_GAP_MS
    let said = ''
    for await (const chunk of next(e)) {
      if (chunk.kind === 'text') said += chunk.text
      if (chunk.kind === 'stop' && chunk.stopReason === 'tool_use' && isDue && pending.length === 0) {
        const sentences = plain(said).match(/[^.!?]+[.!?]?/g) ?? []
        void speak($, sentences.slice(0, 2).join(' ').trim())
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!isActive || e.agentId !== undefined || pending.length === 0 || result.deny !== undefined) return result
    const text = takePending($)
    const note = `The user just said this out loud while you were working: "${text}". Treat it as a message from them now.`
    return { ...result, context: [...(result.context ?? []), note] }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isActive || e.agentId !== undefined) return result
    isWorking = false
    refresh($)
    if (e.isAborted) {
      silence($)
      return result
    }
    const answer = e.reason === 'answer' ? e.answer : ''
    $.clock.after(0, () => void respond($, answer))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, phase)
    if (!current || e.props.hasSurvey) return next(e)
    const said = await read($, words)
    const spoken = await read($, reply)
    const waiting = await read($, queue)
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="voice" module="./indicator.tsx" props={{ phase: current, words: said, reply: spoken, queue: [...waiting] }} />
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {spoken ? <Text>{spoken}</Text> : null}
        <Text color="green">Voice: {current}</Text>
        {said ? <Text dimColor>{said}</Text> : null}
        {waiting.map((item, i) => (
          <Text key={`q${i}`} dimColor>
            Waiting for Claude: {item}
          </Text>
        ))}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (isActive && e.origin.kind === 'composer') {
      silence($)
      isWorking = true
      refresh($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (isActive) turnOff($)
    return next(e)
  })
}
