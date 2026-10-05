import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentState, VoicePhase } from '../types'

const phase = atom({ plugin: 'no-hands', key: 'phase' } as const, null)
const words = atom({ plugin: 'no-hands', key: 'words' } as const, '')
const reply = atom({ plugin: 'no-hands', key: 'reply' } as const, '')
const queue = atom({ plugin: 'no-hands', key: 'queue' } as const, [] as string[])
const sent = atom({ plugin: 'no-hands', key: 'sent' } as const, '')
const agents = atom({ plugin: 'no-hands', key: 'agents' } as const, [] as AgentRow[])
const goal = atom({ plugin: 'no-hands', key: 'goal' } as const, '')
const loop = atom({ plugin: 'no-hands', key: 'loop' } as const, '')

const VOICE_SECTION =
  'Voice mode is on: the user is talking with you out loud and hears your text read aloud. ' +
  'Talk the way a sharp colleague would across the desk. ' +
  'Answer questions directly, in a sentence or two, unless they ask you to explain more. ' +
  'Before work that needs tool calls, give a one-sentence heads-up of what you are about to do, in plain words. ' +
  'During long work, a short line between steps when something worth knowing happens: a result, a surprise, a change of plan. ' +
  'Never restate the request, narrate routine steps, hedge, or add caveats that do not change what the user should do. ' +
  'No code, file paths or markdown in anything meant to be heard. ' +
  'The user may speak while you work; their words arrive as a note after a tool result. Treat them as a message from the user. ' +
  'When you start subagents, give each a short distinct name with the Agent tool\'s name parameter, so the user can address it by voice.'

const SPOKEN_PROMPT =
  'I am listening, not reading. Tell me what matters from this turn the way a sharp colleague would across the desk. ' +
  'If I asked a question, answer it. If you did work, lead with the result and anything I need to know: ' +
  'a failure, a surprise, or a decision for me. ' +
  'Skip what I already know: do not restate my request, list steps, or read out code, file paths, URLs or numbers I do not need. ' +
  'Usually one to three sentences; more only if I asked for an explanation. No labels, no lists, no filler. ' +
  'Ask a question only if you need a decision from me. Output only the words to speak.'

const ASIDE = /\?\s*$|^\W*(by the way|btw|quick question)\b/i

function asidePrompt(question: string) {
  return (
    `I asked this out loud while you were working: "${question}". ` +
    'If it is a question you can answer from what you already know in this conversation, answer it ' +
    'in one to three short spoken sentences, plain words, no code, file paths or lists. ' +
    'If it is an instruction or a change to the current work rather than a question, reply with exactly QUEUE.'
  )
}

