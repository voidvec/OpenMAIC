/**
 * The ledger exists to answer one question across configuration changes: how
 * long did an MP4 export take, and did the last change help? These tests pin
 * the two properties that make it usable — one record per finished render, and
 * a record that cannot fail the render.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderEvent } from '../src/events.js';
import { appendRenderMetrics, createRenderEventSink } from '../src/render-metrics.js';

const scratch: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'render-metrics-'));
  scratch.push(dir);
  return dir;
}

describe('render metrics ledger', () => {
  it('appends one comparable record per finished render and passes every event through', async () => {
    const path = join(await tempDir(), 'nested', 'metrics.jsonl');
    const seen: RenderEvent[] = [];
    const sink = createRenderEventSink(path, (event) => seen.push(event));

    sink({ event: 'render_job_submitted', jobId: 'job-1', queued: 0, running: 0 });
    sink({
      event: 'render_job_started',
      jobId: 'job-1',
      queueWaitMs: 20,
      queued: 0,
      running: 1,
    });
    sink({
      event: 'render_job_finished',
      jobId: 'job-1',
      outcome: 'succeeded',
      durationMs: 812_000,
      queueWaitMs: 20,
      renderMs: 811_980,
      planMs: 900,
      chunksMs: 795_000,
      assembleMs: 16_080,
      totalFrames: 24_300,
    });

    // Both halves of the sink fire: the operational log keeps everything, the
    // ledger keeps only terminal timings.
    expect(seen.map((event) => event.event)).toEqual([
      'render_job_submitted',
      'render_job_started',
      'render_job_finished',
    ]);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      jobId: 'job-1',
      outcome: 'succeeded',
      durationMs: 812_000,
      queueWaitMs: 20,
      renderMs: 811_980,
      planMs: 900,
      chunksMs: 795_000,
      assembleMs: 16_080,
      totalFrames: 24_300,
      // The configuration is part of the record: a duration without it cannot
      // be compared to the run before the change.
      resourceProfile: expect.any(String),
      chunkExecution: expect.any(Boolean),
      chunkCount: expect.any(Number),
      maxParallelChunks: expect.any(Number),
    });
    expect(typeof JSON.parse(lines[0]!).timestamp).toBe('string');
  });

  it('records failures without a breakdown', async () => {
    const path = join(await tempDir(), 'metrics.jsonl');
    createRenderEventSink(path, () => {})({
      event: 'render_job_finished',
      jobId: 'job-2',
      outcome: 'failed',
      durationMs: 5_000,
      errorCode: 'execution_failed',
    });

    const record = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(record).toMatchObject({
      jobId: 'job-2',
      outcome: 'failed',
      durationMs: 5_000,
      errorCode: 'execution_failed',
    });
    expect(record).not.toHaveProperty('planMs');
    expect(record).not.toHaveProperty('chunksMs');
  });

  it('never lets a write failure reach the render', async () => {
    const dir = await tempDir();
    // A regular file where a directory is expected: mkdir fails with ENOTDIR.
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    expect(() =>
      appendRenderMetrics(
        { event: 'render_job_finished', jobId: 'job-3', outcome: 'succeeded', durationMs: 1 },
        join(blocker, 'metrics.jsonl'),
      ),
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ level: 'WARN', component: 'metrics' });
  });
});
