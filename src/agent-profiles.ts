import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentId } from './protocol/local-agents.js';
import {
  adapterVersion,
  installedAdapter,
  isAddableAgent,
} from './agent-install.js';
import { cursorSettingsRefusal } from './cursor-settings.js';
import { resolveBinary } from './resolve-binary.js';

/**
 * How the connector starts one coding agent so that it has CoRoid's tools
 * and nothing of its own (Plan 47 Phase 2 found no agent that does so as it
 * comes, and a switch of its own in each). A profile belongs to the versions
 * it was tried on: `tried` says whether a version is one of them.
 */
/** What leaves an agent with the tools of one MCP server and nothing of its own. */
export interface AgentSwitch {
  /** Extra CLI flags appended to the profile's command for this session. */
  args?: string[];
  /** Where the switch is the agent's environment. */
  env?: Record<string, string>;
  /** Where it is a file the agent reads from the session's directory. */
  files?: Record<string, string>;
  /** Where it is metadata of the new session. */
  sessionMeta?: Record<string, unknown>;
  /** Prepares any external per-session switch state before the agent starts. */
  prepare?(): void;
  /** Cleans up any external per-session switch state when the agent stops. */
  cleanup?(): void;
}

export interface AgentProfile {
  id: LocalAgentId;
  name: string;
  /**
   * The command that starts the agent as an ACP agent. Null for an agent
   * whose adapter is not added on this machine (Plan 48a): nothing is
   * downloaded to start it.
   */
  command: string[] | null;
  /** The switch, for a session whose one MCP server has this name. */
  ownToolsOff(server: string): AgentSwitch;
  /** The agent's strictest mode: it then asks before each tool, and only CoRoid's are allowed. */
  mode?: string;
  /** The switch in words, for a record of how the agent was run. */
  switchedOffBy: string;
  tried(version: string): boolean;
  /** Plan 48: how to ask the agent its version when its ACP answer names none (Cursor). */
  versionCommand?: string[];
  /** Plan 48: why the agent may not be used on this machine, or null (Cursor's own settings). */
  refuses?: () => string | null;
  /**
   * True for ACP agents that support HTTP MCP servers in `session/new` even
   * when `initialize` omits `agentCapabilities.mcpCapabilities`. Explicit
   * `mcpCapabilities.http === false` is still refused.
   */
  assumesHttpMcp?: boolean;
}

// The adapter versions the profiles were tried on are the ones the release's lockfiles install.
const CLAUDE_ADAPTER = adapterVersion('claude');
const CODEX_ADAPTER = adapterVersion('codex');