const UPDATE_GAP_MS = 20_000
const SHORT_ANSWER = 300
const DISCARD = /^\W*never ?mind\W*$/i
const CANCEL = /^\W*(cancel( that)?|scratch that)\W*$/i
const CLEAR = /^\W*clear( the)? (queue|cue|q)\W*$/i
const SEND_NOW = /^\W*(send (it |that )?now|next)\W*$/i
const STOP = /^\W*(?:(?:okay|ok|hey|claude)\W+)*(?:stop|pause|hold on|hold up|wait)(?:\W+(?:stop|pause|wait|it|that|working|claude|a sec(?:ond)?|a minute))*\W*$/i
const AGENT_STATUS = /^\W*(agent status|status|what are (the )?agents doing|how are (the )?agents doing)\W*$/i
const AGENT_TELL = /^\W*(?:tell|ask|message)\s+(.+?)(?:\s+to\s+|\s+that\s+|,\s*|:\s*|\s+(?=(?:what|whether|if|how|why|when|where|which)\b))(.+)$/i
const AGENT_STOP = /^\W*(?:stop|kill|cancel)\s+(.+?)\W*$/i
const FINISH_GAP_MS = 4_000
const SLASH = /(?:\bslash\s+|(?:^|\s)\/(?=\w))(.+)$/i
const FILLER = /^\W*(?:(?:okay|ok|so|alright|um|uh|and|then)\b\W*)+/i
const YES = /^\W*(yes|yeah|yep|yup|sure|ok(ay)?|go( ahead)?|do it|start( it)?|run it|(we('re)? )?good|sounds good|correct|right)\W*$/i
const GOAL_CLEAR = /^\W*(?:(?:okay|ok|so|hey)\W+)*(?:clear|stop|end|cancel|drop|remove|delete)\s+(?:the\s+)?goal\W*$/i
const LOOP_STOP = /^\W*(?:(?:okay|ok|so|hey)\W+)*(?:stop|end|cancel|kill|clear)\s+(?:the\s+)?loops?\W*$/i
const GOAL_OFF = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
const CONFIRM_MS = 30_000
const NO = /^\W*(?:(?:okay|ok|so|um|uh|oh)\W+)*(?:no|nope|cancel|drop|stop|forget|scratch|never ?mind|don'?t)\b/i

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const SOUNDS_LIKE: Record<string, number> = { won: 1, to: 2, too: 2, tree: 3, for: 4, fore: 4, ate: 8 }

type Heard = { ready?: boolean; start?: boolean; partial?: string; final?: string; error?: string; moved?: boolean }

let isActive = false
let isHearing = false
let isWorking = false
let isPreparing = false
let speakingCount = 0
let speechId = 0
let sessionId = 0
let lastSpokenAt = 0
let pending: string[] = []
let turnId: string | undefined
let micLevel: string | undefined
let voiceName: string | undefined
let whisperModel: string | undefined
let pendingCommand: { name: string; args: string } | undefined
let finished: AgentRow[] = []
let isFinishDue = false
let isGoalChecked = false
let wakeAt = 0

const MODELS = 'turbo (1.6 GB, default, most accurate), small (480 MB), base (145 MB), tiny (75 MB, most mistakes)'

const VOICES =
  'American women: af_bella (default), af_heart, af_nicole, af_sarah, af_nova, af_sky. ' +
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

function speak($: EngineInterface, text: string, id = speechId) {
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

function turnOff($: EngineInterface, why?: string, isQuitting = true) {
  isActive = false
  isHearing = false
  pendingCommand = undefined
  sessionId++
  speechId++
  takePending($)
  if (isQuitting) void call($, '/quit')
  refresh($)
  hear($, '')
  showReply($, '')
  showSent($, '')
  if (why) $.ui.toast(why)
}

function showSent($: EngineInterface, text: string) {
  void update($, sent, () => text)
}

function submit($: EngineInterface, text: string) {
  showSent($, text)
  isWorking = true
  refresh($)
  void $.prompt.submit({ text, asUser: true }).then(
    r => r.drop !== undefined && notWorking($),
    () => notWorking($),
  )
}

function notWorking($: EngineInterface) {
  isWorking = false
  refresh($)
}

function showQueue($: EngineInterface) {
  void update($, queue, () => [...pending])
}

async function stopWork($: EngineInterface) {
  if (!isWorking || turnId === undefined) return
  await $.turn.abort({ turnId }).catch(() => {})
}

async function clearGoal($: EngineInterface) {
  if (!(await read($, goal))) return false
  await $.command.run({ command: 'goal', args: 'clear' }).catch(() => {})
  await update($, goal, () => '')
  return true
}

async function cronJobs($: EngineInterface) {
  const r = await $.tool.call({ tool: 'CronList' }).catch(() => undefined)
  if (!r || r.deny !== undefined || r.isError) return []
  return (r.result as { jobs?: { id: string; humanSchedule: string; recurring?: boolean }[] }).jobs ?? []
}

async function syncLoops($: EngineInterface) {
  const recurring = (await cronJobs($)).filter(job => job.recurring !== false)
  const at = new Date(wakeAt)
  const next = wakeAt > Date.now() ? [`next run at ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`] : []
  await update($, loop, () => [...recurring.map(job => job.humanSchedule), ...next].join(', '))
}

async function stopLoops($: EngineInterface) {
  let stopped = 0
  for (const job of (await cronJobs($)).filter(job => job.recurring !== false)) {
    const r = await $.tool.call({ tool: 'CronDelete', id: job.id }).catch(() => undefined)
    if (r && r.deny === undefined && !r.isError) stopped++
  }
  if (wakeAt > Date.now()) {
    const r = await $.tool.call({ tool: 'ScheduleWakeup', stop: true }).catch(() => undefined)
    if (r && r.deny === undefined && !r.isError) stopped++
    wakeAt = 0
  }
  await update($, loop, () => '')
  return stopped
}

async function control($: EngineInterface, text: string) {
  if (GOAL_CLEAR.test(text)) {
    void speak($, (await clearGoal($)) ? 'Goal cleared.' : 'No goal is set.')
    return true
  }
  if (LOOP_STOP.test(text)) {
    void speak($, (await stopLoops($)) > 0 ? 'Loop stopped.' : 'No loop is running.')
    return true
  }
  if (CANCEL.test(text)) {
    if (pending.length === 0) return false
    pending.pop()
    showQueue($)
    void speak($, 'Removed.')
    return true
  }
  if (CLEAR.test(text)) {
    pending = []
    showQueue($)
    void speak($, 'Cleared.')
    return true
  }
  if (SEND_NOW.test(text)) {
    if (pending.length === 0) return false
    await stopWork($)
    submit($, takePending($))
    return true
  }
  if (STOP.test(text)) {
    await stopWork($)
    const ended = [(await clearGoal($)) && 'cleared the goal', (await stopLoops($)) > 0 && 'stopped the loop'].filter(Boolean)
    void speak($, ended.length ? `Stopped, and ${ended.join(' and ')}.` : 'Stopped.')
    return true
  }
  return false
}

async function aside($: EngineInterface, question: string) {
  showSent($, `(on the side) ${question}`)
  hear($, `Asking on the side: ${question}`)
  const r = await $.model.fork({ prompt: asidePrompt(question) }).catch(() => undefined)
  hear($, '')
  const answer = r?.isAnswered ? r.text.trim() : ''
  if (!answer || /^QUEUE\W*$/.test(answer)) {
    if (!isWorking) return submit($, question)
    pending.push(question)
    showQueue($)
    return
  }
  void speak($, answer)
}

async function onHeard($: EngineInterface, text: string) {
  hear($, '')
  if (!/[a-z0-9]/i.test(text)) return
  if (pendingCommand) return confirmCommand($, text)
  if (DISCARD.test(text)) return
  if (await control($, text)) return
  if (await slashCommand($, text)) return
  if (await agentControl($, text)) return
  if (isWorking && ASIDE.test(text)) return void aside($, text)
  if (isWorking) {
    pending.push(text)
    showQueue($)
    return
  }
  submit($, text)
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
          await onHeard($, msg.final.trim())
        }
        if (msg.error) why = `Voice mode off: ${msg.error}`
        if (msg.moved) return turnOff($, 'Voice mode off here: another Claude Code session turned it on.', false)
      }
    }
  } catch {}
  if (id === sessionId && isActive) turnOff($, why)
}

async function start($: EngineInterface, id: number) {
  if (id !== sessionId) return
  refresh($)
  void update($, phase, () => 'loading')
  const env: Record<string, string> = {
    ...(micLevel ? { NO_HANDS_LEVEL: micLevel } : {}),
    ...(voiceName ? { NO_HANDS_VOICE: voiceName } : {}),
    ...(whisperModel ? { NO_HANDS_WHISPER: whisperModel } : {}),
  }
  const r = await $.process.run([`${$.plugin.root}/voiced`, socket($)], { env, timeoutMs: 600_000 }).catch(() => undefined)
  if (!isActive || id !== sessionId) return
  if (r?.exitCode !== 0) return turnOff($, `Voice mode off: the voice server did not start. ${r?.stdout.trim() ?? ''}`)
  refresh($)
  await converse($)
}

async function respond($: EngineInterface, answer: string) {
  if (pending.length > 0) {
    submit($, takePending($))
    return
  }
  const id = speechId
  let spoken = answer.trim()
  if (!isSpeakable(spoken)) {
    isPreparing = true
    refresh($)
    const forked = await $.model.fork({ prompt: `${SPOKEN_PROMPT}\n\nYour written answer, which I can also see on screen:\n${answer}` }).catch(() => undefined)
    isPreparing = false
    refresh($)
    spoken = forked?.isAnswered ? forked.text.trim() : plain(answer) || 'Done.'
  }
  if (isActive && !isWorking) await speak($, spoken.slice(0, 4000), id)
}

function setAgent($: EngineInterface, id: string, fn: (row: AgentRow) => AgentRow) {
  return update($, agents, list => list.map(row => (row.id === id ? fn(row) : row)))
}

function isLive(row: AgentRow) {
  return row.state === 'running' || row.state === 'idle'
}

function brief(e: Record<string, unknown>) {
  const detail = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt']
    .map(key => e[key])
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  const tool = String(e.tool).replace(/^mcp__[^_]+__/, '')
  return detail ? `${tool}: ${detail.replace(/\s+/g, ' ').slice(0, 80)}` : tool
}

function words2(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !['the', 'a', 'an', 'agent', 'number'].includes(w))
}

