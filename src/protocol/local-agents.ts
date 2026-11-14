/**
 * Plan 47: a person's own coding agents, reached through a connector on their
 * machine. What the connector, the authorization server (api-auth), the
 * orchestrator and the portal must agree on.
 */

/**
 * A connector signs in for its own resource with this one scope. A token for
 * the connector does nothing at CoRoid MCP, and an MCP token nothing here.
 */
export const CONNECTOR_SCOPE = 'connector.turns';
export const CONNECTOR_RESOURCE_PATH = '/connector';

/** How long a connector waits between two requests for work when there is none. Each request is also its heartbeat. */
export const CONNECTOR_POLL_SECONDS = 15;
/** A connector that asked for work within this time counts as connected. */
export const CONNECTOR_LIVENESS_SECONDS = 60;

/**
 * The agents CoRoid has a profile for: how to start each one with only
 * CoRoid's tools (Plan 47 Phase 2). A connector reports no other agent.
 */
export const LOCAL_AGENT_IDS = [
  'codex',
  'opencode',
  'claude',
  'cursor',
] as const;
export type LocalAgentId = (typeof LOCAL_AGENT_IDS)[number];

/** A known local agent, or null: a name another release wrote is no agent to this one. */
export function parseLocalAgentId(value: unknown): LocalAgentId | null {
  return LOCAL_AGENT_IDS.find(known => known === value) ?? null;
}

/**
 * The roles a local agent may run, as an assignment names them (Plan 47
 * Phase 5e, E1): every role of a profile but the Decision engine, which is
 * not an agent run but a call to a decisions API whose answer carries a
 * probability for each allowed answer. Kept equal to the profile's roles
 * by a test; written out so that the connector's bundle needs nothing else.
 */
export const LOCAL_AGENT_ROLES = [
  'ARCHITECT',
  'DEV',
  'QA',
  'REVIEWER',
  'WEB_TESTER',
  'ASSISTANT',
  'ATTACHMENT_INSPECTOR',
  'DEPENDENCY_ANALYZER',
  'EXPLORER',
  'HOOK_EXECUTOR',
  'DEVELOPER_SUB',
  'TRANSLATOR',
] as const;

export function localAgentMayRun(agentType: string): boolean {
  const role = agentType.trim().toUpperCase();
  return LOCAL_AGENT_ROLES.some(allowed => allowed === role);
}

/**
 * What a connector found when it started an agent, without a model request:
 * `ready` (a session opened), `sign_in_needed` (the agent asked for a
 * sign-in) or `not_working` (not installed, or it failed to start).
 */
export const LOCAL_AGENT_STATES = [
  'ready',
  'sign_in_needed',
  'not_working',
] as const;
export type LocalAgentState = (typeof LOCAL_AGENT_STATES)[number];

export interface LocalAgentReport {
  id: LocalAgentId;
  /** The version the agent gave when it started; null when it did not start. */
  version: string | null;
  /** Whether that version is one the profile was tried on. An untried version is shown and not used. */
  tried: boolean;
  state: LocalAgentState;
  /** One line from the agent on why it is not ready. */
  detail: string | null;
  /** Phase 5b: the agent's models. Null from a connector that does not say (before 0.3.0), or an agent that offers no choice. */
  models: LocalAgentModels | null;
}

/** The models of one agent on one machine: what its owner's sign-in offers. */
export interface LocalAgentModels {
  /** The model the agent uses when a turn names none: the one its owner has set in it. */
  current: string | null;
  /** The models its session offers, by the names the agent takes. */
  offered: string[];
}

/**
 * A model's name is short and plain; a machine reports no more of them than
 * this. OpenCode listed 529 on the machine of the trial (2026-11-13).
 */
export const LOCAL_AGENT_MODEL_MAX_LENGTH = 120;
export const LOCAL_AGENT_MODELS_MAX = 1_000;

/** What a connector says about its machine with its first request and whenever it changes. */
export interface ConnectorDescription {
  /** The machine's name, as the person will recognise it in the portal. */
  name: string;
  /** `process.platform` of the machine: darwin, linux, win32. */
  platform: string;
  connectorVersion: string;
  agents: LocalAgentReport[];
}

/**
 * One role's work for an agent on the machine (Plan 47 Phase 4). The agent
 * reasons there; CoRoid's tools for the role are an MCP server it calls, and
 * nothing of the machine is its to use.
 */
export interface ConnectorTurn {
  id: string;
  agent: LocalAgentId;
  /** The role's instructions: a system prompt where the agent takes one, else the start of the first message. */
  rolePrompt: string;
  /** What the agent is asked first. */
  message: string;
  /** CoRoid's tools for this turn: the address of an MCP server and the token that is worth this turn only. */
  tools: { url: string; token: string };
  /** Seconds the turn may take in all; the connector ends the agent after that. */
  timeLimitSeconds: number;
  /** Phase 5b: the model the agent is to use for this turn; null leaves it at what its owner has set. */
  model: string | null;
}

/** The answer to a request for work: a turn when one is waiting for this machine. */
export interface ConnectorPollResponse {
  turn: ConnectorTurn | null;
  pollAfterSeconds: number;
}

/** What a connector tells CoRoid about a turn while it runs, in order. */
export type ConnectorTurnEvent =
  /** The agent said something: a whole message, not a fragment. */
  | { type: 'message'; text: string }
  /** The tokens the agent says it has used so far in this turn. */
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /** The agent stopped by itself and waits to be told more. */
  | { type: 'stopped'; reason: string }
  /** The agent could not be started, broke, or ran out of time. */
  | { type: 'failed'; reason: string };

/** What CoRoid answers: go on, say this to the agent, or end the agent's session. */
export type ConnectorTurnDirective =
  | { action: 'continue' }
  | { action: 'say'; text: string }
  | { action: 'end' };

