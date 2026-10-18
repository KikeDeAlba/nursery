export type NurseryActivityKind = 'tool' | 'text'

export type NurseryActivityState = 'running' | 'done' | 'failed'

export type NurseryActivity = {
  kind: NurseryActivityKind
  label: string
  state: NurseryActivityState
  id?: string
}

export type NurseryAgentStatus = 'running' | 'completed' | 'failed' | 'killed'

export type NurseryAgent = {
  id: string
  type: string
  description: string
  parentId?: string
  status: NurseryAgentStatus
  startedAt: number
  endedAt?: number
  toolCount: number
  activity: NurseryActivity[]
}

declare module 'claude-code' {
  interface PluginState {
    nursery: { agents: NurseryAgent[]; now: number; isPaneOffered: boolean }
  }
}
