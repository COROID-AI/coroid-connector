import { appendFileSync } from 'node:fs';
import { formatModelName } from './agent-models.js';
import {
  ConnectorState,
  formatDuration,
  formatTimeOnly,
  formatTimestamp,
  formatTokens,
  redactLogText,
  type ActiveTurnState,
  type AgentSnapshot,
  type InteractiveCommand,
  type LogEntry,
  type LogSeverity,
} from './connector-state.js';

export type PanelView = 'main' | 'agents' | 'stats' | 'logs' | 'help';

export const VIEW_ORDER: readonly PanelView[] = [
  'main',
  'agents',
  'stats',
  'logs',
  'help',
];

export interface MenuItem {
  label: (state: ConnectorState) => string;
  shortcut?: string;
  command: InteractiveCommand | 'open_menu' | 'view_logs';
}

/** Bottom action bar items, navigable directly with Left/Right arrows + Enter. */
export const ACTION_BAR_ITEMS: readonly MenuItem[] = [
  { label: () => 'Check Agents', shortcut: 'c', command: 'check' },
  {
    label: state =>
      state.logLevel === 'verbose' ? 'Log: Verbose' : 'Log: Basic',
    shortcut: 'v',
    command: 'toggle_verbose',
  },
  {
    label: state => (state.connectionState === 'paused' ? 'Resume' : 'Pause'),
    shortcut: 'p',
    command: 'toggle_pause',
  },
  { label: () => 'Clear Logs', command: 'clear' },
  { label: () => 'Menu', shortcut: 'Esc', command: 'open_menu' },
  { label: () => 'Quit', shortcut: 'q', command: 'quit' },
];

/** Centered Control Menu modal items, navigable with Up/Down arrows + Enter, closed with Esc. */
export const MENU_MODAL_ITEMS: readonly MenuItem[] = [
  {
    label: () => 'Re-check Coding Agents',
    shortcut: 'c',
    command: 'check',
  },
  {
    label: state =>
      state.logLevel === 'verbose'
        ? 'Switch Logging → Basic'
        : 'Switch Logging → Verbose',
    shortcut: 'v',
    command: 'toggle_verbose',
  },
  {
    label: state =>
      state.connectionState === 'paused'
        ? 'Resume Accepting Turns'
        : 'Pause Accepting Turns',
    shortcut: 'p',
    command: 'toggle_pause',
  },
  { label: () => 'View: Overview', shortcut: '1', command: 'main' },
  { label: () => 'View: Agents Inspector', shortcut: '2', command: 'agents' },
  { label: () => 'View: Session Statistics', shortcut: '3', command: 'stats' },
  {
    label: () => 'View: Full Activity Log',
    shortcut: '4',
    command: 'view_logs',
  },
  { label: () => 'Clear Activity Log', command: 'clear' },
  { label: () => 'Help & Keybindings', shortcut: '?', command: 'help' },
  { label: () => 'Quit Connector', shortcut: 'q', command: 'quit' },
];

const ESC = String.fromCharCode(0x1b);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g');
export const stripAnsi = (value: string): string =>
  value.replace(ANSI_PATTERN, '');

const makeStyle = (color: boolean) => {
  const wrap = (code: string) => (text: string) =>
    color ? `${ESC}[${code}m${text}${ESC}[0m` : text;
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    invert: wrap('7'),
    invertCyan: wrap('1;30;46'),
    invertWhite: wrap('1;30;47'),
    cyan: wrap('36'),
    boldCyan: wrap('1;36'),
    green: wrap('32'),
    boldGreen: wrap('1;32'),
    yellow: wrap('33'),
    boldYellow: wrap('1;33'),
    red: wrap('31'),
    boldRed: wrap('1;31'),
    magenta: wrap('35'),
    blue: wrap('34'),
    gray: wrap('90'),
  };
};

