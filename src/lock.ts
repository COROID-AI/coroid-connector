import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process is there and belongs to someone else. Anything else: it is not there.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

const holder = (file: string): number | null => {
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Takes the lock that says a connector is running on a sign-in, or returns
 * null when another running connector holds it. Two connectors on one
 * sign-in would spend each other's refresh tokens, which ends the sign-in.
 * A lock whose process is gone is taken over.
 */
export function holdLock(file: string): { release(): void } | null {
  const mine = String(process.pid);
  for (const attempt of [1, 2]) {
    try {
      writeFileSync(file, mine, { flag: 'wx', mode: 0o600 });
      return {
        release: () => {
          if (existsSync(file) && readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        },
      };
    } catch (error) {
      const exists = typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
      if (!exists) throw error;
      const pid = holder(file);
      if (attempt === 2 || (pid !== null && pid !== process.pid && running(pid))) return null;
      if (pid === process.pid) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