function findAgent(list: AgentRow[], spoken: string, isStrict = false) {
  const target = spoken.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const num = target.match(/^(?:the )?(?:agent|number)(?: number)? (\w+)$/)?.[1]
  if (num !== undefined) {
    const n = /^\d+$/.test(num) ? Number(num) : (SOUNDS_LIKE[num] ?? NUMBERS.indexOf(num))
    return list.find(row => row.num === n)
  }
  if (isStrict) return list.find(row => words2(row.label).join(' ') === words2(target).join(' '))
  const want = words2(target)
  if (want.length === 0) return undefined
  const scored = list
    .map(row => {
      const have = new Set(words2(`${row.label} ${row.type}`))
      return { row, score: want.filter(w => have.has(w)).length / want.length }
    })
    .filter(x => x.score >= 0.5)
    .sort((a, b) => b.score - a.score || Number(isLive(b.row)) - Number(isLive(a.row)) || b.row.num - a.row.num)
  return scored[0]?.row
}

function nameOf(row: AgentRow) {
  return `agent ${row.num}, ${row.label}`
}

function agentSummary(list: AgentRow[]) {
  if (list.length === 0) return 'No agents have run yet.'
  const live = list.filter(isLive)
  const done = list.filter(row => row.state === 'done').length
  const failed = list.filter(row => row.state === 'failed' || row.state === 'stopped').length
  const parts = [`${live.length} running`]
  if (done) parts.push(`${done} done`)
  if (failed) parts.push(`${failed} failed or stopped`)
  const doing = live.slice(0, 3).map(row => `${nameOf(row)}: ${row.state === 'idle' ? 'waiting' : row.step.split(':')[0]}`)
  return [parts.join(', ') + '.', ...doing.map(d => `${d}.`)].join(' ')
}

