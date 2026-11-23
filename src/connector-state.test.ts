import {
  ConnectorState,
  formatDuration,
  formatTimestamp,
  formatTokens,
  parseInteractiveCommand,
} from './connector-state.js';

/**
 * Live connector telemetry, parallel slot tracking, token statistics, and
 * interactive command parsing.
 *
 * Failure modes, written before the code:
 * S1 parallel turns overwrite each other's slot numbers or token totals;
 * S2 incremental usage updates double-count tokens instead of tracking per-turn
 *    deltas into cumulative totals;
 * S3 log ring buffer grows without bound in long-running sessions;
 * S4 interactive commands fail to recognize single-key shortcuts, slash forms,
 *    or case-insensitive commands;
 * S5 basic vs verbose log filtering hides important errors or leaks debug noise
 *    in basic mode.
 */
describe('connector runtime state and telemetry', () => {
  it('S1, S2: tracks concurrent turns, slots, per-agent stats, and non-double-counted token totals', () => {
    const state = new ConnectorState({
      version: '0.7.0',
      machineName: 'MacBook',
      api: 'https://api.coroid.ai',
      platform: 'darwin',
      credentialStore: 'the macOS keychain',
      maxConcurrency: 4,
      logLevel: 'basic',
      now: () => 1_700_000_000_000,
    });

    const t1 = state.startTurn({
      id: 'turn-1',
      agent: 'antigravity',
      agentName: 'Antigravity',
      model: 'gemini-4-neon',
      timeLimitSeconds: 600,
      context: {
        role: 'QA',
        taskTitle: 'Verify checkout',
        projectName: 'Shop',
        requestedBy: 'Patrik',
      },
    });
    const t2 = state.startTurn({
      id: 'turn-2',
      agent: 'claude',
      agentName: 'Claude',
      model: null,
      timeLimitSeconds: 300,
      context: {
        role: 'DEV',
        taskTitle: 'Fix header',
        projectName: 'Shop',
        requestedBy: 'Ada',
      },
    });
    expect(t1.slot).toBe(1);
    expect(t2.slot).toBe(2);
    expect(state.activeTurns.size).toBe(2);

    state.updateTurnUsage('turn-1', { inputTokens: 1_000, outputTokens: 200 });
    state.updateTurnUsage('turn-1', { inputTokens: 2_500, outputTokens: 450 });
    state.updateTurnUsage('turn-2', { inputTokens: 500, outputTokens: 100 });
    state.recordTurnToolCall('turn-1', 'read_file', true);
    state.recordTurnToolCall('turn-1', 'run_command', false);

    expect(state.stats.inputTokens).toBe(3_000);
    expect(state.stats.outputTokens).toBe(550);
    expect(state.stats.toolCalls).toBe(1);
    expect(state.stats.permissionsBlocked).toBe(1);

    state.finishTurn('turn-1', 'ended');
    state.finishTurn('turn-2', 'failed', 'Timed out');
    expect(state.activeTurns.size).toBe(0);
    expect(state.stats.turnsCompleted).toBe(1);
    expect(state.stats.turnsFailed).toBe(1);
    expect(state.agentStats.antigravity).toEqual({
      completed: 1,
      failed: 0,
      inputTokens: 2_500,
      outputTokens: 450,
      toolCalls: 1,
    });
    expect(state.agentStats.claude).toEqual({
      completed: 0,
      failed: 1,
      inputTokens: 500,
      outputTokens: 100,
      toolCalls: 0,
    });
  });

  it('S3, S5: bounds log buffer and separates basic from verbose entries', () => {
    const state = new ConnectorState({
      version: '0.7.0',
      machineName: 'MacBook',
      api: 'https://api.coroid.ai',
      platform: 'darwin',
      credentialStore: 'file',
      maxConcurrency: 4,
      logLevel: 'basic',
    });
    for (let i = 0; i < 600; i += 1) {
      state.log('debug', `poll #${i}`, true);
    }
    state.log('info', 'Connected');
    expect(state.logs.length).toBeLessThanOrEqual(500);
    expect(state.visibleLogs().map(entry => entry.message)).toEqual([
      'Connected',
    ]);
    state.setLogLevel('verbose');
    expect(state.visibleLogs().length).toBeGreaterThan(100);
  });

  it('S4: parses control commands and single-key shortcuts', () => {
    expect(parseInteractiveCommand('c')).toBe('check');
    expect(parseInteractiveCommand('/check')).toBe('check');
    expect(parseInteractiveCommand('VERBOSE')).toBe('verbose');
    expect(parseInteractiveCommand('basic')).toBe('basic');
    expect(parseInteractiveCommand('v')).toBe('toggle_verbose');
    expect(parseInteractiveCommand('p')).toBe('toggle_pause');
    expect(parseInteractiveCommand('pause')).toBe('pause');
    expect(parseInteractiveCommand('resume')).toBe('resume');
    expect(parseInteractiveCommand('stats')).toBe('stats');
    expect(parseInteractiveCommand('agents')).toBe('agents');
    expect(parseInteractiveCommand('quit')).toBe('quit');
    expect(parseInteractiveCommand('exit')).toBe('quit');
    expect(parseInteractiveCommand('?')).toBe('help');
    expect(parseInteractiveCommand('nonsense')).toBeNull();
  });

  it('formats timestamps, durations, and token counts cleanly', () => {
    expect(formatTimestamp(new Date(2026, 10, 22, 9, 5, 7))).toBe(
      '2026-11-22 09:05:07'
    );
    expect(formatDuration(9_000)).toBe('9s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatTokens(420)).toBe('420');
    expect(formatTokens(12_450)).toBe('12.5k');
    expect(formatTokens(1_520_000)).toBe('1.52M');
  });
});
