import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * True when `file` exists, resolves through symlinks (so broken symlinks are
 * skipped), is a regular file, and is executable on this platform.
 */
function isExecutableFile(file: string): boolean {
  try {
    const info = statSync(file);
    if (!info.isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  if (/\.(exe|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

function findInDirs(name: string, dirs: readonly string[]): string | null {
  const names = candidateNames(name);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Finds a coding agent's CLI binary cleanly:
 * 1. Checks PATH first. If the first valid match on PATH works and no broken
 *    symlink masks it earlier on PATH, returns the bare command name so PATH
 *    resolution stays standard.
 * 2. If PATH has no working executable (for instance, non-login shells where
 *    `~/.gemini/bin` or `~/.local/bin` is omitted, or a broken symlink on PATH),
 *    checks `fallbackDirs` and returns the full executable path.
 * 3. If not found anywhere, returns the bare command name so spawn reports the
 *    normal ENOENT failure.
 */
export function resolveBinary(
  name: string,
  options: { pathEnv?: string; fallbackDirs?: readonly string[] } = {}
): string {
  if (isAbsolute(name)) return name;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const pathDirs = pathEnv.split(delimiter).filter(Boolean);
  const onPath = findInDirs(name, pathDirs);
  if (onPath) {
    // If an earlier PATH directory has a broken symlink or directory with the
    // same name, returning the exact resolved path avoids spawn hitting it.
    const firstDir = pathDirs[0];
    const firstMatchIndex = pathDirs.findIndex(dir =>
      candidateNames(name).some(candidate => join(dir, candidate) === onPath)
    );
    if (firstMatchIndex === 0 && firstDir) return name;
    // Check if any earlier PATH dir has an unusable entry with the same name.
    const names = candidateNames(name);
    const shadowed = pathDirs.slice(0, firstMatchIndex).some(dir =>
      names.some(candidate => {
        try {
          statSync(join(dir, candidate));
          return true;
        } catch {
          return false;
        }
      })
    );
    return shadowed ? onPath : name;
  }
  return findInDirs(name, options.fallbackDirs ?? []) ?? name;
}
