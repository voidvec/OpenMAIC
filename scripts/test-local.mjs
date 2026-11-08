#!/usr/bin/env node
/**
 * Run the test suite without letting the deployment's model configuration
 * change what the tests see.
 *
 * The server reads `openmaic.yml` from the working directory at startup, and
 * that file is the operator's real deployment configuration. Tests that expect
 * the legacy provider variables therefore fail on a developer machine that has
 * one, and the failures read like regressions even though nothing in the code
 * changed. A blank file is no substitute: the file's presence is what switches
 * slot resolution away from the legacy providers.
 *
 * So the suite runs from a mirror directory that links every top-level
 * directory of the checkout but has no `openmaic.yml` of its own. The
 * repository is never modified, which matters here because a running container
 * bind-mounts that file: moving it out of the tree breaks the mount until the
 * container is recreated.
 *
 * Usage:
 *   npm run test:local                 # whole suite
 *   npm run test:local -- tests/api    # one directory or file
 *   npm run test:local -- -t "some test name"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const deployConfig = path.join(repoRoot, 'openmaic.yml');

if (!fs.existsSync(vitest)) {
  console.error(
    `test:local: cannot find ${path.relative(repoRoot, vitest)} — run the install step first.`,
  );
  process.exit(1);
}

/** Link one directory from the checkout into the mirror. */
function linkDir(target, link) {
  // Windows needs a junction to link a directory without elevation; a plain
  // symlink elsewhere. Both are dir links, so removal must not recurse.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Remove a directory link without touching what it points at. */
function unlinkDir(link) {
  try {
    fs.unlinkSync(link);
  } catch {
    // Windows keeps directory links as reparse points: only rmdir drops the
    // link itself, and it fails on a real directory, which is what we want.
    fs.rmdirSync(link);
  }
}

/**
 * Top-level files the mirror must not expose. `openmaic.yml` is the entire
 * point of the mirror; the two `.env` files carry the operator's real keys and
 * no test may see them (see tests/setup-env.ts).
 */
const MIRROR_SKIP_FILES = new Set(['openmaic.yml', '.env', '.env.local']);

function makeMirror() {
  // Inside the temp directory, not the checkout: a mirror that lives in the
  // tree would show up in git status and in file watchers.
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-test-local-'));
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    const target = path.join(repoRoot, entry.name);
    const link = path.join(mirror, entry.name);
    try {
      if (entry.isDirectory()) {
        linkDir(target, link);
      } else if (!MIRROR_SKIP_FILES.has(entry.name)) {
        // Directories link, files copy. Guard tests resolve paths against the
        // working directory (`eslint.config.mjs`, `instrumentation.ts`,
        // `package.json`), so a mirror holding only directories made them fail
        // with ENOENT while saying nothing about the code. Copying is the only
        // portable option: a file symlink needs a privilege Windows does not
        // grant by default, and a hard link fails across drives, which is
        // exactly where the temp directory usually lives.
        fs.copyFileSync(target, link);
      }
    } catch (error) {
      // A directory another process holds open should not stop the run; the
      // tests that need it will say so.
      console.error(`test:local: could not mirror ${entry.name}: ${error.message}`);
    }
  }
  return mirror;
}

let mirror = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (!mirror) return;
  for (const name of fs.readdirSync(mirror)) {
    try {
      unlinkDir(path.join(mirror, name));
    } catch {
      // Leave whatever cannot be removed; it is a temp directory.
    }
  }
  try {
    fs.rmdirSync(mirror);
  } catch {
    // Same: a leftover temp directory is not worth failing a test run over.
  }
}

const isolate = fs.existsSync(deployConfig) || !!process.env.OPENMAIC_CONFIG?.trim();
if (isolate) {
  mirror = makeMirror();
  console.log(
    `test:local: running from ${mirror} so ./openmaic.yml is not read (the checkout is untouched)`,
  );
}

const args = ['run', '--root', repoRoot, ...process.argv.slice(2)];
const child = spawn(process.execPath, [vitest, ...args], {
  cwd: mirror ?? repoRoot,
  stdio: 'inherit',
  // A configuration named from the environment is the operator's real one too.
  env: (() => {
    const env = { ...process.env };
    delete env.OPENMAIC_CONFIG;
    return env;
  })(),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // The child shares the terminal and usually sees the signal first; the
    // forward covers the case where only this process did.
    child.kill(signal);
    cleanup();
    process.exit(1);
  });
}

// A crash still has to drop the mirror links.
process.on('exit', () => {
  try {
    cleanup();
  } catch {
    // Nothing useful left to do while exiting.
  }
});

child.on('error', (error) => {
  cleanup();
  console.error(`test:local: failed to start vitest: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  cleanup();
  // A killed child has no code; report it as a failure rather than success.
  process.exit(signal ? 1 : (code ?? 1));
});
