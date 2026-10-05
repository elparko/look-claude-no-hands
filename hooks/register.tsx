import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoicePhase } from '../types'

const phase = atom({ plugin: 'no-hands', key: 'phase' } as const, null)

const SPOKEN_PROMPT =
  'Voice mode is on. Rewrite your last reply as what you would say out loud to me: ' +
  '1 to 4 short sentences in plain words. No code, file paths, URLs, markdown, or lists. ' +
  'If the reply asked me a question or needs a decision from me, end with that question. ' +
  'Output only the words to speak.'

const STOP = /^\W*(stop listening|stop voice|end voice|voice off)\b/i
const DISCARD = /^\W*never ?mind\W*$/i

let isActive = false
let listenId = 0

function fallbackSpoken(answer: string) {
  const prose = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#*_>|]/g, '')
    .split(/\n\s*\n/)
    .find(p => p.trim().length > 0) ?? 'Done.'
  return prose.trim().slice(0, 500)
}

async function speak($: EngineInterface, text: string) {
  const r = await $.process.run([`${$.plugin.root}/speak.sh`, text], { timeoutMs: 120_000 }).catch(() => undefined)
  if (r && (r.exitCode === 0 || r.exitCode > 128)) return
  await $.audio.speak(text).catch(() => {})
}

function show($: EngineInterface, next: VoicePhase | null) {
  void update($, phase, () => next)
}

function stopRecording($: EngineInterface) {
  listenId++
  void $.process.run(['pkill', '-f', 'claude-voice-talk']).catch(() => {})
}

function turnOff($: EngineInterface, why?: string) {
  isActive = false
  stopRecording($)
  show($, null)
  if (why) $.ui.toast(why)
}

async function listen($: EngineInterface) {
  const id = ++listenId
  show($, 'listening')
  let heard = ''
  try {
    const r = await $.process.run([`${$.plugin.root}/listen.sh`], { timeoutMs: 180_000 })
    if (id !== listenId || !isActive) return
    if (r.exitCode !== 0) return turnOff($, 'Voice mode off: recording or transcription failed.')
    heard = r.stdout.trim()
  } catch {
    if (id === listenId && isActive) turnOff($, 'Voice mode off: nothing heard for 3 minutes.')
    return
  }

  if (!/[a-z0-9]/i.test(heard) || DISCARD.test(heard)) return listen($)
  if (STOP.test(heard)) {
    isActive = false
    show($, null)
    await speak($, 'Voice mode off.')
    return
  }
  show($, 'working')
  await $.prompt.submit({ text: heard, asUser: true })
}

async function respond($: EngineInterface, answer: string) {
  show($, 'preparing')
  const forked = await $.model.fork({ prompt: SPOKEN_PROMPT }).catch(() => undefined)
  if (!isActive) return
  const spoken = forked?.isAnswered ? forked.text.trim() : fallbackSpoken(answer)
  show($, 'speaking')
  const id = listenId
  await speak($, spoken.slice(0, 4000))
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
    $.clock.after(0, () => {
      void (async () => {
        const id = listenId
        await speak($, 'Voice mode on. Go ahead.')
        if (isActive && id === listenId) await listen($)
      })()
    })
    return { text: 'Voice mode on. Say "stop listening" or run /talk again to end it.' }
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
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="voice" module="./indicator.tsx" props={{ phase: current }} />
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="green">Voice: {current}</Text>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (isActive && e.origin.kind === 'composer') {
      stopRecording($)
      show($, 'working')
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (isActive) turnOff($)
    return next(e)
  })
}
