import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary } from './resolve-binary.js';

/**
 * Resolving a coding agent's CLI executable (such as `agy`, `agent`, `opencode`).
 *
 * Failure modes, written before the code:
 * R1 a binary present on PATH is not found, or an existing executable on PATH
 *    is needlessly rewritten when PATH already resolves it cleanly;
 * R2 a broken symlink earlier on PATH (such as a removed Antigravity app
 *    launcher) masks a working binary in a fallback directory (`~/.gemini/bin/agy`);
 * R3 a directory on PATH with the same name is mistaken for the executable;
 * R4 a binary absent from PATH (non-login shell) but present in a known
 *    install directory (`~/.gemini/bin/agy`) is not detected;
 * R5 when the binary exists nowhere, it throws instead of returning the bare
 *    command name for normal ENOENT handling.
 */
describe('resolving an agent CLI binary', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'coroid-resolve-bin-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const makeExecutable = (dir: string, name: string): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    chmodSync(file, 0o755);
    return file;
  };

  it('R1: keeps the bare command name when a valid executable is on PATH', () => {
    const binDir = join(scratch, 'path-valid');
    makeExecutable(binDir, 'agy');
    expect(resolveBinary('agy', { pathEnv: binDir, fallbackDirs: [] })).toBe(
      'agy'
    );
  });

  it('R2: skips a broken symlink on PATH and finds the real binary in a fallback directory', () => {
    const brokenDir = join(scratch, 'path-broken');
    const fallbackDir = join(scratch, 'fallback-real');
    mkdirSync(brokenDir, { recursive: true });
    symlinkSync(join(scratch, 'does-not-exist'), join(brokenDir, 'agy'));
    const real = makeExecutable(fallbackDir, 'agy');
    expect(
      resolveBinary('agy', { pathEnv: brokenDir, fallbackDirs: [fallbackDir] })
    ).toBe(real);
  });

  it('R3: ignores a directory with the same name on PATH', () => {
    const dirOnPath = join(scratch, 'path-has-dir');
    const fallbackDir = join(scratch, 'fallback-after-dir');
    mkdirSync(join(dirOnPath, 'agy'), { recursive: true });
    const real = makeExecutable(fallbackDir, 'agy');
    expect(
      resolveBinary('agy', { pathEnv: dirOnPath, fallbackDirs: [fallbackDir] })
    ).toBe(real);
  });

  it('R4: finds a binary in fallback directories when absent from PATH', () => {
    const emptyPath = join(scratch, 'path-empty');
    const geminiBin = join(scratch, 'home-gemini-bin');
    mkdirSync(emptyPath, { recursive: true });
    const real = makeExecutable(geminiBin, 'agy');
    expect(
      resolveBinary('agy', { pathEnv: emptyPath, fallbackDirs: [geminiBin] })
    ).toBe(real);
  });

  it('R5: returns the bare name when not found anywhere', () => {
    expect(
      resolveBinary('no-such-cli', {
        pathEnv: '',
        fallbackDirs: [join(scratch, 'missing')],
      })
    ).toBe('no-such-cli');
  });
});
