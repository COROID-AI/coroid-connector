#!/usr/bin/env node
/**
 * A stand-in for a coding agent that speaks ACP over stdio, for the
 * connector's tests. No model.
 *
 *   --mode ready     opens a session
 *   --mode sign-in   refuses a session until the person signs in
 *   --mode broken    refuses a session for another reason
 *   --mode silent    never answers
 *   --mode exits     ends before it answers
 *   --version <v>    the version it reports (default 1.0.0)
 *
 * Asked for a turn, it lists the tools of the session's MCP server, reads a
 * file through it, says something and reports a verdict. Then:
 *   --mode asks              asks before every tool, and for one of its own
 *   --mode forgets           stops without a verdict the first time it is asked
 *   --mode slow              never finishes a turn
 *   --mode no-system-prompt  takes no system prompt
 *   --mode no-http           cannot use an MCP server over HTTP
 *
 * Its session offers a choice of model when it is started with one:
 *   --models a,b,c           the models, as a session setting beside two others
 *   --many-models 3000       that many models with long names instead
 *   --current-model b        the one it starts on (default: the first)
 *   --model-setting llm      the setting's id (default: model)
 *   --model-category none    the setting has no category, only its id says what it is
 *   --grouped                the models come in two groups
 *   --mode refuses-model     refuses to change the setting
 *   --mode ignores-model     answers a change and stays on its model
 *
 * With STAND_IN_RECORD set, it writes what it was started with and what the
 * new session asked for to that file; with STAND_IN_LOG, a line for each
 * thing that happened in a turn.
 */
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const flag = name => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const mode = flag('mode') ?? 'ready';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
/** One line per thing a test may want to know happened inside the agent. */
const note = entry => {
  if (process.env.STAND_IN_LOG) appendFileSync(process.env.STAND_IN_LOG, `${JSON.stringify(entry)}\n`);
};

if (mode === 'exits') process.exit(3);

