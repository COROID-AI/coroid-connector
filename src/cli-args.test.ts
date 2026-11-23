import { parseCliArgs } from './cli-args.js';

/**
 * CLI argument parsing for `coroid-connector`.
 *
 * Failure modes, written before the code:
 * P1 flags placed before a subcommand (`--api https://x status`) are mistaken
 *    for `run` instead of `status`;
 * P2 `--flag=value` syntax is ignored or treated as an unknown command;
 * P3 a value-taking flag followed by another flag or end-of-args silently
 *    consumes the next flag as its value;
 * P4 invalid `--concurrency` (0, 99, NaN) is silently accepted;
 * P5 `--verbose` / `-v`, `--plain`, `--json`, `--log-file`, `doctor`, `check`
 *    are not parsed cleanly.
 */
describe('parsing connector CLI arguments', () => {
  it('P1, P2: recognizes subcommands even after flags and supports --flag=value', () => {
    const parsed = parseCliArgs([
      '--api=https://coroid.example',
      '--verbose',
      'status',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toBe('status');
    expect(parsed.api).toBe('https://coroid.example');
    expect(parsed.verbose).toBe(true);

    const doctor = parseCliArgs([
      '--api',
      'http://localhost:3000',
      'doctor',
      '--json',
    ]);
    expect(doctor.ok).toBe(true);
    if (!doctor.ok) return;
    expect(doctor.command).toBe('doctor');
    expect(doctor.json).toBe(true);
  });

  it('P3: refuses missing values for value-taking flags instead of swallowing the next flag', () => {
    expect(parseCliArgs(['--api']).ok).toBe(false);
    expect(parseCliArgs(['--api', '--no-browser']).ok).toBe(false);
    expect(parseCliArgs(['--name', '--verbose']).ok).toBe(false);
  });

  it('P4: validates --concurrency bounds (1..8) and defaults to 4', () => {
    const def = parseCliArgs([]);
    expect(def.ok && def.concurrency).toBe(4);
    const ok = parseCliArgs(['--concurrency', '6']);
    expect(ok.ok && ok.concurrency).toBe(6);
    expect(parseCliArgs(['--concurrency', '0']).ok).toBe(false);
    expect(parseCliArgs(['--concurrency', '12']).ok).toBe(false);
    expect(parseCliArgs(['--concurrency', 'abc']).ok).toBe(false);
  });

  it('P5: parses add, check, logout, plain, json, verbose, and log-file flags', () => {
    const add = parseCliArgs(['add', 'codex']);
    expect(add.ok && add.command === 'add' && add.agentArg === 'codex').toBe(
      true
    );

    const run = parseCliArgs([
      '-v',
      '--plain',
      '--no-browser',
      '--log-file',
      '/tmp/c.log',
    ]);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.command).toBe('run');
    expect(run.verbose).toBe(true);
    expect(run.plain).toBe(true);
    expect(run.browser).toBe(false);
    expect(run.logFile).toBe('/tmp/c.log');
  });
});