function treeOrder(list: AgentRow[]) {
  const ids = new Set(list.map(row => row.id))
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number) => {
    for (const row of list) {
      const parent = row.parentId !== undefined && ids.has(row.parentId) ? row.parentId : undefined
      if (parent !== parentId) continue
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

function wordsOf(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean)
}

function sayName(name: string) {
  return name.replace(/[^a-z0-9]+/gi, ' ').trim()
}

async function slashCommand($: EngineInterface, text: string) {
  const match = text.match(SLASH)
  if (!match) return false
  const spoken = wordsOf(match[1]!)
  const commands = await $.command.list().catch(() => [])
  let best: { name: string; parts: string[] } | undefined
  for (const { name } of commands) {
    const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const isPrefix = parts.length <= spoken.length && parts.every((w, i) => w === spoken[i])
    if (isPrefix && parts.length > (best?.parts.length ?? 0)) best = { name, parts }
  }
  if (!best) return false
  const again = new RegExp(`\\bslash ${best.parts.join(' ')}\\b`, 'g')
  const after = spoken.slice(best.parts.length).join(' ').replace(again, '').replace(/\s+/g, ' ').trim()
  const before = wordsOf(text.slice(0, match.index).replace(FILLER, '')).join(' ')
  askCommand($, { name: best.name, args: after || before })
  return true
}

function askCommand($: EngineInterface, cmd: { name: string; args: string }) {
  const asked = { ...cmd }
  pendingCommand = asked
  $.clock.after(CONFIRM_MS, () => {
    if (pendingCommand !== asked) return
    pendingCommand = undefined
    showSent($, '')
    void speak($, `Dropped the ${sayName(cmd.name)} command. No answer came.`)
  })
  showSent($, `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''} (waiting for your okay)`)
  void speak($, cmd.args ? `Run ${sayName(cmd.name)} with: ${cmd.args}. Okay?` : `What should the ${sayName(cmd.name)} be? Or say "run it" to run it as is.`)
}

function confirmCommand($: EngineInterface, text: string) {
  const cmd = pendingCommand!
  if (NO.test(text)) {
    pendingCommand = undefined
    showSent($, '')
    void speak($, 'Dropped.')
    return
  }
  if (!YES.test(text)) return askCommand($, { ...cmd, args: text.replace(/[.!?\s]+$/, '') })
  pendingCommand = undefined
  showSent($, `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`)
  void speak($, `Running ${sayName(cmd.name)}.`)
  void $.command.run({ command: cmd.name, args: cmd.args }).catch(() => speak($, `${sayName(cmd.name)} did not run.`))
}

async function agentControl($: EngineInterface, text: string) {
  const list = await read($, agents)
  if (AGENT_STATUS.test(text) && list.length > 0) {
    void speak($, agentSummary(list))
    return true
  }
  if (list.length === 0) return false
  const tell = text.match(AGENT_TELL)
  const toldAgent = tell ? findAgent(list, tell[1]!) : undefined
  if (tell && toldAgent) {
    showSent($, `(to ${nameOf(toldAgent)}) ${tell[2]}`)
    const r = await $.session
      .send({ to: { agentId: toldAgent.id }, text: `The user said this out loud for you: "${tell[2]}"` })
      .catch((err: Error) => ({ isDelivered: false as const, reason: err.message }))
    void speak($, r.isDelivered ? `Sent to ${nameOf(toldAgent)}.` : `Could not reach ${nameOf(toldAgent)}. ${r.reason}`)
    return true
  }
  const stop = text.match(AGENT_STOP)
  const stopAgent = stop ? findAgent(list.filter(isLive), stop[1]!, true) : undefined
  if (stopAgent) {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: stopAgent.stopAs ?? stopAgent.id }).catch(() => undefined)
    const isStopped = r !== undefined && r.deny === undefined && !r.isError
    if (isStopped) await setAgent($, stopAgent.id, row => ({ ...row, state: 'stopped', endedAt: Date.now() }))
    void speak($, isStopped ? `Stopped ${nameOf(stopAgent)}.` : `Could not stop ${nameOf(stopAgent)}.`)
    return true
  }
  return false
}

