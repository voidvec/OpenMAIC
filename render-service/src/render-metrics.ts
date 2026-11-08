/**
 * Append-only render timing ledger.
 *
 * `events.ts` writes one line per lifecycle transition to stdout, which answers
 * "did this render succeed and how long did it take" for as long as the
 * container log pipeline keeps it. That is not enough for the one question a
 * deployment actually gets asked — *how long does an MP4 export take on this
 * machine, and did the last change make it faster?* Container logs are rotated,
 * a `--force-recreate` starts a fresh stream, and `JobStore` is in memory, so
 * every comparison across configuration changes loses its baseline.
 *
 * This sink keeps one JSON line per finished render in a file instead: it
 * survives restarts, it can be diffed before/after an env change, and `jq` or a
 * spreadsheet can average it. Each record carries the configuration that
 * produced it (`resourceProfile`, chunk settings) because a duration without
 * its configuration cannot be compared to anything.
 *
 * Deliberately not a database and not a metrics endpoint: one append, no
 * reads, no query engine. A write failure is logged once and never allowed to
 * affect a render — timing telemetry must not be able to fail a job.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { emitRenderEvent, type RenderEvent, type RenderEventSink } from './events.js';

/** One finished render, flattened for aggregation. */
export interface RenderMetricsRecord {
  timestamp: string;
  jobId?: string;
  outcome: string;
  /** Submission → finish, including queue wait. This is the export's wall time. */
  durationMs: number;
  queueWaitMs?: number;
  /** Slot granted → finish; the render itself. */
  renderMs?: number;
  planMs?: number;
  chunksMs?: number;
  assembleMs?: number;
  totalFrames?: number;
  errorCode?: string;
  /** Configuration snapshot, so two runs can be compared like for like. */
  resourceProfile: string;
  chunkExecution: boolean;
  chunkCount: number;
  maxParallelChunks: number;
}

function toRecord(event: RenderEvent): RenderMetricsRecord {
  return {
    timestamp: new Date().toISOString(),
    ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
    outcome: event.outcome ?? 'unknown',
    durationMs: event.durationMs ?? 0,
    ...(event.queueWaitMs === undefined ? {} : { queueWaitMs: event.queueWaitMs }),
    ...(event.renderMs === undefined ? {} : { renderMs: event.renderMs }),
    ...(event.planMs === undefined ? {} : { planMs: event.planMs }),
    ...(event.chunksMs === undefined ? {} : { chunksMs: event.chunksMs }),
    ...(event.assembleMs === undefined ? {} : { assembleMs: event.assembleMs }),
    ...(event.totalFrames === undefined ? {} : { totalFrames: event.totalFrames }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    resourceProfile: config.resourceProfile.name,
    chunkExecution: config.chunkExecutionEnabled,
    chunkCount: config.chunkCount,
    maxParallelChunks: config.maxParallelChunks,
  };
}

/**
 * Append one finished-render record. Never throws: a full disk or a read-only
 * mount degrades to "no ledger", not "no render".
 */
export function appendRenderMetrics(event: RenderEvent, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(toRecord(event))}\n`, 'utf8');
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        service: 'render-service',
        component: 'metrics',
        message: 'failed to append render metrics',
        path,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Default sink: the stdout event line plus the durable ledger.
 *
 * `metricsPath` is resolved at call time (not import time) so tests can point
 * it at a scratch file without rebuilding the module graph.
 */
export function createRenderEventSink(
  metricsPath: string | null = config.metricsPath,
  emit: RenderEventSink = emitRenderEvent,
): RenderEventSink {
  return (event) => {
    emit(event);
    if (metricsPath && event.event === 'render_job_finished') {
      appendRenderMetrics(event, metricsPath);
    }
  };
}
