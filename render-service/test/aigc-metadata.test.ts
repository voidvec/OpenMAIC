/**
 * The container metadata is the half of the AIGC label a person never sees, so
 * nothing in the picture would reveal its absence. These tests pin the two
 * properties that make it safe to run inside a finished render: the remux keeps
 * the original bytes-intact when it cannot run, and it never leaves a truncated
 * file in the artifact's place.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aigcMetadataStatement, stampAigcMetadata } from '../src/aigc-metadata.js';

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const METADATA = { provider: 'Acme 教育', contentId: 'job-1' };

/**
 * A stand-in for ffmpeg: copies the `-i` input to the last argument (the output
 * path) and records its argv, so the test can check the remux is a stream copy
 * and that the metadata flags are passed.
 */
async function fakeFfmpeg(dir: string): Promise<{ path: string; argvFile: string }> {
  const path = join(dir, 'fake-ffmpeg.mjs');
  const argvFile = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      `#!${process.execPath}`,
      "import { copyFileSync, writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));`,
      "const input = args[args.indexOf('-i') + 1];",
      'copyFileSync(input, args[args.length - 1]);',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, argvFile };
}

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aigc-metadata-'));
  scratch.push(dir);
  return dir;
}

describe('stampAigcMetadata', () => {
  it('remuxes with a stream copy and the two metadata tags', async () => {
    const dir = await scratchDir();
    const filePath = join(dir, 'output.mp4');
    const original = 'not really an mp4, but byte-identical through a copy';
    await writeFile(filePath, original, 'utf8');
    const ffmpeg = await fakeFfmpeg(dir);

    const stamped = await stampAigcMetadata({
      filePath,
      metadata: METADATA,
      ffmpegPath: ffmpeg.path,
    });

    expect(stamped).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    const argv = JSON.parse(await readFile(ffmpeg.argvFile, 'utf8')) as string[];
    // A stream copy: the remux must never re-encode the export.
    expect(argv.slice(argv.indexOf('-c'), argv.indexOf('-c') + 2)).toEqual(['-c', 'copy']);
    const statement = aigcMetadataStatement(METADATA);
    expect(argv).toContain(`comment=${statement}`);
    expect(argv).toContain(`description=${statement}`);
    // The statement carries both identifiers §6.1 asks for.
    expect(statement).toContain(METADATA.provider);
    expect(statement).toContain(METADATA.contentId);
  });

  it('leaves the export untouched when ffmpeg cannot run', async () => {
    const dir = await scratchDir();
    const filePath = join(dir, 'output.mp4');
    await writeFile(filePath, 'original bytes', 'utf8');

    const stamped = await stampAigcMetadata({
      filePath,
      metadata: METADATA,
      ffmpegPath: join(dir, 'no-such-ffmpeg'),
    });

    expect(stamped).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe('original bytes');
    // No half-written temp file is left behind in the artifact directory.
    await expect(stat(`${filePath}.aigc.tmp.mp4`)).rejects.toThrow();
  });

  it('rejects an empty remux instead of replacing the export with it', async () => {
    const dir = await scratchDir();
    const filePath = join(dir, 'output.mp4');
    await writeFile(filePath, 'original bytes', 'utf8');
    // Exits 0 but writes nothing: the case where trusting the exit code alone
    // would delete the artifact.
    const silent = join(dir, 'silent-ffmpeg.mjs');
    await writeFile(silent, `#!${process.execPath}\nprocess.exit(0);\n`, 'utf8');
    await chmod(silent, 0o755);

    const stamped = await stampAigcMetadata({
      filePath,
      metadata: METADATA,
      ffmpegPath: silent,
    });

    expect(stamped).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe('original bytes');
  });
});
