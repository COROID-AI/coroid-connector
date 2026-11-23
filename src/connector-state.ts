import type {
  ConnectorTurnContext,
  LocalAgentId,
  LocalAgentReport,
} from './protocol/local-agents.js';
import type { ConnectionState } from './connect.js';
import type { TurnUsage } from './turn.js';

export type LogLevel = 'basic' | 'verbose';
export type LogSeverity =
  | 'info'
  | 'work'
  | 'tool'
  | 'perm'
  | 'warn'
  | 'error'
  | 'debug';

export type InteractiveCommand =
  | 'check'
  | 'verbose'
  | 'basic'
  | 'toggle_verbose'
  | 'pause'
  | 'resume'
  | 'toggle_pause'
  | 'stats'
  | 'agents'
  | 'main'
  | 'clear'
  | 'help'
  | 'quit';

export interface LogEntry {
  timestamp: Date;
  level: LogSeverity;
  message: string;
  verboseOnly: boolean;
}

export interface AgentSnapshot {
  id: LocalAgentId;
  name: string;
  command: string[] | null;
  report: LocalAgentReport | null;
  checking: boolean;
  checkedAt?: number | null;
}

export interface ActiveTurnState {
  id: string;
  slot: number;
  agent: LocalAgentId;
  agentName: string;
  model: string | null;
  role: string | null;
  taskTitle: string | null;
  projectName: string | null;
  requestedBy: string | null;
  startedAt: number;
  timeLimitSeconds: number;
  toolCalls: number;
  permissionsBlocked: number;
  inputTokens: number;
  outputTokens: number;
  activity: string;
}

export interface CompletedTurnRecord {
  id: string;
  agent: LocalAgentId;
  agentName: string;
  model: string | null;
  role: string | null;
  taskTitle: string | null;
  requestedBy: string | null;
  outcome: 'ended' | 'failed';
  detail?: string;
  durationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  finishedAt: number;
}

export interface AgentCounters {
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface SessionStats {
  turnsCompleted: number;
  turnsFailed: number;
  toolCalls: number;
  permissionsBlocked: number;
  inputTokens: number;
  outputTokens: number;
  polls: number;
  reconnects: number;
}

const LOG_BUFFER_MAX = 500;
const RECENT_TURNS_MAX = 50;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock timestamp: `YYYY-MM-DD HH:MM:SS`. */
export function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Short time only: `HH:MM:SS`. */
export function formatTimeOnly(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Human-readable duration: `9s`, `2m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${pad2(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${pad2(remMinutes)}m`;
}

/** Compact token formatting: `420`, `12.5k`, `1.52M`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 1_000_000)
    return `${(Math.round(tokens / 100) / 10).toFixed(1)}k`;
  return `${(Math.round(tokens / 10_000) / 100).toFixed(2)}M`;
}

/** Parses interactive commands and single-key shortcuts (case-insensitive, optional leading `/`). */
export function parseInteractiveCommand(
  raw: string
): InteractiveCommand | null {
  const normalized = raw.trim().replace(/^\/+/, '').toLowerCase();
  if (!normalized) return null;
  switch (normalized) {
    case 'c':
    case 'r':
    case 'check':
    case 'recheck':
    case 'probe':
    case 'refresh':
      return 'check';
    case 'v':
      return 'toggle_verbose';
    case 'verbose':
    case 'debug':
      return 'verbose';
    case 'basic':
    case 'quiet':
    case 'normal':
      return 'basic';
    case 'p':
      return 'toggle_pause';
    case 'pause':
      return 'pause';
    case 'resume':
    case 'unpause':
      return 'resume';
    case 's':
    case 'stats':
    case 'tokens':
      return 'stats';
    case 'a':
    case 'agents':
    case 'tools':
    case 'status':
      return 'agents';
    case 'm':
    case 'main':
    case 'home':
    case 'logs':
      return 'main';
    case 'clear':
    case 'cls':
      return 'clear';
    case '?':
    case 'h':
    case 'help':
      return 'help';
    case 'q':
    case 'quit':
    case 'exit':
    case 'stop':
      return 'quit';
    default:
      return null;
  }
}

/** Redacts bearer tokens or secret-looking query params before writing any log line. */
export function redactLogText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bcmp_(?:at|rt|code)_[A-Za-z0-9._-]+/g, '[redacted-token]');
}

/**
 * Central state store for a running connector session: tracks connection health,
 * detected coding tools, parallel worker slots, per-turn & cumulative token
 * stats, and the bounded activity log.
 */