function announceFinished($: EngineInterface, row: AgentRow) {
  if (!isActive || !isWorking) return
  finished.push(row)
  if (isFinishDue) return
  isFinishDue = true
  $.clock.after(FINISH_GAP_MS, () => {
    isFinishDue = false
    const batch = finished
    finished = []
    if (!isActive || batch.length === 0) return
    const failed = batch.filter(row => row.state === 'failed')
    const one = batch[0]!
    const line =
      batch.length === 1
        ? `${nameOf(one)} ${one.state === 'done' ? 'finished' : one.state}.`
        : `${batch.length} agents ended${failed.length ? `, ${failed.length} of them failed` : ''}: agents ${batch.map(row => row.num).join(', ')}.`
    void speak($, line)
  })
}

async function syncAgents($: EngineInterface) {
  const live = await $.agent.list().catch(() => undefined)
  if (!live) return
  const byId = new Map(live.map(info => [info.id, info]))
  const toState: Partial<Record<string, AgentState>> = { completed: 'done', failed: 'failed', killed: 'stopped', idle: 'idle', waiting: 'idle', running: 'running', pending: 'running' }
  await update($, agents, list => {
    const known = new Set(list.map(row => row.id))
    const next = list.map(row => {
      const info = byId.get(row.id)
      const state = info ? (toState[info.status] ?? row.state) : row.state
      if (state === row.state) return row
      return isLive({ ...row, state }) ? { ...row, state, endedAt: undefined } : { ...row, state, endedAt: Date.now() }
    })
    let num = Math.max(0, ...list.map(row => row.num))
    for (const info of live) {
      if (known.has(info.id)) continue
      next.push({
        id: info.id,
        num: ++num,
        label: info.name ?? info.description,
        type: info.type,
        parentId: info.parentId,
        stopAs: info.teammateId ?? info.name,
        isTeammate: info.teammateId !== undefined,
        state: toState[info.status] ?? 'running',
        step: '',
        startedAt: Date.now(),
      })
    }
    return next
  })
}

