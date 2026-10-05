export type VoicePhase = 'loading' | 'listening' | 'working' | 'preparing' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'no-hands': { phase: VoicePhase | null; words: string }
  }
}
