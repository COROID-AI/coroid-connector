import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** An agent refused a request, did not answer, or is not there. `code` is its JSON-RPC error code, if it gave one. */
export class AcpFailure extends Error {
  constructor(
    message: string,
    readonly code: number | null = null
  ) {
    super(message);
    this.name = 'AcpFailure';
  }
}

/** What the client does with what the agent sends on its own. Without it, every request of the agent is refused. */
export interface AcpListener {
  /** A notification: the agent's messages and tool calls during a turn. */
  notified?(method: string, params: Record<string, unknown>): void;
  /** A request, e.g. for permission. Undefined refuses it as not offered. */
  asked?(
    method: string,
    params: Record<string, unknown>
  ): Record<string, unknown> | undefined;
  /** A line written by the agent to stderr (for verbose diagnostics). */
  stderr?(line: string): void;
}

export interface AcpAgent {
  pid: number | null;
  /** Sends one request and waits for its answer. */
  request(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<Record<string, unknown>>;
  /** Tells the agent something that needs no answer. */
  notify(method: string, params: unknown): void;
  /** Ends the agent: asked first, then made to. */
  stop(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const STDERR_RING_LIMIT = 24;

/**
 * Starts a coding agent that speaks the Agent Client Protocol over its
 * standard input and output (JSON-RPC, one message per line). This client
 * offers the agent nothing by itself: a request of the agent is refused
 * unless the listener answers it.
 */
export function startAgent(
  command: string[],
  options: { cwd: string; env?: Record<string, string>; listener?: AcpListener }
): AcpAgent {
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: AcpFailure) => void;
    }
  >();
  const stderrLines: string[] = [];
  let ended: AcpFailure | null = null;
  let nextId = 1;

  const end = (failure: AcpFailure): void => {
    ended ??= failure;
    for (const pending of waiting.values()) pending.reject(ended);
    waiting.clear();
  };
  child.once('error', error =>
    end(new AcpFailure(`${executable} could not be started: ${error.message}`))
  );
  child.once('exit', (code, signal) => {
    const lastErr = stderrLines[stderrLines.length - 1];
    const hint = lastErr ? ` — ${lastErr.slice(0, 180)}` : '';
    end(
      new AcpFailure(
        `The agent ended before it answered (${signal ?? `exit code ${code}`})${hint}`
      )
    );
  });
  // A write to an agent that has gone is reported by its exit, not here.
  child.stdin.on('error', () => undefined);

  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (stderrLines.length >= STDERR_RING_LIMIT) stderrLines.shift();
      stderrLines.push(trimmed.slice(0, 300));
      options.listener?.stderr?.(trimmed);
    });
  }

  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim().startsWith('{')) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      // The protocol is one JSON message per line: an agent that sends something else is not working.
      return end(
        new AcpFailure(
          `The agent sent a line that is not a message (${error instanceof Error ? error.message : String(error)})`
        )
      );
    }
    if (!isRecord(message)) return;
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {};
      if (message.id === undefined)
        return options.listener?.notified?.(message.method, params);
      const answer = options.listener?.asked?.(message.method, params);
      child.stdin.write(
        `${JSON.stringify(
          answer
            ? { jsonrpc: '2.0', id: message.id, result: answer }
            : {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Not offered by this client' },
              }
        )}\n`
      );
      return;
    }
    const pending =
      typeof message.id === 'number' ? waiting.get(message.id) : undefined;
    if (!pending) return;
    waiting.delete(message.id as number);
    if (isRecord(message.error)) {
      const code =
        typeof message.error.code === 'number' ? message.error.code : null;
      pending.reject(
        new AcpFailure(
          String(message.error.message ?? 'The agent refused the request'),
          code
        )
      );
    } else {
      pending.resolve(isRecord(message.result) ? message.result : {});
    }
  });

  return {
    pid: child.pid ?? null,
    request: (method, params, timeoutMs) =>
      new Promise((resolve, reject) => {
        if (ended) return reject(ended);
        const id = nextId++;
        const late = setTimeout(() => {
          waiting.delete(id);
          reject(
            new AcpFailure(
              `The agent did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`
            )
          );
        }, timeoutMs);
        waiting.set(id, {
          resolve: result => {
            clearTimeout(late);
            resolve(result);
          },
          reject: error => {
            clearTimeout(late);
            reject(error);
          },
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        );
      }),
    notify: (method, params) => {
      if (!ended)
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
        );
    },
    stop: () =>
      new Promise(resolve => {
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.pid === undefined
        )
          return resolve();
        const force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 2_000);
        force.unref();
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
