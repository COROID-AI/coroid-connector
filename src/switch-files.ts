import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Writes an agent's switch files into the session's directory before it
 * starts, a file in a directory of its own included (Cursor reads
 * `.cursor/cli.json`, Plan 48).
 */
export function writeSwitchFiles(directory: string, files: Record<string, string> | undefined): void {
  for (const [name, content] of Object.entries(files ?? {})) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
