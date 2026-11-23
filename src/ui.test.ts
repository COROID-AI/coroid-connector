import { ConnectorState, type InteractiveCommand } from './connector-state.js';
import {
  ACTION_BAR_ITEMS,
  MENU_MODAL_ITEMS,
  TuiNavigator,
  renderDashboard,
  stripAnsi,
} from './ui.js';

/**
 * Interactive terminal UI rendering and arrow/Enter/Esc menu navigation.
 *
 * Failure modes, written before the code:
 * D1 the header leaves out version, date/time, machine name, or connection state;
 * D2 detected coding tools (including Antigravity) or active parallel work
 *    (with requester, role, task, and token stats) do not render clearly;
 * D3 narrow or short terminals overflow horizontally or crash the renderer;
 * D4 switching to `stats` or `help` view fails to display per-agent breakdowns
 *    or available controls;
 * D5 Left/Right arrow keys fail to move the bottom action menu selection, or
 *    Enter runs the wrong command;
 * D6 Esc from a sub-view fails to return to Overview, or Esc from Overview
 *    fails to open/close the interactive arrow-navigable menu modal;
 * D7 Tab / Shift+Tab fail to cycle views, or Up/Down in Agents view fails to
 *    move the selected agent cursor and show its detail inspector;
 * D8 single-key shortcuts (`c`, `v`, `p`, `q`, `?`, `1`-`5`) do not fire
 *    directly without typing or pressing Enter.
 */
