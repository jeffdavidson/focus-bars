import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

test('package builds a store zip with the manifest at its root and nothing else', () => {
  const out = mkdtempSync(join(tmpdir(), 'focus-bars-pkg-'));
  try {
    const printed = execFileSync('node', [join(root, 'scripts/package.mjs'), out], { encoding: 'utf8' });
    const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json')));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
    assert.equal(pkg.version, manifest.version, 'package.json and manifest agree');
    const zip = join(out, `focus-bars-${manifest.version}.zip`);
    assert.ok(printed.trim().endsWith(`focus-bars-${manifest.version}.zip`));
    const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.includes('manifest.json'), 'manifest at the zip root');
    for (const f of ['background.js', 'switch.html', 'switch.js', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'lib/controller.js', 'icons/128.png']) {
      assert.ok(entries.includes(f), `${f} included`);
    }
    assert.ok(!entries.some((e) => e.startsWith('tests/') || e.startsWith('docs/') || e.split('/').some((p) => p.startsWith('.'))), 'no tests, docs or dotfiles');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
