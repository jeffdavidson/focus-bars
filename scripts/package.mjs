// Build the Chrome Web Store upload: dist/focus-bars-<version>.zip with the
// extension folder's contents at the zip root (no tests, docs or dotfiles).
// Usage: node scripts/package.mjs [outDir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) {
  console.error(`Version mismatch: package.json ${pkg.version} vs manifest ${manifest.version}`);
  process.exit(1);
}

const outDir = resolve(process.argv[2] ?? join(root, 'dist'));
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `focus-bars-${manifest.version}.zip`);
rmSync(zip, { force: true });
// -X: no extra macOS file attributes; exclude hidden files such as .DS_Store
execFileSync('zip', ['-r', '-X', '-q', zip, '.', '-x', '.*', '*/.*'], { cwd: join(root, 'extension') });
console.log(zip);
