import {
  LOCAL_AGENT_MODEL_MAX_LENGTH,
  LOCAL_AGENT_MODELS_MAX,
} from './protocol/local-agents.js';
import { AcpFailure, type AcpAgent } from './acp.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/** The session setting that chooses an agent's model. */
export interface ModelSetting {
  /** The setting's id, which a change names. */
  configId: string;
  /** The model the session is on. */
  current: string | null;
  /** The models the session offers, by the names the agent takes, in its order. */
  offered: string[];
  /** Human-readable display labels reported by the agent for offered model IDs. */
  labels: Record<string, string>;
}

interface ParsedOption {
  value: string;
  label: string | null;
}

/** Formats a friendly label from an ACP option's name & description when distinct from its raw ID. */
function optionLabel(
  option: Record<string, unknown>,
  value: string
): string | null {
  const name = text(option.name);
  const description = text(option.description);
  if (
    value.toLowerCase() === 'default' &&
    description &&
    description.length <= 48 &&
    !description.toLowerCase().startsWith('for ')
  ) {
    return `Default — ${description}`;
  }
  if (!name || name.toLowerCase() === value.toLowerCase()) return null;
  return name;
}

/** The values (and optional human-readable labels) of a setting's options: a plain list, or groups of them. */
function parsedOptions(options: unknown): ParsedOption[] {
  if (!Array.isArray(options)) return [];
  return options.filter(isRecord).flatMap(option => {
    if (Array.isArray(option.options)) return parsedOptions(option.options);
    const value = text(option.value);
    return value ? [{ value, label: optionLabel(option, value) }] : [];
  });
}

/**
 * Plan 47 Phase 5b: the choice of model in what an agent answers when a
 * session is opened or a setting is changed (ACP `configOptions`). It is the
 * setting of the category `model`, or, where an agent names no categories,
 * the one whose id is `model`. Null when the session offers no such choice.
 */
export function modelSetting(
  answer: Record<string, unknown>
): ModelSetting | null {
  const settings = Array.isArray(answer.configOptions)
    ? answer.configOptions.filter(isRecord)
    : [];
  const setting =
    settings.find(one => one.category === 'model') ??
    settings.find(one => one.id === 'model');
  const configId = setting ? text(setting.id) : null;
  if (!setting || !configId) return null;
  const entries = parsedOptions(setting.options);
  const offered: string[] = [];
  const labels: Record<string, string> = {};
  for (const entry of entries) {
    if (!offered.includes(entry.value)) offered.push(entry.value);
    if (entry.label && !(entry.value in labels)) {
      labels[entry.value] = entry.label;
    }
  }
  return offered.length > 0
    ? { configId, current: text(setting.currentValue), offered, labels }
    : null;
}

const NAMES_BYTES_MAX = 24_000;
const LABELS_BYTES_MAX = 12_000;

/**
 * The models a machine reports of an agent. The description of a machine is
 * one request of at most 100 kB for all agents, so of a very long list the
 * end is left out; CoRoid reads no longer names and no more of them than its
 * own limits.
 */
export function reportedModels(offered: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const name of offered) {
    if (name.length > LOCAL_AGENT_MODEL_MAX_LENGTH) continue;
    bytes += Buffer.byteLength(name);
    if (kept.length === LOCAL_AGENT_MODELS_MAX || bytes > NAMES_BYTES_MAX)
      break;
    kept.push(name);
  }
  return kept;
}

/**
 * Bounded human-readable labels for the kept models, omitted when none differ
 * from their raw IDs. Keeps the machine description comfortably within limits.
 */
export function reportedModelLabels(
  keptOffered: readonly string[],
  labels: Record<string, string>
): Record<string, string> | undefined {
  const kept: Record<string, string> = {};
  let bytes = 0;
  for (const id of keptOffered) {
    const label = labels[id];
    if (!label || label.length > LOCAL_AGENT_MODEL_MAX_LENGTH) continue;
    if (label.toLowerCase() === id.toLowerCase()) continue;
    const size = Buffer.byteLength(id) + Buffer.byteLength(label) + 8;
    if (bytes + size > LABELS_BYTES_MAX) break;
    kept[id] = label;
    bytes += size;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Formats a model ID with its dynamic human-readable label when one exists. */
export function formatModelName(
  modelId: string,
  labels?: Record<string, string> | null
): string {
  const label = labels?.[modelId];
  if (!label || label.toLowerCase() === modelId.toLowerCase()) return modelId;
  return `${label} (${modelId})`;
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
    throw new AcpFailure(
      `${agentName} does not offer the model ${model} on this machine`
    );
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
