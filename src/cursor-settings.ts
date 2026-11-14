import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Plan 48 (Cursor): whether Cursor's own settings on this machine leave the
 * connector a say. With its default approval mode ("allowlist") Cursor asks
 * before a web fetch, a web search or its browser, and the connector refuses;
 * its permissions file in the turn's directory blocks the rest. A person who
 * set Cursor to run tools without asking, or to accept web searches by
 * itself, takes that say away, so Cursor is then not used.
 *
 * Only these two settings are read, here on the machine; nothing of the file
 * is sent anywhere. Null when Cursor may be used; otherwise why not, for the
 * person to read.
 */
export function cursorSettingsRefusal(home: string): string | null {
  const file = join(home, '.cursor', 'cli-config.json');
  if (!existsSync(file)) return null;
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return `Cursor's settings (${file}) could not be read, so CoRoid cannot tell whether Cursor asks before it uses a tool`;
  }
  const record = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  const mode = record.approvalMode;
  if (mode !== undefined && mode !== 'allowlist') {
    return `Cursor is set to approval mode "${String(mode)}", in which it runs some tools without asking. Set it to ask first ("allowlist"), and CoRoid can use it`;
  }
  if (record.autoAcceptWebSearch === true) {
    return 'Cursor is set to accept web searches without asking. Turn that off, and CoRoid can use it';
  }
  return null;
}