function elapsed(row: AgentRow, now: number) {
  const s = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'talk',
      description: 'Hands-free voice mode: talk to Claude and hear its replies. Run again to stop.',
    })
    if (!isActive && (await read($, phase)) !== null) {
      void call($, '/quit')
      $.ui.toast('Voice mode turned off by the reload. Run /talk to turn it back on.')
    }
    if (!isActive) {
      void update($, phase, () => null)
      hear($, '')
      showReply($, '')
      void update($, queue, () => [])
    }
    void $.ui.close({ id: 'no-hands-agents' }).catch(() => {})
    await syncAgents($)
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
        const r = await call($, '/voice', value)
        if (r?.startsWith('failed')) return { text: `Voice not changed: ${r.replace(/^failed:\s*/, '')}` }
        void speak($, 'This is how I sound now.')
      }
      return { text: `Voice set to ${value}.` }
    }
    if (word === 'model') {
      if (!value || !(/^(turbo|small|base|tiny)$/.test(value) || value.includes('/'))) return { text: `Usage: /talk model small. Speech recognition models: ${MODELS}.` }
      whisperModel = value
      if (isActive) {
        $.clock.after(0, async () => {
          const r = await call($, '/model', value)
          void speak($, r === 'ok' ? `Switched to the ${value} model.` : `The ${value} model did not load.`)
        })
        return { text: `Switching speech recognition to ${value}. It downloads once the first time.` }
      }
      return { text: `Speech recognition set to ${value} for this session. It downloads once the first time.` }
    }
    if (isActive) {
      turnOff($)
      return { text: 'Voice mode off.' }
    }
    isActive = true
    const id = ++sessionId
    $.clock.after(0, () => void start($, id))
    return { text: 'Voice mode on. Talk any time; pause to send. /talk level 0.05 ignores more background sound. Run /talk again to end it.' }
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const result = await next(e)
    const condition = e.args.trim()
    if (!condition) return result
    if (GOAL_OFF.has(condition.toLowerCase())) await update($, goal, () => '')
    else if (result.text === undefined || result.text.startsWith('Goal set')) await update($, goal, () => condition)
    return result
  })

  on('session.append', { door: 'attachment' }, async ($, e, next) => {
    if (e.agentId === undefined && e.message.name === 'goal_status') isGoalChecked = true
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!isActive) return result
    return { ...result, sections: [...result.sections, { id: 'no-hands-voice', text: VOICE_SECTION, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    pendingCommand = undefined
    isGoalChecked = false
    if (await read($, loop)) void syncLoops($)
    isWorking = true
    if (isActive) {
      showReply($, '')
      refresh($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) isGoalChecked = false
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
    if (e.agentId !== undefined) {
      const step = brief(e as unknown as Record<string, unknown>)
      void setAgent($, e.agentId, row => (isLive(row) ? { ...row, step } : { ...row, step, state: 'running', endedAt: undefined }))
    }
    const result = await next(e)
    if (e.agentId === undefined && result.deny === undefined && (e.tool === 'CronCreate' || e.tool === 'CronDelete' || e.tool === 'ScheduleWakeup')) {
      if (e.tool === 'ScheduleWakeup' && !result.isError) {
        const r = result.result as { scheduledFor?: number; stopped?: boolean }
        wakeAt = r.stopped ? 0 : (r.scheduledFor ?? 0)
      }
      void syncLoops($)
    }
    if (!isActive || e.agentId !== undefined || pending.length === 0 || result.deny !== undefined) return result
    const text = takePending($)
    showSent($, text)
    const note = `The user just said this out loud while you were working: "${text}". Treat it as a message from them now.`
    return { ...result, context: [...(result.context ?? []), note] }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      const before = (await read($, agents)).find(r => r.id === id)
      const ended: AgentState = e.isAborted ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
      const state: AgentState = before?.isTeammate && ended === 'done' ? 'idle' : ended
      await setAgent($, id, row => (isLive({ ...row, state }) ? { ...row, state } : { ...row, state, endedAt: Date.now() }))
      await syncAgents($)
      const row = (await read($, agents)).find(r => r.id === id)
      if (row && !isLive(row) && before?.state !== 'stopped') announceFinished($, row)
      return result
    }
    isWorking = false
    if (isGoalChecked && !e.isAborted) await update($, goal, () => '')
    isGoalChecked = false
    if (!isActive) return result
    refresh($)
    if (e.isAborted) {
      silence($)
      const dropped = pending.length
      takePending($)
      if (dropped > 0) void speak($, `Dropped ${dropped === 1 ? 'the queued message' : `${dropped} queued messages`}.`)
      return result
    }
    const answer = e.reason === 'answer' ? e.answer : ''
    $.clock.after(0, () => void respond($, answer))
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId) return result
    const id = result.agentId
    await update($, agents, list => [
      ...list.filter(row => row.id !== id),
      {
        id,
        num: Math.max(0, ...list.map(row => row.num)) + 1,
        label: e.name ?? e.description,
        type: e.subagentType,
        parentId: e.parentAgentId,
        stopAs: result.teammateId ?? e.name,
        isTeammate: e.isTeammate === true || result.teammateId !== undefined,
        state: 'running' as const,
        step: 'starting',
        startedAt: Date.now(),
      },
    ].slice(-200))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, phase)
    if (!isActive || !current || e.props.hasSurvey) return next(e)
    const said = await read($, words)
    const spoken = await read($, reply)
    const waiting = await read($, queue)
    const lastSent = await read($, sent)
    const goalText = await read($, goal)
    const loopText = await read($, loop)
    const rows = treeOrder(await read($, agents))
      .filter(({ row }) => isLive(row) || Date.now() - (row.endedAt ?? 0) < 60_000)
      .map(({ row, depth }) => ({ ...row, depth }))
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="voice" module="./indicator.tsx" width="100%" props={{ phase: current, words: said, reply: spoken, queue: [...waiting], sent: lastSent, agents: rows, goal: goalText, loop: loopText }} />
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lastSent ? <Text dimColor>Sent: {lastSent}</Text> : null}
        {goalText ? <Text color="yellow">Goal: {goalText} · say "clear goal"</Text> : null}
        {loopText ? <Text color="yellow">Loop: {loopText} · say "stop loop"</Text> : null}
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
    const isTyped = isActive && e.origin.kind === 'composer'
    if (isTyped) {
      showSent($, e.text)
      silence($)
      isWorking = true
      refresh($)
    }
    const result = await next(e)
    if (isTyped && result.drop !== undefined) notWorking($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (isActive) turnOff($)
    return next(e)
  })
}