/**
 * A person's machine as the portal lists it: one sign-in of a connector.
 * Until the connector has asked for work once, CoRoid knows only the name it
 * signed in with.
 */
export interface ConnectedMachine {
  id: string;
  name: string;
  platform: string | null;
  connectorVersion: string | null;
  agents: LocalAgentReport[];
  connected: boolean;
  signedInAt: string;
  lastSeenAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;

/** A model's name as an agent takes it: short, on one line, or null. */
export function parseLocalAgentModel(value: unknown): string | null {
  const name = boundedText(value, LOCAL_AGENT_MODEL_MAX_LENGTH);
  if (!name) return null;
  // A name with a control character in it is no name.
  const plain = [...name].every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
  return plain ? name : null;
}

/** What a machine says about an agent's models; anything else is "does not say". */
function agentModels(value: unknown): LocalAgentModels | null {
  if (!isRecord(value) || !Array.isArray(value.offered)) return null;
  const offered: string[] = [];
  for (const entry of value.offered) {
    const name = parseLocalAgentModel(entry);
    if (name && !offered.includes(name)) offered.push(name);
    if (offered.length === LOCAL_AGENT_MODELS_MAX) break;
  }
  return { current: parseLocalAgentModel(value.current), offered };
}

function agentReport(value: unknown): LocalAgentReport | null {
  if (!isRecord(value)) return null;
  const id = LOCAL_AGENT_IDS.find(known => known === value.id);
  const state = LOCAL_AGENT_STATES.find(known => known === value.state);
  if (!id || !state || typeof value.tried !== 'boolean') return null;
  return {
    id,
    version: boundedText(value.version, 60),
    tried: value.tried,
    state,
    detail: boundedText(value.detail, 300),
    // A malformed list of models is no reason to lose an agent that is ready.
    models: agentModels(value.models),
  };
}

/** Reads a turn CoRoid handed over; anything that is not exactly a turn gives null. */
export function parseConnectorTurn(value: unknown): ConnectorTurn | null {
  if (!isRecord(value) || !isRecord(value.tools)) return null;
  const agent = LOCAL_AGENT_IDS.find(known => known === value.agent);
  const id = boundedText(value.id, 100);
  const url = boundedText(value.tools.url, 2_000);
  const token = boundedText(value.tools.token, 500);
  const limit = value.timeLimitSeconds;
  if (!agent || !id || !url || !token) return null;
  if (typeof value.rolePrompt !== 'string' || typeof value.message !== 'string')
    return null;
  if (typeof limit !== 'number' || !(limit > 0)) return null;
  // A CoRoid before Phase 5b names no model. One that names something that is no model sent no turn.
  const named = value.model !== undefined && value.model !== null;
  const model = named ? parseLocalAgentModel(value.model) : null;
  if (named && !model) return null;
  return {
    id,
    agent,
    rolePrompt: value.rolePrompt,
    message: value.message,
    tools: { url, token },
    timeLimitSeconds: limit,
    model,
  };
}

const MESSAGE_LIMIT = 200_000;

function turnEvent(value: unknown): ConnectorTurnEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === 'message' && typeof value.text === 'string')
    return { type: 'message', text: value.text.slice(0, MESSAGE_LIMIT) };
  if (
    value.type === 'usage' &&
    Number.isInteger(value.inputTokens) &&
    Number.isInteger(value.outputTokens) &&
    (value.inputTokens as number) >= 0 &&
    (value.outputTokens as number) >= 0
  ) {
    return {
      type: 'usage',
      inputTokens: value.inputTokens as number,
      outputTokens: value.outputTokens as number,
    };
  }
  const reason = boundedText(value.reason, 500);
  if ((value.type === 'stopped' || value.type === 'failed') && reason)
    return { type: value.type, reason };
  return null;
}

/** Reads what a connector reported about a turn; null when any entry is not an event. */
export function parseConnectorTurnEvents(
  value: unknown
): ConnectorTurnEvent[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const events = value.map(turnEvent);
  return events.every((event): event is ConnectorTurnEvent => event !== null)
    ? events
    : null;
}

/** Reads CoRoid's answer to a report; anything else means go on. */
export function parseConnectorTurnDirective(
  value: unknown
): ConnectorTurnDirective {
  if (isRecord(value) && value.action === 'end') return { action: 'end' };
  if (
    isRecord(value) &&
    value.action === 'say' &&
    typeof value.text === 'string'
  )
    return { action: 'say', text: value.text };
  return { action: 'continue' };
}

/** Reads a stored list of agents; an entry that is not a report is left out. */
export function parseLocalAgentReports(value: unknown): LocalAgentReport[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(agentReport)
    .filter((agent): agent is LocalAgentReport => agent !== null);
}

/**
 * Reads what a connector sent about its machine. Anything that is not exactly
 * a description gives null: a connector is a program on someone's machine and
 * what it sends is shown in the portal, so nothing is passed on unread.
 */
export function parseConnectorDescription(
  value: unknown
): ConnectorDescription | null {
  if (!isRecord(value) || !Array.isArray(value.agents)) return null;
  const name = boundedText(value.name, 100);
  const platform = boundedText(value.platform, 30);
  const connectorVersion = boundedText(value.connectorVersion, 30);
  const agents = value.agents.map(agentReport);
  if (!name || !platform || !connectorVersion) return null;
  if (agents.length > LOCAL_AGENT_IDS.length) return null;
  const read = agents.filter(
    (agent): agent is LocalAgentReport => agent !== null
  );
  if (read.length !== agents.length) return null;
  if (new Set(read.map(agent => agent.id)).size !== read.length) return null;
  return { name, platform, connectorVersion, agents: read };
}
