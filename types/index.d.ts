export type VoicePhase = 'loading' | 'listening' | 'working' | 'preparing' | 'speaking'

export type SessionRow = { label: string; state: 'working' | 'waiting' | 'asking' | 'idle'; rank: number; floor: boolean }

export type AgentState = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

export type AgentRow = {
  id: string
  num: number
  label: string
  type: string
  parentId?: string
  stopAs?: string
  isTeammate?: boolean
  state: AgentState
  step: string
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'no-hands': {
      phase: VoicePhase | null
      words: string
      reply: string
      queue: string[]
      sent: string
      agents: AgentRow[]
      goal: string
      loop: string
      mute: '' | 'muted' | 'deafened'
      sessions: SessionRow[]
    }
  }
}
