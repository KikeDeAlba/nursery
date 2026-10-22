export type Phase = 'explore' | 'proposed' | 'accepted' | 'done'
export interface FlowState {
  version: 1; sessionId: string; cwd: string; request: string; planPath: string; phase: Phase
  startedAt: string; updatedAt: string
  activeAgents: number; researched: boolean
  reads: { used: number; limit: number }
  proposals: number; corrections: number; changed: boolean
  validation: { qa: boolean; review: boolean }
  retries: { validation: number; gaveUp: boolean }
}
export interface FlowEnv { off: boolean; plansDir: string; project: string }
interface HookBase { session_id: string; cwd: string; transcript_path?: string; timestamp?: string }
export interface BeforeAgentEvent extends HookBase { hook_event_name: 'BeforeAgent'; prompt: string }
export interface BeforeToolEvent extends HookBase { hook_event_name: 'BeforeTool'; tool_name: string; tool_input: Record<string, unknown> }
export interface ToolResponse { llmContent?: unknown; returnDisplay?: unknown; error?: unknown }
export interface AfterToolEvent extends HookBase { hook_event_name: 'AfterTool'; tool_name: string; tool_input: Record<string, unknown>; tool_response: ToolResponse }
export interface AfterAgentEvent extends HookBase { hook_event_name: 'AfterAgent'; prompt: string; prompt_response: string; stop_hook_active?: boolean }
export type HookEvent = BeforeAgentEvent | BeforeToolEvent | AfterToolEvent | AfterAgentEvent
export type HookEventName = HookEvent['hook_event_name']
export const HOOK_EVENTS: readonly HookEventName[] = ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent']
export type HookResult =
  | Record<string, never>
  | { decision: 'deny'; reason: string }
  | { hookSpecificOutput: { hookEventName: 'BeforeAgent' | 'AfterTool'; additionalContext: string } }
export type AgentOutcome = 'goal' | 'partial' | 'failed'
export type PlanLogEntry =
  | { kind: 'create'; file: string; at: string; request: string; cwd: string; sessionId: string }
  | { kind: 'phase'; file: string; phase: Phase | 'replaced' }
  | { kind: 'proposal'; file: string; at: string; version: number; text: string }
  | { kind: 'accepted'; file: string; at: string; via: 'dialog' | 'text' }
  | { kind: 'correction'; file: string; at: string; via: 'dialog' | 'text'; text: string }
  | { kind: 'dismissed'; file: string; at: string }
  | { kind: 'agent'; file: string; at: string; agent: string; task: string; outcome: AgentOutcome; detail: string }
  | { kind: 'validation'; file: string; at: string; qa: boolean; review: boolean; result: 'done' | 'retry' | 'gave-up'; attempt: number }
  | { kind: 'replaced'; file: string; at: string }
export interface StepOutput { state: FlowState | null; result: HookResult; log: PlanLogEntry[] }