function antigravitySwitch(home: string): AgentSwitch {
  const cliDirName = `coroid-${randomBytes(6).toString('hex')}`;
  const cliDirPath = join(home, '.gemini', 'antigravity-cli', cliDirName);
  const settings = {
    agentMode: '',
    toolPermission: 'strict',
    allowNonWorkspaceAccess: false,
    permissions: {
      deny: [
        'read_file(*)',
        'write_file(*)',
        'command(*)',
        'read_url(*)',
        'execute_url(*)',
        'download_url(*)',
      ],
    },
  };
  return {
    args: [
      '--include-default-customizations=false',
      '--cli_dir_name',
      cliDirName,
    ],
    prepare: () => {
      mkdirSync(cliDirPath, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(cliDirPath, 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
        {
          mode: 0o600,
        }
      );
    },
    cleanup: () => {
      rmSync(cliDirPath, { recursive: true, force: true });
    },
  };
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'codex',
    name: 'Codex',
    // The adapter brings the Codex version it was built for, so the tried pair is what runs.
    command: null,
    ownToolsOff: () => ({
      env: {
        CODEX_CONFIG: JSON.stringify({
          features: {
            shell_tool: false,
            unified_exec: false,
            apps: false,
            plugins: false,
            multi_agent: false,
            view_image: false,
            image_generation: false,
            browser_use: false,
            computer_use: false,
          },
          web_search: 'disabled',
        }),
      },
    }),
    mode: 'read-only',
    switchedOffBy:
      'CODEX_CONFIG: features shell_tool, unified_exec, apps, plugins, multi_agent, view_image, image_generation, browser_use, computer_use off and web_search disabled; session mode read-only',
    tried: version => version === CODEX_ADAPTER,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: ['opencode', 'acp'],
    // The last matching rule wins: everything is refused except the tools of the session's one MCP server.
    ownToolsOff: server => ({
      files: {
        'opencode.jsonc': `${JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            permissions: [
              { action: '*', resource: '*', effect: 'deny' },
              { action: `${server}_*`, resource: '*', effect: 'allow' },
            ],
          },
          null,
          2
        )}\n`,
      },
    }),
    switchedOffBy:
      'opencode.jsonc in the session’s directory: permissions deny every action, then allow the tools of the session’s one MCP server',
    tried: version => /^2\.2\.\d+$/.test(version),
  },
  {
    id: 'claude',
    name: 'Claude',
    command: null,
    // No tools of Claude Code's own, and none of the person's settings, MCP servers or connectors.
    // It waits for a call to CoRoid's tools as long as the gateway does (a build or the tests run up to 30 minutes).
    ownToolsOff: () => ({
      env: { MCP_TOOL_TIMEOUT: String(32 * 60_000) },
      sessionMeta: {
        claudeCode: {
          // persistSession false: no transcript of the turn under ~/.claude (Plan 48c).
          options: {
            tools: [],
            strictMcpConfig: true,
            settingSources: [],
            persistSession: false,
          },
        },
      },
    }),
    mode: 'default',
    switchedOffBy:
      'session metadata: claudeCode.options = { tools: [], strictMcpConfig: true, settingSources: [], persistSession: false }; session mode default; MCP_TOOL_TIMEOUT 32 minutes',
    tried: version => version === CLAUDE_ADAPTER,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    // The person's own Cursor CLI, signed in with `agent login`.
    command: ['agent', 'acp'],
    // Cursor's project permissions, where a deny wins over an allow: everything of its own is denied on every
    // path; the session's one server is allowed. Its web fetch, web search and browser ask first, and the
    // connector refuses them, as long as Cursor's own settings ask (`refuses`, set per machine).
    ownToolsOff: server => ({
      files: {
        '.cursor/cli.json': `${JSON.stringify(
          {
            permissions: {
              allow: [`Mcp(${server}:*)`],
              deny: [
                'Shell(*)',
                'Read(*)',
                'Read(**)',
                'Read(/**)',
                'Read(~/**)',
                'Write(*)',
                'Write(**)',
                'Write(/**)',
                'Write(~/**)',
                'WebFetch(*)',
              ],
            },
          },
          null,
          2
        )}\n`,
      },
    }),
    switchedOffBy:
      '.cursor/cli.json in the session’s directory: permissions deny its shell, reads, writes and web fetches on every path and allow the tools of the session’s one MCP server; its web fetch, web search and browser ask first and are refused',
    // Cursor's CLI updates itself; the builds of the month it was tried in (2026-11-14, 2026.11.13-eacade1).
    tried: version => /^2026\.11\.\d+-[0-9a-f]+$/.test(version),
    versionCommand: ['agent', '--version'],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    // Google Antigravity CLI (`agy acp`), signed in on this machine.
    command: ['agy', 'acp'],
    ownToolsOff: () => antigravitySwitch(homedir()),
    mode: 'default',
    switchedOffBy:
      'isolated --cli_dir_name settings.json (toolPermission strict, allowNonWorkspaceAccess false, permissions deny read_file, write_file, command, read_url, execute_url, download_url) and --include-default-customizations=false; session mode default',
    tried: version => /^1\.5\.\d+$/.test(version),
    assumesHttpMcp: true,
  },
];

/**
 * The profiles as they run on this machine: Codex and Claude Code from the
 * adapters added under the person's home directory, with the Node that runs
 * the connector; OpenCode, Cursor and Antigravity from the person's own
 * installation (searching standard install paths when not on PATH).
 */
export function agentProfiles(home: string): AgentProfile[] {
  return AGENT_PROFILES.map(profile => {
    if (profile.id === 'cursor') {
      const bin = resolveBinary('agent', {
        fallbackDirs: [
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ],
      });
      return {
        ...profile,
        command: [bin, 'acp'],
        versionCommand: [bin, '--version'],
        refuses: () => cursorSettingsRefusal(home),
      };
    }
    if (profile.id === 'opencode') {
      const bin = resolveBinary('opencode', {
        fallbackDirs: [
          join(home, '.opencode', 'bin'),
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ],
      });
      return { ...profile, command: [bin, 'acp'] };
    }
    if (profile.id === 'antigravity') {
      const bin = resolveBinary('agy', {
        fallbackDirs: [
          join(home, '.gemini', 'bin'),
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ],
      });
      return {
        ...profile,
        command: [bin, 'acp'],
        ownToolsOff: () => antigravitySwitch(home),
      };
    }
    if (!isAddableAgent(profile.id)) return profile;
    const entry = installedAdapter(home, profile.id);
    return { ...profile, command: entry ? [process.execPath, entry] : null };
  });
}
