/**
 * The background pass that turns queued deliveries into cloud links.
 *
 * Started once per server process from `instrumentation.ts`, on the same
 * reasoning as the asset collector: a route module may be instantiated more than
 * once and gets no shutdown hook, so a timer started there is really one timer
 * per instantiation.
 *
 * The pass is a plain poll rather than an in-process event bus, because the rows
 * are written by short-lived requests while the work outlives them — including,
 * for an MP4, the entire render. Polling also means a container restart resumes
 * everything that was in flight, which no in-memory queue could.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { Pool } from 'pg';

import { createLogger } from '@/lib/logger';
import {
  claimNextExportDelivery,
  ensureExportDeliverySchema,
} from '@/lib/persistence/export-deliveries';

import { type DeliverConfig, resolveDeliverConfig } from './config';
import { runExportDelivery } from './pipeline';

const log = createLogger('ExportDeliveryWorker');

/**
 * Rows handled per pass. A delivery can take minutes (an upload), so this is a
 * fairness bound rather than a throughput one: it keeps one pass from blocking
 * the timer for an unbounded time.
 */
const MAX_PER_PASS = 3;

export interface ExportDeliveryWorker {
  /** Stop the timer and release the pool. */
  stop(): Promise<void>;
  /** Run one pass now, awaiting it. Exposed for tests and manual kicks. */
  runOnce(): Promise<number>;
  intervalMs: number;
}

export interface ExportDeliveryWorkerDeps {
  /** Overridden by tests; production opens its own small pool. */
  poolFactory?: (connectionString: string) => Pool;
  /** Overridden by tests. */
  config?: DeliverConfig;
}

const WORKER_KEY = Symbol.for('openmaic.deliver.worker');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: ExportDeliveryWorker | undefined;
};

export function startExportDeliveryWorker(
  deps: ExportDeliveryWorkerDeps = {},
): ExportDeliveryWorker | undefined {
  // Dev-time module reloads keep `globalThis`; keying there leaves one timer.
  const existing = globalState[WORKER_KEY];
  if (existing) return existing;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return undefined;

  const config = deps.config ?? resolveDeliverConfig();
  if (!config) return undefined;

  const pool = (deps.poolFactory ?? ((value) => new Pool({ connectionString: value, max: 2 })))(
    connectionString,
  );
  const queryable = pool as unknown as Queryable;

  // PostgreSQL may still be starting (the Compose stack has no `depends_on` for
  // it), so the schema is created inside the pass, where a failure is logged and
  // retried rather than escaping into server startup.
  let schemaReady: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => (schemaReady ??= ensureExportDeliverySchema(queryable));

  let passing = false;

  const runOnce = async (): Promise<number> => {
    if (passing) return 0;
    passing = true;
    try {
      await ensureSchema();
      let handled = 0;
      while (handled < MAX_PER_PASS) {
        const delivery = await claimNextExportDelivery(queryable);
        if (!delivery) break;
        await runExportDelivery({ config, queryable }, delivery);
        handled += 1;
      }
      return handled;
    } catch (error) {
      // A broken pass mutates nothing that the next one cannot retry from.
      log.error('Delivery pass failed; will retry on the next tick.', error);
      schemaReady = undefined;
      return 0;
    } finally {
      passing = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, config.pollIntervalMs);
  // Never hold the process open for a poller.
  timer.unref?.();

  const worker: ExportDeliveryWorker = {
    intervalMs: config.pollIntervalMs,
    runOnce,
    stop: async () => {
      clearInterval(timer);
      await pool.end().catch(() => undefined);
      globalState[WORKER_KEY] = undefined;
    },
  };

  globalState[WORKER_KEY] = worker;
  log.info(`Export delivery worker started (every ${config.pollIntervalMs}ms)`);
  return worker;
}
