import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdLock } from './lock.js';
import { VERSION } from './version.js';

/**
 * One connector per sign-in. Two connectors on the same file would each
 * renew with a refresh token the other has already spent, and CoRoid ends a
 * sign-in when that happens.
 *
 * Failure modes, written before the code:
 * K1 a second connector starts on a sign-in that a running one holds;
 * K2 a connector that crashed leaves a lock nobody can ever take again;
 * K3 a connector that ends leaves its lock, or removes another's;
 * K4 the version the connector reports is not the version of its package.
 */
const scratch = mkdtempSync(join(tmpdir(), 'coroid-connector-lock-'));
const file = join(scratch, 'sign-in.json.lock');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => rmSync(file, { force: true }));

describe('one connector per sign-in', () => {
  it('K1, K3: a second connector is refused while the first runs, and may start when it has ended', () => {
    const first = holdLock(file);
    expect(first).not.toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    expect(holdLock(file)).toBeNull();
    expect(existsSync(file)).toBe(true);

    first?.release();
    expect(existsSync(file)).toBe(false);
    const second = holdLock(file);
    expect(second).not.toBeNull();
    second?.release();
  });

  it('K2: the lock of a connector that is no longer running is taken over', () => {
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    writeFileSync(file, gone.stdout.toString());
    const taken = holdLock(file);
    expect(taken).not.toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    taken?.release();

    writeFileSync(file, 'not a process id');
    const afterGarbage = holdLock(file);
    expect(afterGarbage).not.toBeNull();
    afterGarbage?.release();
  });

  it('K3: releasing does not remove a lock that another connector has since taken', () => {
    const mine = holdLock(file);
    writeFileSync(file, '1');
    mine?.release();
    expect(readFileSync(file, 'utf8')).toBe('1');
  });

  it('K4: the connector reports the version of its package', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
    expect(VERSION).toBe(manifest.version);
    // Here the portal's committed file; in the public repository (Plan 48) the built one.
    expect([`./bundle/${VERSION}/coroid-connector.mjs`, 'dist/coroid-connector.mjs']).toContain(manifest.bin['coroid-connector']);
  });
});