type Style = ReturnType<typeof makeStyle>;

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function clip(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

function clipAnsi(value: string, max: number): string {
  if (max <= 0) return '';
  if (visibleLength(value) <= max) return value;
  let out = '';
  let vis = 0;
  let i = 0;
  const target = Math.max(0, max - 1);
  while (i < value.length && vis < target) {
    if (value[i] === ESC && value[i + 1] === '[') {
      const end = value.indexOf('m', i);
      if (end !== -1) {
        out += value.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += value[i];
    vis += 1;
    i += 1;
  }
  const reset = `${ESC}[0m`;
  const trailing = `${out}${reset}…`;
  return trailing.startsWith(reset) ? trailing.slice(reset.length) : trailing;
}

function padRightAnsi(value: string, width: number): string {
  const clipped = visibleLength(value) > width ? clipAnsi(value, width) : value;
  const pad = Math.max(0, width - visibleLength(clipped));
  return clipped + ' '.repeat(pad);
}

function joinLeftRight(left: string, right: string, width: number): string {
  const rightLen = visibleLength(right);
  const availLeft = Math.max(0, width - rightLen - 1);
  const l = visibleLength(left) > availLeft ? clipAnsi(left, availLeft) : left;
  const gap = Math.max(1, width - visibleLength(l) - rightLen);
  const combined = `${l}${' '.repeat(gap)}${right}`;
  return visibleLength(combined) > width ? clipAnsi(combined, width) : combined;
}

function drawBox(
  title: string,
  bodyLines: string[],
  width: number,
  s: Style,
  rightTitle = '',
  borderColor: (t: string) => string = s.gray
): string[] {
  const inner = Math.max(1, width - 2);
  const titleText = title ? ` ${title} ` : '';
  const rightText = rightTitle ? ` ${rightTitle} ` : '';
  const used = visibleLength(titleText) + visibleLength(rightText);
  const dashCount = Math.max(0, inner - used);
  const top =
    borderColor('╭') +
    (used <= inner
      ? `${s.boldCyan(titleText)}${borderColor('─'.repeat(dashCount))}${rightText}`
      : clipAnsi(`${s.boldCyan(titleText)}${rightText}`, inner)) +
    borderColor('╮');
  const bottom = borderColor(`╰${'─'.repeat(inner)}╯`);
  const contentWidth = Math.max(1, inner - 2);
  const rows = bodyLines.map(
    line =>
      `${borderColor('│')} ${padRightAnsi(line, contentWidth)} ${borderColor('│')}`
  );
  return [top, ...rows, bottom];
}

function connectionBadge(state: ConnectorState, s: Style): string {
  switch (state.connectionState) {
    case 'connected':
      return s.boldGreen('● CONNECTED');
    case 'connecting':
      return s.boldCyan('◐ CONNECTING');
    case 'paused':
      return s.boldYellow('⏸ PAUSED');
    case 'reconnecting':
      return s.boldYellow('▲ RECONNECTING');
    case 'not_served':
      return s.boldRed('■ NOT SERVED');
    case 'stopping':
      return s.boldRed('■ STOPPING');
  }
}

function agentBadge(agent: AgentSnapshot, s: Style): string {
  if (agent.checking) return s.cyan('◌ checking…');
  const r = agent.report;
  if (!r) return s.gray('· pending');
  if (r.state === 'ready' && r.tried) return s.green('✓ ready');
  if (r.state === 'ready' && !r.tried) return s.yellow('⚠ untried');
  if (r.state === 'sign_in_needed') return s.yellow('! sign in');
  if (!agent.command) return s.gray('✗ not added');
  return s.gray('✗ not found');
}

function resolvedAgentPath(agent: AgentSnapshot): string | null {
  if (!agent.command) return null;
  if (agent.command[0] === process.execPath && agent.command[1]) {
    return agent.command[1];
  }
  return agent.command[0] ?? null;
}

function formatAgentRow(
  agent: AgentSnapshot,
  width: number,
  s: Style,
  options: { expanded?: boolean; selected?: boolean } = {}
): string {
  const cursor = options.selected ? s.boldCyan('▸ ') : '  ';
  const name = agent.name.padEnd(12);
  const badge = padRightAnsi(agentBadge(agent, s), 13);
  const r = agent.report;
  const ver = (r?.version ? `v${r.version}` : '—').padEnd(20);
  let extra = '';
  if (r?.state === 'ready' && r.models) {
    const count = r.models.offered.length;
    const rawModel = r.models.current ?? r.models.offered[0] ?? 'default';
    const model = formatModelName(rawModel, r.models.labels);
    extra = count > 0 ? `${model} (${count} models)` : model;
    if (!r.tried) extra += ' — untried version';
  } else if (r?.detail) {
    extra = r.detail;
  } else if (agent.checking) {
    extra = 'probing ACP session…';
  }
  const resolved = options.expanded ? resolvedAgentPath(agent) : null;
  const binarySuffix = resolved ? `  [${resolved}]` : '';
  const tailBudget = Math.max(0, width - 49);
  const tail = clip(`${extra}${binarySuffix}`, tailBudget);
  const line = `${cursor}${s.bold(name)} ${badge} ${s.dim(ver)} ${tail}`;
  return options.selected ? s.bold(line) : line;
}

function formatActiveTurnRow(
  turn: ActiveTurnState,
  nowMs: number,
  width: number,
  s: Style
): string {
  const elapsed = formatDuration(nowMs - turn.startedAt);
  const limit = formatDuration(turn.timeLimitSeconds * 1000);
  const slot = s.boldCyan(`#${turn.slot}`);
  const role = turn.role ? s.magenta(turn.role) : s.dim('ROLE');
  const agent =
    s.bold(turn.agentName) +
    (turn.model ? s.dim(`/${clip(turn.model, 18)}`) : '');
  const tokens =
    turn.inputTokens > 0 || turn.outputTokens > 0
      ? s.cyan(
          `↑${formatTokens(turn.inputTokens)} ↓${formatTokens(turn.outputTokens)}`
        )
      : s.dim('0 tok');
  const tools = s.dim(`${turn.toolCalls}t`);
  const who = turn.requestedBy ? s.dim(`by ${clip(turn.requestedBy, 16)}`) : '';
  const work = turn.taskTitle
    ? clip(
        turn.projectName
          ? `${turn.projectName}: ${turn.taskTitle}`
          : turn.taskTitle,
        Math.max(12, Math.floor(width * 0.28))
      )
    : clip(turn.activity, 24);
  const right = `${tools} ${tokens} ${s.dim(`${elapsed}/${limit}`)}`;
  const left = `${slot} ${agent} ${role} ${work}${who ? ` ${who}` : ''} ${s.dim(`· ${clip(turn.activity, 22)}`)}`;
  return joinLeftRight(left, right, width);
}

function severityTag(level: LogSeverity, s: Style): string {
  switch (level) {
    case 'info':
      return s.cyan('INFO');
    case 'work':
      return s.boldGreen('WORK');
    case 'tool':
      return s.blue('TOOL');
    case 'perm':
      return s.magenta('PERM');
    case 'warn':
      return s.boldYellow('WARN');
    case 'error':
      return s.boldRed('ERR ');
    case 'debug':
      return s.gray('DBG ');
  }
}

function formatLogLine(entry: LogEntry, width: number, s: Style): string {
  const time = s.dim(formatTimeOnly(entry.timestamp));
  const tag = severityTag(entry.level, s);
  const msgBudget = Math.max(8, width - 15);
  return `${time} ${tag} ${clip(entry.message, msgBudget)}`;
}

function renderTabStrip(
  state: ConnectorState,
  activeView: PanelView,
  width: number,
  s: Style
): string {
  const readyCount = state.agents.filter(
    a => a.report?.state === 'ready' && a.report.tried
  ).length;
  const tabs: Array<{ view: PanelView; label: string }> = [
    { view: 'main', label: '1 Overview' },
    {
      view: 'agents',
      label: `2 Agents (${readyCount}/${state.agents.length})`,
    },
    { view: 'stats', label: '3 Stats' },
    { view: 'logs', label: `4 Logs (${state.logLevel})` },
    { view: 'help', label: '5 Help' },
  ];
  const rendered = tabs
    .map(tab =>
      tab.view === activeView
        ? s.invertCyan(` ${tab.label} `)
        : s.dim(` ${tab.label} `)
    )
    .join(s.gray('│'));
  return joinLeftRight(` ${rendered}`, s.dim('Tab switch · Esc menu '), width);
}

function renderActionBar(
  state: ConnectorState,
  actionIndex: number,
  width: number,
  s: Style
): string {
  const items = ACTION_BAR_ITEMS.map((item, idx) => {
    const label = item.label(state);
    const shortcut = item.shortcut ? ` [${item.shortcut}]` : '';
    if (idx === actionIndex) {
      return s.invertCyan(` ▸ ${label} `);
    }
    return ` ${s.bold(label)}${s.dim(shortcut)} `;
  });
  return padRightAnsi(items.join(s.gray('│')), width);
}

function renderControlMenuModal(
  state: ConnectorState,
  menuIndex: number,
  cols: number,
  s: Style
): string[] {
  const modalWidth = Math.min(Math.max(44, Math.floor(cols * 0.6)), cols - 4);
  const innerWidth = modalWidth - 4;
  const rows = MENU_MODAL_ITEMS.map((item, idx) => {
    const selected = idx === menuIndex;
    const prefix = selected ? '▸ ' : '  ';
    const label = `${prefix}${item.label(state)}`;
    const right = item.shortcut ? `[${item.shortcut}]` : '';
    const line = joinLeftRight(label, right, innerWidth);
    return selected ? s.invertCyan(padRightAnsi(line, innerWidth)) : line;
  });
  rows.push('');
  rows.push(s.dim('↑↓ Move · Enter Select · Esc Close'));
  return drawBox('Control Menu', rows, modalWidth, s, s.dim('Esc'), s.cyan);
}

export interface RenderOptions {
  cols: number;
  rows: number;
  now?: Date;
  view: PanelView;
  actionIndex: number;
  menuOpen: boolean;
  menuIndex: number;
  selectedAgentIndex: number;
  scrollOffset?: number;
  statusMessage?: string | null;
  color?: boolean;
}

/**
 * Pure dashboard renderer: turns current `ConnectorState` and TUI navigation
 * state into a bounded, aligned terminal frame.
 */
export function renderDashboard(
  state: ConnectorState,
  options: RenderOptions
): string {
  const cols = Math.max(48, options.cols);
  const rows = Math.max(14, options.rows);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const s = makeStyle(options.color ?? true);
  const contentWidth = cols - 4;

  // 1. Header box (4 lines) + Tab bar (1 line)
  const titleLeft = `${s.boldCyan('◆')} ${s.bold(`CoRoid Connector v${state.version}`)}  ${connectionBadge(state, s)}`;
  const titleRight = `${s.dim(formatTimestamp(now))} ${s.gray('·')} ${s.dim(`up ${formatDuration(nowMs - state.startedAt)}`)}`;
  const metaLeft = `${s.dim('Host:')} ${clip(state.machineName, 22)} ${s.gray('·')} ${s.dim('API:')} ${clip(state.api, 34)}`;
  const logBadge =
    state.logLevel === 'verbose' ? s.boldYellow('VERBOSE') : s.dim('BASIC');
  const workers = `${state.activeTurns.size}/${state.maxConcurrency}`;
  const metaRight = `${s.dim('Workers:')} ${s.bold(workers)} ${s.gray('·')} ${s.dim('Log:')} ${logBadge}`;
  const headerLines = [
    ...drawBox(
      '',
      [
        joinLeftRight(titleLeft, titleRight, contentWidth),
        joinLeftRight(metaLeft, metaRight, contentWidth),
      ],
      cols,
      s
    ),
    renderTabStrip(state, options.view, cols, s),
  ];

  // 2. Interactive Action Menu Bar + Key Hint Footer (2 lines)
  const defaultHint = options.menuOpen
    ? 'Menu open: ↑↓ move · Enter run · Esc close'
    : '◀ ▶ action bar · Enter run · ↑↓ scroll/select · Tab switch tab · Esc menu/back · Ctrl+C quit';
  const footerLines = [
    renderActionBar(state, options.actionIndex, cols, s),
    padRightAnsi(s.dim(clip(options.statusMessage ?? defaultHint, cols)), cols),
  ];

  const available = rows - headerLines.length - footerLines.length;
  const middleLines: string[] = [];

  if (options.view === 'help') {
    const helpRows = [
      `${s.boldCyan('← / → + Enter')}   Navigate & trigger actions in the bottom action bar`,
      `${s.boldCyan('Esc')}             Open Control Menu (from Overview) or return to Overview`,
      `${s.boldCyan('↑ / ↓')}           Navigate Menu / Agents list, or scroll Activity Log & Stats`,
      `${s.boldCyan('Tab / Shift+Tab')} Cycle tabs (Overview · Agents · Stats · Logs · Help)`,
      `${s.boldCyan('1 – 5')}           Jump directly to any tab`,
      `${s.boldCyan('PgUp / PgDn')}     Fast-scroll the Activity Log`,
      '',
      `${s.bold('Instant Shortcuts:')}`,
      `  ${s.boldCyan('c')} / ${s.boldCyan('Ctrl+R')}   Re-probe all local coding agents & push fresh capabilities`,
      `  ${s.boldCyan('v')} / ${s.boldCyan('Ctrl+V')}   Toggle Basic ↔ Verbose logging live`,
      `  ${s.boldCyan('p')} / ${s.boldCyan('Ctrl+P')}   Pause / Resume accepting new turns (running turns finish)`,
      `  ${s.boldCyan('q')} / ${s.boldCyan('Ctrl+C')}   Graceful shutdown (press Ctrl+C twice to force-cancel turns)`,
    ];
    middleLines.push(
      ...drawBox(
        'Keyboard Controls & Shortcuts',
        helpRows.slice(0, Math.max(2, available - 2)),
        cols,
        s,
        s.dim('Esc back')
      )
    );
  } else if (options.view === 'stats') {
    const totalTok = state.stats.inputTokens + state.stats.outputTokens;
    const rowsOut: string[] = [
      `${s.bold('Totals:')} ${s.green(`${state.stats.turnsCompleted} completed`)} · ${state.stats.turnsFailed > 0 ? s.red(`${state.stats.turnsFailed} failed`) : s.dim('0 failed')} · ${state.stats.toolCalls} tool calls · ${state.stats.permissionsBlocked} blocked`,
      `${s.bold('Tokens:')} ${s.cyan(`↑ ${formatTokens(state.stats.inputTokens)} in`)} · ${s.cyan(`↓ ${formatTokens(state.stats.outputTokens)} out`)} · ${s.bold(`Σ ${formatTokens(totalTok)} total`)} · ${s.dim(`Polls: ${state.stats.polls} · Reconnects: ${state.stats.reconnects}`)}`,
      '',
      s.bold('By Agent:'),
    ];
    for (const agent of state.agents) {
      const c = state.agentStats[agent.id] ?? {
        completed: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
      };
      rowsOut.push(
        `  ${agent.name.padEnd(13)} ${String(c.completed).padStart(4)} ok  ` +
          `${String(c.failed).padStart(4)} fail  ${String(c.toolCalls).padStart(5)} tools  ` +
          `↑${formatTokens(c.inputTokens).padStart(7)}  ↓${formatTokens(c.outputTokens).padStart(7)}`
      );
    }
    if (state.recentTurns.length > 0) {
      rowsOut.push('', s.bold('Recent Turns:'));
      for (const recent of state.recentTurns) {
        const badge = recent.outcome === 'ended' ? s.green('✓') : s.red('✗');
        const when = s.dim(formatTimeOnly(new Date(recent.finishedAt)));
        const who = recent.requestedBy ? ` by ${recent.requestedBy}` : '';
        const tok = `↑${formatTokens(recent.inputTokens)} ↓${formatTokens(recent.outputTokens)}`;
        rowsOut.push(
          clipAnsi(
            `  ${badge} ${when} ${recent.agentName} ${recent.role ?? ''} ${recent.taskTitle ?? ''}${who} (${formatDuration(recent.durationMs)}, ${tok})`,
            contentWidth
          )
        );
      }
    }
    const capacity = Math.max(2, available - 2);
    const offset = Math.min(
      Math.max(0, options.scrollOffset ?? 0),
      Math.max(0, rowsOut.length - capacity)
    );
    middleLines.push(
      ...drawBox(
        'Session Statistics',
        rowsOut.slice(offset, offset + capacity),
        cols,
        s,
        s.dim('↑↓ scroll · Esc back')
      )
    );
  } else if (options.view === 'agents') {
    const selectedIdx = Math.min(
      Math.max(0, options.selectedAgentIndex),
      Math.max(0, state.agents.length - 1)
    );
    const listRows =
      state.agents.length > 0
        ? state.agents.map((agent, idx) =>
            formatAgentRow(agent, contentWidth, s, {
              selected: idx === selectedIdx,
            })
          )
        : [s.dim('Probing coding agents…')];
    const listBox = drawBox(
      'Detected Coding Tools (↑↓ select)',
      listRows,
      cols,
      s,
      s.dim('c re-check · Esc back')
    );

    const selected = state.agents[selectedIdx];
    const detailRows: string[] = [];
    if (selected) {
      const r = selected.report;
      const path = resolvedAgentPath(selected) ?? 'not installed / not added';
      detailRows.push(
        `${s.dim('Agent:')} ${s.bold(selected.name)} (${selected.id})  ${s.gray('·')}  ${s.dim('Status:')} ${agentBadge(selected, s)}  ${s.gray('·')}  ${s.dim('Version:')} ${r?.version ?? '—'}`
      );
      detailRows.push(`${s.dim('Path:')}  ${clip(path, contentWidth - 8)}`);
      if (r?.detail) {
        detailRows.push(
          `${s.dim('Info:')}  ${clip(r.detail, contentWidth - 8)}`
        );
      }
      if (r?.models && r.models.offered.length > 0) {
        const currentLabel = r.models.current
          ? formatModelName(r.models.current, r.models.labels)
          : 'default';
        detailRows.push(
          `${s.dim('Model:')} ${currentLabel} (${r.models.offered.length} offered)`
        );
        const listed = r.models.offered
          .slice(0, 12)
          .map(id => formatModelName(id, r.models?.labels))
          .join(', ');
        const more =
          r.models.offered.length > 12
            ? ` (+${r.models.offered.length - 12} more)`
            : '';
        detailRows.push(
          s.dim(`Offered: ${clip(`${listed}${more}`, contentWidth - 10)}`)
        );
      }
      detailRows.push(`${s.dim('Credential store:')} ${state.credentialStore}`);
    }
    const detailBox = drawBox(
      selected ? `Details: ${selected.name}` : 'Details',
      detailRows,
      cols,
      s
    );
    middleLines.push(...listBox, ...detailBox);
  } else if (options.view === 'logs') {
    const logCapacity = Math.max(2, available - 2);
    const visible = state.visibleLogs();
    const maxOffset = Math.max(0, visible.length - logCapacity);
    const offset = Math.min(Math.max(0, options.scrollOffset ?? 0), maxOffset);
    const sliceEnd = visible.length - offset;
    const sliceStart = Math.max(0, sliceEnd - logCapacity);
    const shown = visible
      .slice(sliceStart, sliceEnd)
      .map(entry => formatLogLine(entry, contentWidth, s));
    while (shown.length < logCapacity) shown.push('');
    const right =
      offset > 0
        ? s.yellow(`scrolled ↑${offset} · ↑↓/PgUp/PgDn`)
        : s.dim(`${state.logLevel} · ${visible.length} entries · v toggle`);
    middleLines.push(...drawBox('Activity Log', shown, cols, s, right));
  } else {
    // MAIN VIEW (Overview)
    const readyCount = state.agents.filter(
      a => a.report?.state === 'ready' && a.report.tried
    ).length;
    const agentRows =
      state.agents.length > 0
        ? state.agents.map(agent =>
            formatAgentRow(agent, contentWidth, s, {
              expanded: state.logLevel === 'verbose',
            })
          )
        : [s.dim('Probing coding agents on this machine…')];
    const agentsBox = drawBox(
      `Detected Coding Tools (${readyCount}/${state.agents.length} ready)`,
      agentRows,
      cols,
      s,
      s.dim(`Auth: ${clip(state.credentialStore, 22)}`)
    );

    const activeList = [...state.activeTurns.values()].sort(
      (a, b) => a.slot - b.slot
    );
    const workRows =
      activeList.length > 0
        ? activeList.map(turn =>
            formatActiveTurnRow(turn, nowMs, contentWidth, s)
          )
        : [
            state.connectionState === 'paused'
              ? s.yellow(
                  'Paused — not claiming new turns. Select Resume or press p.'
                )
              : s.dim(
                  `Idle — ready for up to ${state.maxConcurrency} parallel turns` +
                    (state.lastPollAt
                      ? ` · last poll ${formatDuration(nowMs - state.lastPollAt)} ago (${state.lastPollLatencyMs ?? 0}ms)`
                      : '')
                ),
          ];
    const workBox = drawBox(
      `Active Work (${activeList.length}/${state.maxConcurrency} parallel)`,
      workRows,
      cols,
      s
    );

    const totalTok = state.stats.inputTokens + state.stats.outputTokens;
    const statsLine = padRightAnsi(
      ` ${s.dim('Turns:')} ${s.green(`${state.stats.turnsCompleted} ok`)}${state.stats.turnsFailed > 0 ? ` ${s.red(`${state.stats.turnsFailed} fail`)}` : ''} ${s.gray('│')} ` +
        `${s.dim('Tokens:')} ${s.cyan(`↑${formatTokens(state.stats.inputTokens)}`)} ${s.cyan(`↓${formatTokens(state.stats.outputTokens)}`)} ${s.bold(`Σ${formatTokens(totalTok)}`)} ${s.gray('│')} ` +
        `${s.dim('Tools:')} ${state.stats.toolCalls}${state.stats.permissionsBlocked > 0 ? s.yellow(` (${state.stats.permissionsBlocked} blocked)`) : ''} ${s.gray('│')} ` +
        `${s.dim('Polls:')} ${state.stats.polls}`,
      cols
    );

    const usedAbove = agentsBox.length + workBox.length + 1;
    const remainingForLogs = available - usedAbove;
    middleLines.push(...agentsBox, ...workBox, statsLine);

    if (remainingForLogs >= 3) {
      const logCapacity = remainingForLogs - 2;
      const visible = state.visibleLogs();
      const maxOffset = Math.max(0, visible.length - logCapacity);
      const offset = Math.min(
        Math.max(0, options.scrollOffset ?? 0),
        maxOffset
      );
      const sliceEnd = visible.length - offset;
      const sliceStart = Math.max(0, sliceEnd - logCapacity);
      const shown = visible
        .slice(sliceStart, sliceEnd)
        .map(entry => formatLogLine(entry, contentWidth, s));
      while (shown.length < logCapacity) shown.push('');
      const logRight =
        offset > 0
          ? s.yellow(`scrolled ↑${offset}`)
          : s.dim(`${state.logLevel} · ${visible.length} entries`);
      middleLines.push(...drawBox('Activity Log', shown, cols, s, logRight));
    }
  }

  // Fit middle section strictly within available rows
  const budget = Math.max(0, available);
  const fittedMiddle = middleLines.slice(0, budget);
  while (fittedMiddle.length < budget) fittedMiddle.push('');

  const frame = [...headerLines, ...fittedMiddle, ...footerLines].map(line =>
    clipAnsi(line, cols)
  );

  // Overlay centered Control Menu modal when open
  if (options.menuOpen) {
    const modal = renderControlMenuModal(state, options.menuIndex, cols, s);
    const modalWidth = visibleLength(modal[0] ?? '');
    const leftPad = Math.max(0, Math.floor((cols - modalWidth) / 2));
    const startRow = Math.max(1, Math.floor((frame.length - modal.length) / 2));
    for (let i = 0; i < modal.length; i += 1) {
      const rowIdx = startRow + i;
      if (rowIdx < frame.length - 1) {
        const line = `${' '.repeat(leftPad)}${modal[i]}`;
        frame[rowIdx] = padRightAnsi(line, cols);
      }
    }
  }

  return frame.join('\n');
}

export interface ConnectorUICallbacks {
  onCommand(command: InteractiveCommand): void;
  onSigInt(): void;
}

/**
 * Pure keyboard state machine for the TUI: handles arrow keys, Enter, Esc,
 * Tab/Shift+Tab, PgUp/PgDn, and single-key shortcuts cleanly without needing
 * a live TTY (making navigation 100% unit-testable).
 */
export class TuiNavigator {
  view: PanelView = 'main';
  actionIndex = 0;
  menuOpen = false;
  menuIndex = 0;
  selectedAgentIndex = 0;
  scrollOffset = 0;

  constructor(
    private readonly state: ConnectorState,
    private readonly callbacks: ConnectorUICallbacks,
    private readonly onUpdate: () => void = () => undefined
  ) {}

  setView(view: PanelView): void {
    this.view = view;
    this.scrollOffset = 0;
    this.menuOpen = false;
    this.onUpdate();
  }

  private runItem(item: MenuItem): void {
    if (item.command === 'open_menu') {
      this.menuOpen = true;
      this.menuIndex = 0;
      this.onUpdate();
      return;
    }
    if (item.command === 'view_logs') {
      this.setView('logs');
      return;
    }
    this.menuOpen = false;
    if (
      item.command === 'main' ||
      item.command === 'agents' ||
      item.command === 'stats' ||
      item.command === 'help'
    ) {
      this.setView(item.command);
    }
    this.callbacks.onCommand(item.command);
    this.onUpdate();
  }

  handleKey(data: string): void {
    // Ctrl+C -> graceful / force shutdown
    if (data === '\x03') {
      this.callbacks.onSigInt();
      return;
    }
    // Ctrl+D -> quit
    if (data === '\x04') {
      this.callbacks.onCommand('quit');
      return;
    }
    // Ctrl+R -> check agents
    if (data === '\x12') {
      this.menuOpen = false;
      this.callbacks.onCommand('check');
      this.onUpdate();
      return;
    }
    // Ctrl+V -> toggle verbose
    if (data === '\x16') {
      this.callbacks.onCommand('toggle_verbose');
      this.onUpdate();
      return;
    }
    // Ctrl+P -> toggle pause
    if (data === '\x10') {
      this.callbacks.onCommand('toggle_pause');
      this.onUpdate();
      return;
    }

    // Modal menu navigation takes priority when open
    if (this.menuOpen) {
      if (data === ESC) {
        this.menuOpen = false;
        this.onUpdate();
        return;
      }
      if (data === `${ESC}[A` || data === 'k') {
        this.menuIndex =
          (this.menuIndex - 1 + MENU_MODAL_ITEMS.length) %
          MENU_MODAL_ITEMS.length;
        this.onUpdate();
        return;
      }
      if (data === `${ESC}[B` || data === 'j') {
        this.menuIndex = (this.menuIndex + 1) % MENU_MODAL_ITEMS.length;
        this.onUpdate();
        return;
      }
      if (data === '\r' || data === '\n' || data === ' ') {
        const chosen = MENU_MODAL_ITEMS[this.menuIndex];
        if (chosen) this.runItem(chosen);
        return;
      }
      return;
    }

    // Esc: return to Overview from sub-views, or open Control Menu from Overview
    if (data === ESC) {
      if (this.view !== 'main') {
        this.setView('main');
      } else {
        this.menuOpen = true;
        this.menuIndex = 0;
        this.onUpdate();
      }
      return;
    }

    // Tab / Shift+Tab: cycle tabs
    if (data === '\t') {
      const idx = VIEW_ORDER.indexOf(this.view);
      this.setView(VIEW_ORDER[(idx + 1) % VIEW_ORDER.length] ?? 'main');
      return;
    }
    if (data === `${ESC}[Z`) {
      const idx = VIEW_ORDER.indexOf(this.view);
      this.setView(
        VIEW_ORDER[(idx - 1 + VIEW_ORDER.length) % VIEW_ORDER.length] ?? 'main'
      );
      return;
    }

    // Left / Right arrows: move highlighted item in the bottom Action Bar
    if (data === `${ESC}[C`) {
      this.actionIndex = (this.actionIndex + 1) % ACTION_BAR_ITEMS.length;
      this.onUpdate();
      return;
    }
    if (data === `${ESC}[D`) {
      this.actionIndex =
        (this.actionIndex - 1 + ACTION_BAR_ITEMS.length) %
        ACTION_BAR_ITEMS.length;
      this.onUpdate();
      return;
    }

    // Enter / Space: execute highlighted Action Bar item
    if (data === '\r' || data === '\n' || data === ' ') {
      const chosen = ACTION_BAR_ITEMS[this.actionIndex];
      if (chosen) this.runItem(chosen);
      return;
    }

    // Up / Down arrows: select agent in Agents view, or scroll Logs / Stats
    if (data === `${ESC}[A` || data === 'k') {
      if (this.view === 'agents') {
        const count = Math.max(1, this.state.agents.length);
        this.selectedAgentIndex = (this.selectedAgentIndex - 1 + count) % count;
      } else if (this.view === 'stats') {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      } else {
        this.scrollOffset += 1;
      }
      this.onUpdate();
      return;
    }
    if (data === `${ESC}[B` || data === 'j') {
      if (this.view === 'agents') {
        const count = Math.max(1, this.state.agents.length);
        this.selectedAgentIndex = (this.selectedAgentIndex + 1) % count;
      } else if (this.view === 'stats') {
        this.scrollOffset += 1;
      } else {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      }
      this.onUpdate();
      return;
    }

    // PageUp / PageDown: fast-scroll log
    if (data === `${ESC}[5~`) {
      this.scrollOffset += 5;
      this.onUpdate();
      return;
    }
    if (data === `${ESC}[6~`) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
      this.onUpdate();
      return;
    }

    // Direct single-key shortcuts (no typing or Enter required)
    const key = data.toLowerCase();
    if (key === '1') return this.setView('main');
    if (key === '2' || key === 'a') return this.setView('agents');
    if (key === '3' || key === 's') return this.setView('stats');
    if (key === '4' || key === 'l') return this.setView('logs');
    if (key === '5' || key === '?') {
      return this.setView(this.view === 'help' ? 'main' : 'help');
    }
    if (key === 'm') {
      this.menuOpen = true;
      this.menuIndex = 0;
      this.onUpdate();
      return;
    }
    if (key === 'c' || key === 'r') {
      this.callbacks.onCommand('check');
      return;
    }
    if (key === 'v') {
      this.callbacks.onCommand('toggle_verbose');
      return;
    }
    if (key === 'p') {
      this.callbacks.onCommand('toggle_pause');
      return;
    }
    if (key === 'q') {
      this.callbacks.onCommand('quit');
    }
  }
}

/**
 * Manages either the live interactive ANSI TUI (when running on an interactive
 * TTY) or structured plain/JSON streaming logs (when piped, `--plain`, or `--json`).
 */
export class ConnectorUI {
  private readonly interactive: boolean;
  private readonly jsonMode: boolean;
  private logFile: string | null;
  private readonly color: boolean;
  private readonly nav: TuiNavigator;
  private statusMessage: string | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private renderScheduled = false;
  private started = false;
  private unsubscribeState: (() => void) | null = null;
  private onDataHandler: ((chunk: Buffer) => void) | null = null;
  private onResizeHandler: (() => void) | null = null;

  constructor(
    private readonly state: ConnectorState,
    callbacks: ConnectorUICallbacks,
    options: { plain: boolean; json: boolean; logFile?: string | null }
  ) {
    this.jsonMode = options.json;
    this.logFile = options.logFile ?? null;
    this.interactive =
      !options.plain &&
      !options.json &&
      Boolean(process.stdout.isTTY && process.stdin.isTTY);
    this.color = this.interactive;
    this.nav = new TuiNavigator(state, callbacks, () => this.scheduleRender());
  }

  get isInteractive(): boolean {
    return this.interactive;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.interactive) return;

    // Enter alternate screen, hide cursor, enable raw keyboard input.
    process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
    if (typeof process.stdin.setRawMode === 'function')
      process.stdin.setRawMode(true);
    process.stdin.resume();

    this.onDataHandler = (chunk: Buffer) =>
      this.nav.handleKey(chunk.toString('utf8'));
    process.stdin.on('data', this.onDataHandler);

    this.onResizeHandler = () => this.scheduleRender();
    process.stdout.on('resize', this.onResizeHandler);

    this.unsubscribeState = this.state.onChange(() => this.scheduleRender());
    this.tickTimer = setInterval(() => this.scheduleRender(), 1_000);
    this.tickTimer.unref();
    this.renderNow();
  }

  stop(finalMessage?: string): void {
    if (!this.started) return;
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.unsubscribeState?.();
    if (this.onDataHandler) process.stdin.off('data', this.onDataHandler);
    if (this.onResizeHandler)
      process.stdout.off('resize', this.onResizeHandler);

    if (this.interactive) {
      if (typeof process.stdin.setRawMode === 'function')
        process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
      const totalTok =
        this.state.stats.inputTokens + this.state.stats.outputTokens;
      const summary =
        `CoRoid Connector v${this.state.version} stopped · uptime ${formatDuration(Date.now() - this.state.startedAt)}` +
        ` · turns ${this.state.stats.turnsCompleted} ok / ${this.state.stats.turnsFailed} failed` +
        ` · tokens ${formatTokens(totalTok)} (↑${formatTokens(this.state.stats.inputTokens)} ↓${formatTokens(this.state.stats.outputTokens)})`;
      process.stdout.write(`${summary}\n`);
      if (finalMessage) process.stdout.write(`${finalMessage}\n`);
    } else if (finalMessage) {
      this.emitEntry(this.state.log('info', finalMessage));
    }
  }

  setView(view: PanelView): void {
    this.nav.setView(view);
  }

  flash(message: string): void {
    this.statusMessage = message;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusMessage = null;
      this.scheduleRender();
    }, 4_000);
    this.statusTimer.unref();
    this.scheduleRender();
  }

  log(level: LogSeverity, message: string, verboseOnly = false): void {
    const entry = this.state.log(level, message, verboseOnly);
    this.writeLogFile(entry);
    if (!this.interactive) {
      if (!entry.verboseOnly || this.state.logLevel === 'verbose') {
        this.emitEntry(entry);
      }
    }
  }

  private emitEntry(entry: LogEntry): void {
    if (this.jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ ts: entry.timestamp.toISOString(), level: entry.level, message: entry.message })}\n`
      );
      return;
    }
    const ts = formatTimestamp(entry.timestamp);
    const lvl = entry.level.toUpperCase().padEnd(5);
    process.stdout.write(`[${ts}] [${lvl}] ${entry.message}\n`);
  }

  private writeLogFile(entry: LogEntry): void {
    if (!this.logFile) return;
    const target = this.logFile;
    try {
      appendFileSync(
        target,
        `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] ${redactLogText(entry.message)}\n`,
        { mode: 0o600 }
      );
    } catch (error) {
      this.logFile = null;
      const reason = error instanceof Error ? error.message : String(error);
      this.state.log('warn', `Disabled log file ${target}: ${reason}`);
    }
  }

  private scheduleRender(): void {
    if (!this.interactive || !this.started || this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (this.started) this.renderNow();
    });
  }

  private renderNow(): void {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const frame = renderDashboard(this.state, {
      cols,
      rows,
      view: this.nav.view,
      actionIndex: this.nav.actionIndex,
      menuOpen: this.nav.menuOpen,
      menuIndex: this.nav.menuIndex,
      selectedAgentIndex: this.nav.selectedAgentIndex,
      scrollOffset: this.nav.scrollOffset,
      statusMessage: this.statusMessage,
      color: this.color,
    });
    // Synchronized output avoids any flicker on modern terminals.
    process.stdout.write(`${ESC}[?2026h${ESC}[H${ESC}[2J${frame}${ESC}[?2026l`);
  }
}
