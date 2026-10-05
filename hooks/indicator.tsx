import type { ClientModule } from 'claude-code'

import type { VoicePhase } from '../types'

const BARS = '▁▂▃▄▅▆▇█'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const LOOK: Record<VoicePhase, { label: string; hint: string; color: string; isWave: boolean }> = {
  loading: { label: 'Loading voice models', hint: 'about 10 seconds', color: 'magenta', isWave: false },
  listening: { label: 'Listening', hint: 'pause to send', color: 'green', isWave: true },
  speaking: { label: 'Speaking', hint: 'talk to interrupt', color: 'cyan', isWave: true },
  working: { label: 'Working', hint: 'talk any time', color: 'magenta', isWave: false },
  preparing: { label: 'Preparing reply', hint: '', color: 'magenta', isWave: false },
}

function wave(frame: number) {
  let out = ''
  for (let i = 0; i < 9; i++) {
    const level = (Math.sin(frame * 0.5 + i * 0.8) + Math.sin(frame * 0.23 + i * 1.7) + 2) / 4
    out += BARS[Math.min(BARS.length - 1, Math.floor(level * BARS.length))]
  }
  return out
}

const Indicator: ClientModule<{ phase: VoicePhase; words: string; reply: string; queue: string[] }, number> = (props, surface) => {
  if (surface.state === undefined) {
    let frame = 0
    surface.setState(0)
    surface.every(90, () => surface.setState(++frame))
  }
  const { Box, Text } = surface.elements
  const frame = surface.state ?? 0
  const look = LOOK[props.phase]
  const glyph = look.isWave ? wave(frame) : SPINNER[frame % SPINNER.length]

  return (
    <Box flexDirection="column">
      {props.reply ? (
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text>{props.reply}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color={look.color}>{glyph} </Text>
        <Text color={look.color} bold>{look.label}</Text>
        {look.hint ? <Text dimColor>  {look.hint}</Text> : null}
      </Box>
      {props.words ? <Text italic>{props.words.length > 400 ? `…${props.words.slice(-400)}` : props.words}</Text> : null}
      {props.queue.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>Waiting for Claude's next step:</Text>
          {props.queue.map((item, i) => (
            <Text key={`q${i}`}>  {i + 1}. {item}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

export default Indicator