const waiting = new Map();
let asked = 0;
const ask = (method, params) =>
  new Promise(resolve => {
    const id = `agent-${++asked}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
let session = null;
let toolCalls = 0;

const models = flag('many-models')
  ? Array.from({ length: Number(flag('many-models')) }, (_, index) => `provider-${index}/${'m'.repeat(90)}`)
  : (flag('models') ?? '').split(',').filter(Boolean);
let currentModel = flag('current-model') ?? models[0] ?? null;
const choice = (value, name) => ({ value, name });
/** The session's settings, as ACP lists them: the model is one of three, and not the first. */
function configOptions() {
  if (models.length === 0) return undefined;
  const half = Math.ceil(models.length / 2);
  const named = models.map(model => choice(model, model.toUpperCase()));
  return [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask', options: [choice('ask', 'Ask'), choice('auto', 'Auto')] },
    {
      id: flag('model-setting') ?? 'model',
      name: 'Model',
      ...(flag('model-category') === 'none' ? {} : { category: 'model' }),
      type: 'select',
      currentValue: currentModel,
      options: process.argv.includes('--grouped')
        ? [
            { group: 'first', name: 'First', options: named.slice(0, half) },
            { group: 'second', name: 'Second', options: named.slice(half) },
          ]
        : named,
    },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [choice('low', 'Low'), choice('high', 'High')] },
  ];
}

/** Calls a tool of the session's MCP server over HTTP, as an agent's MCP client does. */
async function mcp(method, params) {
  const server = session.mcpServers[0];
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...Object.fromEntries(server.headers.map(header => [header.name, header.value])),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}

const update = fields => send({ method: 'session/update', params: { sessionId: session.id, update: fields } });
const say = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** Asks the client whether a call may run; true only for an allow option. */
async function allowed(toolCall) {
  const answer = await ask('session/request_permission', {
    sessionId: session.id,
    toolCall,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  return answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';
}

async function coroidTool(name, args) {
  const toolCallId = `call-${++toolCalls}`;
  const server = session.mcpServers[0].name;
  if (mode === 'asks') {
    // As Codex does in a mode that asks: the call is reported first, the request then names only its id.
    update({ sessionUpdate: 'tool_call', toolCallId, title: `mcp.${server}.${name}`, kind: 'execute', status: 'pending', rawInput: { server, tool: name, arguments: args } });
    if (!(await allowed({ toolCallId, kind: 'execute', status: 'pending' }))) return note({ refused: name });
  } else {
    update({ sessionUpdate: 'tool_call', toolCallId, title: `mcp__${server}__${name}`, kind: 'other', status: 'pending', rawInput: args });
  }
  const answer = await mcp('tools/call', { name, arguments: args });
  note({ called: name, answer: answer.result ?? answer.error });
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
}

async function prompted(id, params) {
  const text = params.prompt.map(block => block.text ?? '').join('');
  session.prompts.push(text);
  note({ prompt: text });
  if (models.length > 0) note({ promptedOn: currentModel });
  if (mode === 'slow') return;
  if (mode === 'forgets' && session.prompts.length === 1) {
    say('I looked at the change.');
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  say('Reading ');
  say('the change.');
  const listed = await mcp('tools/list', {});
  note({ listed: (listed.result?.tools ?? []).map(tool => tool.name) });
  await coroidTool('read_file', { path: 'src/price.ts' });
  if (mode === 'asks') {
    const toolCallId = `call-${++toolCalls}`;
    update({ sessionUpdate: 'tool_call', toolCallId, title: `Bash: cat mcp__${session.mcpServers[0].name}__read_file`, kind: 'execute', status: 'pending', rawInput: { command: 'cat ~/.ssh/id_ed25519' } });
    note({ ownToolAllowed: await allowed({ toolCallId, kind: 'execute', status: 'pending' }) });
  }
  say('The verdict is PASS.');
  await coroidTool('report_qa_verdict', { verdict: 'PASS' });
  const usageArg = flag('usage');
  const usage = usageArg
    ? (() => {
        const [inputTokens, outputTokens] = usageArg.split(',').map(Number);
        return { inputTokens, outputTokens };
      })()
    : undefined;
  send({ id, result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) } });
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim() || mode === 'silent') return;
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (id !== undefined && method === undefined) {
    waiting.get(id)?.(message.result);
    return waiting.delete(id);
  }
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'stand-in', version: flag('version') ?? '1.0.0' },
        agentCapabilities: {
          ...(mode === 'omitted-mcp-caps' ? {} : { mcpCapabilities: { http: mode !== 'no-http' } }),
          ...(mode === 'no-system-prompt' ? {} : { sessionCapabilities: { systemPrompt: {} } }),
        },
        authMethods: [{ id: 'stand-in-login', name: 'Sign in' }],
      },
    });
  }
  if (method === 'session/new') {
    if (process.env.STAND_IN_RECORD) {
      writeFileSync(
        process.env.STAND_IN_RECORD,
        JSON.stringify({
          cwd: params.cwd,
          startedIn: process.cwd(),
          filesInCwd: existsSync(params.cwd) ? readdirSync(params.cwd).sort() : null,
          mcpServers: params.mcpServers,
          systemPrompt: params.systemPrompt ?? null,
          meta: params._meta ?? null,
          switchInEnvironment: process.env.STAND_IN_SWITCH ?? null,
        })
      );
    }
    if (mode === 'sign-in') return send({ id, error: { code: -32000, message: 'Authentication required' } });
    if (mode === 'broken') return send({ id, error: { code: -32603, message: 'This client is no longer supported.\nSecond line.' } });
    session = { id: 'session-1', mcpServers: params.mcpServers, prompts: [] };
    const settings = configOptions();
    return send({ id, result: { sessionId: session.id, ...(settings ? { configOptions: settings } : {}) } });
  }
  if (method === 'session/set_config_option') {
    note({ configured: { configId: params.configId, value: params.value }, prompts: session.prompts.length });
    if (mode === 'refuses-model') return send({ id, error: { code: -32602, message: 'That model is not available.' } });
    if (mode !== 'ignores-model') currentModel = params.value;
    return send({ id, result: { configOptions: configOptions() } });
  }
  if (method === 'session/set_mode') {
    note({ mode: params.modeId });
    return send({ id, result: {} });
  }
  if (method === 'session/prompt') return void prompted(id, params);
  if (method === 'session/cancel') return note({ cancelled: true });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
