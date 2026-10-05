import type { ClientModule } from 'claude-code'

import type { AgentRow, AgentState, VoicePhase } from '../types'

const BARS = '▁▂▃▄▅▆▇█'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const LOOK: Record<VoicePhase, { label: string; hint: string; color: string; isWave: boolean }> = {
  loading: { label: 'Loading voice models', hint: 'about 10 seconds', color: 'magenta', isWave: false },
  listening: { label: 'Listening', hint: 'pause to send · "never mind" drops it', color: 'green', isWave: true },
  speaking: { label: 'Speaking', hint: 'talk to interrupt', color: 'cyan', isWave: true },
  working: { label: 'Working', hint: 'talk any time · "stop" ends the work', color: 'magenta', isWave: false },
  preparing: { label: 'Preparing reply', hint: '', color: 'magenta', isWave: false },
}

const AGENT_ROWS = 6
const AGENT_COLOR: Record<AgentState, string> = { running: 'magenta', idle: 'yellow', done: 'green', failed: 'red', stopped: 'red' }

function elapsed(row: AgentRow, now: number) {
  const s = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function wave(frame: number) {
  let out = ''
  for (let i = 0; i < 9; i++) {
    const level = (Math.sin(frame * 0.5 + i * 0.8) + Math.sin(frame * 0.23 + i * 1.7) + 2) / 4
    out += BARS[Math.min(BARS.length - 1, Math.floor(level * BARS.length))]
  }
  return out
}

type Props = { phase: VoicePhase; words: string; reply: string; queue: string[]; sent: string; agents: (AgentRow & { depth: number })[] }

const Indicator: ClientModule<Props, number> = (props, surface) => {
  if (surface.state === undefined) {
    let frame = 0
    surface.setState(0)
    surface.every(90, () => surface.setState(++frame))
  }
  const { Box, Text } = surface.elements
  const frame = surface.state ?? 0
  const look = LOOK[props.phase] ?? LOOK.listening
  const queue = props.queue ?? []
  const words = props.words ?? ''
  const reply = props.reply ?? ''
  const sent = props.sent ?? ''
  const agents = props.agents ?? []
  const live = agents.filter(row => row.state === 'running' || row.state === 'idle')
  const shown = [...live, ...agents.filter(row => !live.includes(row))].slice(0, AGENT_ROWS)
  const now = Date.now()
  const glyph = look.isWave ? wave(frame) : SPINNER[frame % SPINNER.length]
  const hint = queue.length > 0 ? '"send now" · "cancel" · "clear queue" · "stop"' : agents.length > 0 && look.label === 'Working' ? '"tell agent 2 to …" · "stop agent 2" · "agent status"' : look.hint

  const tail = (text: string) => (text.length > 400 ? `…${text.slice(-400)}` : text)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={look.color} paddingX={1} width="100%">
      <Box justifyContent="space-between">
        <Box>
          <Text color={look.color}>{glyph} </Text>
          <Text color={look.color} bold>{look.label}</Text>
        </Box>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
      {sent ? (
        <Box marginTop={1}>
          <Text color="green" bold>Sent    </Text>
          <Text dimColor>{tail(sent)}</Text>
        </Box>
      ) : null}
      {reply ? (
        <Box marginTop={sent ? 0 : 1}>
          <Text color="cyan" bold>Claude  </Text>
          <Text>{tail(reply)}</Text>
        </Box>
      ) : null}
      {words ? (
        <Box marginTop={1}>
          <Text color="green" bold>Hearing </Text>
          <Text italic>{tail(words)}</Text>
        </Box>
      ) : null}
      {agents.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            Agents · {live.length} running{agents.length > shown.length ? ` · ${agents.length - shown.length} more` : ''}
          </Text>
          {shown.map(row => (
            <Box key={row.id}>
              <Text>{'  '.repeat(Math.min(row.depth, 3))}</Text>
              <Text color={AGENT_COLOR[row.state]} bold>{row.num} </Text>
              <Text bold={row.state === 'running'} dimColor={row.state !== 'running' && row.state !== 'idle'}>{row.label} </Text>
              <Text dimColor wrap="truncate-end">
                {elapsed(row, now)} · {row.state === 'running' ? row.step || 'starting' : row.state}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {queue.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Waiting for Claude's next step</Text>
          {queue.map((item, i) => (
            <Text key={`q${i}`}>
              {i + 1}. {item}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

export default Indicator