export class ConnectorState {
  readonly version: string;
  readonly machineName: string;
  readonly api: string;
  readonly platform: string;
  readonly startedAt: number;
  readonly maxConcurrency: number;
  credentialStore: string;
  connectionState: ConnectionState = 'connecting';
  connectionDetail: string | null = null;
  lastPollAt: number | null = null;
  lastPollLatencyMs: number | null = null;
  logLevel: LogLevel;
  agents: AgentSnapshot[] = [];
  readonly activeTurns = new Map<string, ActiveTurnState>();
  readonly recentTurns: CompletedTurnRecord[] = [];
  readonly logs: LogEntry[] = [];
  readonly stats: SessionStats = {
    turnsCompleted: 0,
    turnsFailed: 0,
    toolCalls: 0,
    permissionsBlocked: 0,
    inputTokens: 0,
    outputTokens: 0,
    polls: 0,
    reconnects: 0,
  };
  readonly agentStats: Partial<Record<LocalAgentId, AgentCounters>> = {};
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(options: {
    version: string;
    machineName: string;
    api: string;
    platform: string;
    credentialStore: string;
    maxConcurrency: number;
    logLevel: LogLevel;
    now?: () => number;
  }) {
    this.version = options.version;
    this.machineName = options.machineName;
    this.api = options.api;
    this.platform = options.platform;
    this.credentialStore = options.credentialStore;
    this.maxConcurrency = options.maxConcurrency;
    this.logLevel = options.logLevel;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  setConnectionState(next: ConnectionState, detail?: string): void {
    if (next === 'reconnecting' && this.connectionState !== 'reconnecting') {
      this.stats.reconnects += 1;
    }
    this.connectionState = next;
    this.connectionDetail = detail ?? null;
    this.emit();
  }

  recordPoll(latencyMs: number): void {
    this.lastPollAt = this.now();
    this.lastPollLatencyMs = latencyMs;
    this.stats.polls += 1;
    this.emit();
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
    this.emit();
  }

  setAgents(agents: AgentSnapshot[]): void {
    this.agents = agents;
    this.emit();
  }

  markAgentsChecking(checking: boolean): void {
    this.agents = this.agents.map(agent => ({ ...agent, checking }));
    this.emit();
  }

  log(level: LogSeverity, message: string, verboseOnly = false): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date(this.now()),
      level,
      message: redactLogText(message),
      verboseOnly,
    };
    this.logs.push(entry);
    if (this.logs.length > LOG_BUFFER_MAX) this.logs.shift();
    this.emit();
    return entry;
  }

  clearLogs(): void {
    this.logs.length = 0;
    this.emit();
  }

  visibleLogs(): LogEntry[] {
    return this.logLevel === 'verbose'
      ? this.logs
      : this.logs.filter(entry => !entry.verboseOnly);
  }

  private nextFreeSlot(): number {
    const used = new Set([...this.activeTurns.values()].map(turn => turn.slot));
    for (let slot = 1; slot <= this.maxConcurrency; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return this.activeTurns.size + 1;
  }

  private countersFor(agent: LocalAgentId): AgentCounters {
    return (this.agentStats[agent] ??= {
      completed: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    });
  }

  startTurn(input: {
    id: string;
    agent: LocalAgentId;
    agentName: string;
    model: string | null;
    timeLimitSeconds: number;
    context?: ConnectorTurnContext | null;
  }): ActiveTurnState {
    const turn: ActiveTurnState = {
      id: input.id,
      slot: this.nextFreeSlot(),
      agent: input.agent,
      agentName: input.agentName,
      model: input.model,
      role: input.context?.role ?? null,
      taskTitle: input.context?.taskTitle ?? null,
      projectName: input.context?.projectName ?? null,
      requestedBy: input.context?.requestedBy ?? null,
      startedAt: this.now(),
      timeLimitSeconds: input.timeLimitSeconds,
      toolCalls: 0,
      permissionsBlocked: 0,
      inputTokens: 0,
      outputTokens: 0,
      activity: 'Starting…',
    };
    this.activeTurns.set(input.id, turn);
    this.emit();
    return turn;
  }

  setTurnActivity(turnId: string, activity: string): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;
    turn.activity = activity;
    this.emit();
  }

  recordTurnToolCall(turnId: string, _tool: string, allowed: boolean): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;
    if (allowed) {
      turn.toolCalls += 1;
      this.stats.toolCalls += 1;
      this.countersFor(turn.agent).toolCalls += 1;
    } else {
      turn.permissionsBlocked += 1;
      this.stats.permissionsBlocked += 1;
    }
    this.emit();
  }

  updateTurnUsage(turnId: string, usage: TurnUsage): void {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return;
    const deltaIn = Math.max(0, usage.inputTokens - turn.inputTokens);
    const deltaOut = Math.max(0, usage.outputTokens - turn.outputTokens);
    if (deltaIn === 0 && deltaOut === 0) return;
    turn.inputTokens += deltaIn;
    turn.outputTokens += deltaOut;
    this.stats.inputTokens += deltaIn;
    this.stats.outputTokens += deltaOut;
    const counters = this.countersFor(turn.agent);
    counters.inputTokens += deltaIn;
    counters.outputTokens += deltaOut;
    this.emit();
  }

  finishTurn(
    turnId: string,
    outcome: 'ended' | 'failed',
    detail?: string
  ): CompletedTurnRecord | null {
    const turn = this.activeTurns.get(turnId);
    if (!turn) return null;
    this.activeTurns.delete(turnId);
    const now = this.now();
    const record: CompletedTurnRecord = {
      id: turn.id,
      agent: turn.agent,
      agentName: turn.agentName,
      model: turn.model,
      role: turn.role,
      taskTitle: turn.taskTitle,
      requestedBy: turn.requestedBy,
      outcome,
      detail,
      durationMs: Math.max(0, now - turn.startedAt),
      toolCalls: turn.toolCalls,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      finishedAt: now,
    };
    this.recentTurns.unshift(record);
    if (this.recentTurns.length > RECENT_TURNS_MAX) this.recentTurns.pop();
    const counters = this.countersFor(turn.agent);
    if (outcome === 'ended') {
      this.stats.turnsCompleted += 1;
      counters.completed += 1;
    } else {
      this.stats.turnsFailed += 1;
      counters.failed += 1;
    }
    this.emit();
    return record;
  }
}