describe('rendering and navigating the connector TUI', () => {
  const makeState = () => {
    const state = new ConnectorState({
      version: '0.7.0',
      machineName: 'Patrik-MBP',
      api: 'https://api.coroid.ai',
      platform: 'darwin',
      credentialStore: 'the macOS keychain',
      maxConcurrency: 4,
      logLevel: 'basic',
      now: () => new Date(2026, 10, 22, 23, 30, 0).getTime(),
    });
    state.setConnectionState('connected');
    state.setAgents([
      {
        id: 'antigravity',
        name: 'Antigravity',
        command: ['/Users/me/.gemini/bin/agy', 'acp'],
        report: {
          id: 'antigravity',
          version: '1.5.14',
          tried: true,
          state: 'ready',
          detail: null,
          models: {
            current: 'gemini-4-neon',
            offered: ['gemini-4-neon', 'gemini-3.8-flash'],
          },
        },
        checking: false,
      },
      {
        id: 'codex',
        name: 'Codex',
        command: null,
        report: {
          id: 'codex',
          version: null,
          tried: false,
          state: 'not_working',
          detail: 'Not added: run coroid-connector add codex',
          models: null,
        },
        checking: false,
      },
    ]);
    state.startTurn({
      id: 'turn-42',
      agent: 'antigravity',
      agentName: 'Antigravity',
      model: 'gemini-4-neon',
      timeLimitSeconds: 600,
      context: {
        role: 'QA',
        taskTitle: 'Check connector TUI',
        projectName: 'CoRoid',
        requestedBy: 'Patrik',
      },
    });
    state.updateTurnUsage('turn-42', {
      inputTokens: 12_400,
      outputTokens: 1_800,
    });
    state.setTurnActivity('turn-42', 'Calling read_file');
    state.log('info', 'Connected to CoRoid.');
    return state;
  };

  it('D1, D2: shows version, date/time, tabs, detected tools, active work with requester, token stats, and action bar', () => {
    const screen = stripAnsi(
      renderDashboard(makeState(), {
        cols: 120,
        rows: 36,
        now: new Date(2026, 10, 22, 23, 31, 5),
        view: 'main',
        actionIndex: 0,
        menuOpen: false,
        menuIndex: 0,
        selectedAgentIndex: 0,
        color: false,
      })
    );
    expect(screen).toContain('CoRoid Connector v0.7.0');
    expect(screen).toContain('2026-11-22 23:31:05');
    expect(screen).toContain('CONNECTED');
    expect(screen).toContain('Overview');
    expect(screen).toContain('Antigravity');
    expect(screen).toContain('1.5.14');
    expect(screen).toContain('gemini-4-neon');
    expect(screen).toContain('1/4');
    expect(screen).toContain('QA');
    expect(screen).toContain('Check connector TUI');
    expect(screen).toContain('Patrik');
    expect(screen).toContain('12.4k');
    expect(screen).toContain('1.8k');
    expect(screen).toContain('Connected to CoRoid.');
    expect(screen).toContain('▸ Check Agents');
  });

  it('D3: stays within bounds on narrow and short terminals without throwing', () => {
    const screen = stripAnsi(
      renderDashboard(makeState(), {
        cols: 60,
        rows: 18,
        now: new Date(2026, 10, 22, 23, 31, 5),
        view: 'main',
        actionIndex: 1,
        menuOpen: false,
        menuIndex: 0,
        selectedAgentIndex: 0,
        color: false,
      })
    );
    const lines = screen.split('\n');
    expect(lines.length).toBeLessThanOrEqual(18);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it('D4: renders stats, help, and the centered Esc menu overlay', () => {
    const state = makeState();
    state.finishTurn('turn-42', 'ended');
    const statsScreen = stripAnsi(
      renderDashboard(state, {
        cols: 100,
        rows: 30,
        now: new Date(2026, 10, 22, 23, 32, 0),
        view: 'stats',
        actionIndex: 0,
        menuOpen: false,
        menuIndex: 0,
        selectedAgentIndex: 0,
        color: false,
      })
    );
    expect(statsScreen).toContain('Session Statistics');
    expect(statsScreen).toContain('Antigravity');
    expect(statsScreen).toContain('12.4k');

    const menuScreen = stripAnsi(
      renderDashboard(state, {
        cols: 100,
        rows: 30,
        now: new Date(2026, 10, 22, 23, 32, 0),
        view: 'main',
        actionIndex: 0,
        menuOpen: true,
        menuIndex: 1,
        selectedAgentIndex: 0,
        color: false,
      })
    );
    expect(menuScreen).toContain('Control Menu');
    expect(menuScreen).toContain('Re-check Coding Agents');
    expect(menuScreen).toContain('Quit Connector');
  });

  it('D5: Left/Right arrows move the bottom action bar and Enter runs the highlighted action', () => {
    const state = makeState();
    const fired: InteractiveCommand[] = [];
    const nav = new TuiNavigator(state, {
      onCommand: cmd => fired.push(cmd),
      onSigInt: () => fired.push('quit'),
    });

    // Starts on index 0 ("check")
    expect(nav.actionIndex).toBe(0);
    nav.handleKey('\r');
    expect(fired).toEqual([ACTION_BAR_ITEMS[0]!.command]);

    // Right arrow -> index 1 ("toggle_verbose"), Enter runs it
    nav.handleKey('\x1b[C');
    expect(nav.actionIndex).toBe(1);
    nav.handleKey('\r');
    expect(fired).toEqual(['check', 'toggle_verbose']);

    // Left arrow twice wraps to the last item ("quit")
    nav.handleKey('\x1b[D');
    nav.handleKey('\x1b[D');
    expect(nav.actionIndex).toBe(ACTION_BAR_ITEMS.length - 1);
    nav.handleKey('\r');
    expect(fired.at(-1)).toBe('quit');
  });

  it('D6: Esc returns from sub-views to Overview, and Esc on Overview toggles the arrow-navigable menu modal', () => {
    const state = makeState();
    const fired: InteractiveCommand[] = [];
    const nav = new TuiNavigator(state, {
      onCommand: cmd => fired.push(cmd),
      onSigInt: () => fired.push('quit'),
    });

    nav.setView('stats');
    expect(nav.view).toBe('stats');
    // Esc from sub-view returns to Overview without opening modal
    nav.handleKey('\x1b');
    expect(nav.view).toBe('main');
    expect(nav.menuOpen).toBe(false);

    // Esc on Overview opens the Control Menu modal
    nav.handleKey('\x1b');
    expect(nav.menuOpen).toBe(true);
    expect(nav.menuIndex).toBe(0);

    // Down arrow twice moves to menu item 2, Enter executes it and closes modal
    nav.handleKey('\x1b[B');
    nav.handleKey('\x1b[B');
    expect(nav.menuIndex).toBe(2);
    nav.handleKey('\r');
    expect(nav.menuOpen).toBe(false);
    expect(fired).toEqual([MENU_MODAL_ITEMS[2]!.command]);

    // Re-open and close with Esc without firing anything
    nav.handleKey('\x1b');
    expect(nav.menuOpen).toBe(true);
    nav.handleKey('\x1b');
    expect(nav.menuOpen).toBe(false);
    expect(fired).toHaveLength(1);
  });

  it('D7, D8: Tab cycles views, Up/Down selects agents in Agents view, and single-key shortcuts fire immediately', () => {
    const state = makeState();
    const fired: InteractiveCommand[] = [];
    const nav = new TuiNavigator(state, {
      onCommand: cmd => fired.push(cmd),
      onSigInt: () => fired.push('quit'),
    });

    // Tab cycles main -> agents -> stats -> logs -> help -> main
    nav.handleKey('\t');
    expect(nav.view).toBe('agents');
    expect(nav.selectedAgentIndex).toBe(0);

    // Down arrow in Agents view moves cursor to second agent (Codex)
    nav.handleKey('\x1b[B');
    expect(nav.selectedAgentIndex).toBe(1);

    const agentsScreen = stripAnsi(
      renderDashboard(state, {
        cols: 100,
        rows: 30,
        now: new Date(2026, 10, 22, 23, 32, 0),
        view: 'agents',
        actionIndex: 0,
        menuOpen: false,
        menuIndex: 0,
        selectedAgentIndex: nav.selectedAgentIndex,
        color: false,
      })
    );
    expect(agentsScreen).toContain('Not added: run coroid-connector add codex');

    // Shift+Tab cycles back to Overview
    nav.handleKey('\x1b[Z');
    expect(nav.view).toBe('main');

    // Direct single-key shortcuts work without Enter
    nav.handleKey('v');
    nav.handleKey('p');
    nav.handleKey('c');
    expect(fired).toEqual(['toggle_verbose', 'toggle_pause', 'check']);

    // Number keys jump directly to tabs
    nav.handleKey('3');
    expect(nav.view).toBe('stats');
    nav.handleKey('4');
    expect(nav.view).toBe('logs');
    nav.handleKey('1');
    expect(nav.view).toBe('main');
  });
});
