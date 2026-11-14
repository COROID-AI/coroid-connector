#!/usr/bin/env node
/**
 * Builds the connector into one file, dist/coroid-connector.mjs: its source
 * and nothing else (the adapters it installs on request are not bundled).
 * The public repository's release builds with this script, and CoRoid's own
 * repository builds the same bytes with it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The connector as one ES module for Node 20 or newer. */
export async function buildConnector() {
  const built = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    write: false,
    legalComments: 'none',
    banner: { js: '#!/usr/bin/env node' },
  });
  return Buffer.from(built.outputFiles[0].contents);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(root, 'dist', 'coroid-connector.mjs');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await buildConnector(), { mode: 0o755 });
  console.info(`Wrote ${file}`);
}
