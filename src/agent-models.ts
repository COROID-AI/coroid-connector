import { LOCAL_AGENT_MODEL_MAX_LENGTH, LOCAL_AGENT_MODELS_MAX } from './protocol/local-agents.js';
import { AcpFailure, type AcpAgent } from './acp.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** The session setting that chooses an agent's model. */
export interface ModelSetting {
  /** The setting's id, which a change names. */
  configId: string;
  /** The model the session is on. */
  current: string | null;
  /** The models the session offers, by the names the agent takes, in its order. */
  offered: string[];
}

/** The values of a setting's options: a plain list, or groups of them. */
function values(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.filter(isRecord).flatMap(option => {
    if (Array.isArray(option.options)) return values(option.options);
    const value = text(option.value);
    return value ? [value] : [];
  });
}

/**
 * Plan 47 Phase 5b: the choice of model in what an agent answers when a
 * session is opened or a setting is changed (ACP `configOptions`). It is the
 * setting of the category `model`, or, where an agent names no categories,
 * the one whose id is `model`. Null when the session offers no such choice.
 */
export function modelSetting(answer: Record<string, unknown>): ModelSetting | null {
  const settings = Array.isArray(answer.configOptions) ? answer.configOptions.filter(isRecord) : [];
  const setting = settings.find(one => one.category === 'model') ?? settings.find(one => one.id === 'model');
  const configId = setting ? text(setting.id) : null;
  if (!setting || !configId) return null;
  const offered = [...new Set(values(setting.options))];
  return offered.length > 0 ? { configId, current: text(setting.currentValue), offered } : null;
}

const NAMES_BYTES_MAX = 28_000;

/**
 * The models a machine reports of an agent. The description of a machine is
 * one request of at most 100 kB for up to three agents, so of a very long
 * list the end is left out; CoRoid reads no longer names and no more of
 * them than its own limits.
 */
export function reportedModels(offered: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const name of offered) {
    if (name.length > LOCAL_AGENT_MODEL_MAX_LENGTH) continue;
    bytes += Buffer.byteLength(name);
    if (kept.length === LOCAL_AGENT_MODELS_MAX || bytes > NAMES_BYTES_MAX) break;
    kept.push(name);
  }
  return kept;
}

/**
 * Puts a session on the model a turn names, before anything is asked of the
 * agent. A turn runs on the model it names or not at all: a session that
 * does not offer the model, an agent that refuses the change, and an answer
 * that still shows another model each fail with the reason.
 */
export async function putOnModel(input: {
  agent: Pick<AcpAgent, 'request'>;
  agentName: string;
  /** What the agent answered when the session was opened. */
  session: Record<string, unknown>;
  sessionId: string;
  model: string;
  timeoutMs: number;
}): Promise<void> {
  const { agentName, model, sessionId } = input;
  const setting = modelSetting(input.session);
  if (!setting?.offered.includes(model)) {
    throw new AcpFailure(`${agentName} does not offer the model ${model} on this machine`);
  }
  if (setting.current === model) return;
  const changed = await input.agent.request(
    'session/set_config_option',
    { sessionId, configId: setting.configId, value: model },
    input.timeoutMs
  );
  if (modelSetting(changed)?.current !== model) {
    throw new AcpFailure(`${agentName} did not change to the model ${model}`);
  }
}
