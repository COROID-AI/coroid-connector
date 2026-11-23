import { MAX_CONCURRENCY, TURNS_AT_ONCE } from './connect.js';

export type CliCommand =
  | 'run'
  | 'status'
  | 'check'
  | 'doctor'
  | 'add'
  | 'logout'
  | 'help'
  | 'version';

export interface ParsedCliArgs {
  ok: true;
  command: CliCommand;
  agentArg: string;
  api: string | undefined;
  name: string | undefined;
  stateDir: string | undefined;
  logFile: string | undefined;
  concurrency: number;
  browser: boolean;
  verbose: boolean;
  plain: boolean;
  json: boolean;
}

export interface CliArgError {
  ok: false;
  message: string;
}

const VALUE_FLAGS = new Set([
  'api',
  'name',
  'state-dir',
  'concurrency',
  'log-file',
]);
const COMMANDS = new Set<CliCommand>([
  'run',
  'status',
  'check',
  'doctor',
  'add',
  'logout',
]);

/**
 * Parses `coroid-connector` CLI arguments. Supports `--flag=value` and
 * `--flag value` in any position relative to subcommands, rejects missing
 * flag values instead of swallowing the next flag, and validates bounds.
 */
export function parseCliArgs(args: string[]): ParsedCliArgs | CliArgError {
  let command: CliCommand | null = null;
  let agentArg = '';
  let api: string | undefined;
  let name: string | undefined;
  let stateDir: string | undefined;
  let logFile: string | undefined;
  let concurrency = TURNS_AT_ONCE;
  let browser = true;
  let verbose = false;
  let plain = false;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i] ?? '';
    if (raw === '--help' || raw === '-h') {
      return {
        ok: true,
        command: 'help',
        agentArg: '',
        api,
        name,
        stateDir,
        logFile,
        concurrency,
        browser,
        verbose,
        plain,
        json,
      };
    }
    if (raw === '--version' || raw === '-V') {
      return {
        ok: true,
        command: 'version',
        agentArg: '',
        api,
        name,
        stateDir,
        logFile,
        concurrency,
        browser,
        verbose,
        plain,
        json,
      };
    }
    if (raw === '--no-browser') {
      browser = false;
      continue;
    }
    if (raw === '--verbose' || raw === '-v') {
      verbose = true;
      continue;
    }
    if (raw === '--plain' || raw === '--no-ui') {
      plain = true;
      continue;
    }
    if (raw === '--json') {
      json = true;
      continue;
    }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      const flagName = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
      if (!VALUE_FLAGS.has(flagName)) {
        return {
          ok: false,
          message: `Unknown option: --${flagName}. Run coroid-connector --help for usage.`,
        };
      }
      let value: string | undefined;
      if (eq >= 0) {
        value = raw.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { ok: false, message: `--${flagName} requires a value.` };
        }
        value = next;
        i += 1;
      }
      if (!value.trim()) {
        return {
          ok: false,
          message: `--${flagName} requires a non-empty value.`,
        };
      }
      if (flagName === 'api') api = value;
      else if (flagName === 'name') name = value;
      else if (flagName === 'state-dir') stateDir = value;
      else if (flagName === 'log-file') logFile = value;
      else if (flagName === 'concurrency') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
          return {
            ok: false,
            message: `--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}.`,
          };
        }
        concurrency = n;
      }
      continue;
    }
    if (raw.startsWith('-')) {
      return {
        ok: false,
        message: `Unknown option: ${raw}. Run coroid-connector --help for usage.`,
      };
    }
    if (command === null) {
      if (COMMANDS.has(raw as CliCommand)) {
        command = raw as CliCommand;
      } else {
        return {
          ok: false,
          message: `Unknown command: ${raw}. Run coroid-connector --help for usage.`,
        };
      }
    } else if (command === 'add' && !agentArg) {
      agentArg = raw;
    } else {
      return {
        ok: false,
        message: `Unexpected argument: ${raw}. Run coroid-connector --help for usage.`,
      };
    }
  }

  return {
    ok: true,
    command: command ?? 'run',
    agentArg,
    api,
    name,
    stateDir,
    logFile,
    concurrency,
    browser,
    verbose,
    plain,
    json,
  };
}
