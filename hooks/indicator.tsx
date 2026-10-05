import type { ClientModule } from 'claude-code'

import type { VoicePhase } from '../types'

const BARS = '▁▂▃▄▅▆▇█'
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const LOOK: Record<VoicePhase, { label: string; hint: string; color: string; isWave: boolean }> = {
  listening: { label: 'Listening', hint: 'say "stop listening" to end', color: 'green', isWave: true },
  speaking: { label: 'Speaking', hint: 'type to interrupt', color: 'cyan', isWave: true },
  working: { label: 'Working', hint: '', color: 'magenta', isWave: false },
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

const Indicator: ClientModule<{ phase: VoicePhase }, number> = (props, surface) => {
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
    <Box>
      <Text color={look.color}>{glyph} </Text>
      <Text color={look.color} bold>{look.label}</Text>
      {look.hint ? <Text dimColor>  {look.hint}</Text> : null}
    </Box>
  )
}

export default Indicator
