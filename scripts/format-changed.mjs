#!/usr/bin/env node
// Prettier gate over "changed files only": uncommitted changes (staged +
// unstaged + untracked) union diff against the merge-base with origin/main.
// Falls back to checking every tracked file when the set is empty (e.g. a
// push to main), so the gate never silently passes an empty diff.
// Prettier runs through its API (no child process) so Windows needs no
// .cmd-shim handling.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const check = process.argv.includes('--check');
const exts = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|css|html)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot });
}

const files = new Set();
// -uall: list every untracked file individually (default collapses new dirs
// to `dir/`, which would hide brand-new source trees from the gate).
for (const line of git(['status', '--porcelain', '-uall']).split('\n')) {
  if (!line.trim()) continue;
  const f = line.slice(3).trim().replace(/^"|"$/g, '');
  files.add(f);
}
let base = null;
try {
  base = git(['merge-base', 'HEAD', 'origin/main']).trim();
} catch {
  try {
    base = git(['rev-parse', 'HEAD~1']).trim();
  } catch {
    base = null;
  }
}
if (base) {
  for (const f of git(['diff', '--name-only', base, 'HEAD']).split('\n')) {
    if (f.trim()) files.add(f.trim());
  }
}
const targets = [...files]
  .filter((f) => exts.test(f) && !f.startsWith('data/') && existsSync(path.join(repoRoot, f)))
  .sort();

const { format, resolveConfig } = await import('prettier');
let failed = false;
if (targets.length === 0) {
  console.log('format:changed — no changed files');
} else {
  for (const file of targets) {
    const abs = path.join(repoRoot, file);
    const source = readFileSync(abs, 'utf8');
    const config = await resolveConfig(abs, { editorconfig: false });
    let formatted;
    try {
      formatted = await format(source, { ...config, filepath: abs });
    } catch (err) {
      console.warn(`[error] ${file}: ${err.message.split('\n')[0]}`);
      failed = true;
      continue;
    }
    if (formatted !== source) {
      if (check) {
        console.warn(`[warn] ${file}`);
        failed = true;
      } else {
        writeFileSync(abs, formatted);
        console.log(`[formatted] ${file}`);
      }
    }
  }
  if (check && failed) console.warn('Code style issues found — run `npm run format`.');
}
process.exitCode = failed ? 1 : 0;
