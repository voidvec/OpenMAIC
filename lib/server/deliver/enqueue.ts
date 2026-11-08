/**
 * Queue an MP4 render for delivery at submit time.
 *
 * This is the half of the pipeline that needs nothing from the browser after the
 * click. The render proxy knows the `jobId` the moment the service accepts the
 * job, so recording it here means the delivery survives the page: the worker
 * polls the render service, downloads the result container-to-container, uploads
 * it, and shares it. Closing the tab, losing the network, or even restarting the
 * app no longer cancels anything.
 *
 * It is fire-and-forget. The submit already succeeded and its response must not
 * be delayed or failed by a delivery bookkeeping problem — a missing row costs
 * one upload, a 500 here would cost the whole export.
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/logger';

import { resolveDeliverConfig } from './config';
import { sanitizeCourseTitle, sanitizeFileName } from './naming';

const log = createLogger('ExportDeliveryEnqueue');

export interface VideoDeliveryInput {
  ownerId: string;
  jobId: string;
  courseTitle: string | null;
  /** The name the browser saved the file as; defaults to the job id. */
  filename: string | null;
  /** Which round of the course this render belongs to; defaults to 1. */
  revision?: number;
}

/**
 * Insert the delivery row, or return null when delivery is off or the row
 * already exists (a client retrying a submit it never saw the answer to).
 */
export async function enqueueVideoDelivery(input: VideoDeliveryInput): Promise<string | null> {
  const config = resolveDeliverConfig();
  if (!config) return null;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;

  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { ensureExportDeliverySchema, findDeliveryByRenderJob, insertExportDelivery } =
    await import('@/lib/persistence/export-deliveries');

  const { pool } = await getServerPersistenceProvider(connectionString);
  const queryable = pool as unknown as Parameters<typeof ensureExportDeliverySchema>[0];
  await ensureExportDeliverySchema(queryable);

  const existing = await findDeliveryByRenderJob(queryable, input.jobId);
  if (existing) return existing.id;

  const title = sanitizeCourseTitle(input.courseTitle);
  const id = randomUUID();
  await insertExportDelivery(queryable, {
    id,
    ownerId: input.ownerId,
    courseTitle: input.courseTitle ? title : null,
    format: 'mp4',
    filename: sanitizeFileName(input.filename ?? `${title}.mp4`),
    renderJobId: input.jobId,
    revision: input.revision ?? 1,
  });
  log.info(`Queued render job ${input.jobId} for delivery as ${id}`);
  return id;
}

/** Fire-and-forget wrapper: never throws, never blocks the caller. */
export function queueVideoDelivery(input: VideoDeliveryInput): void {
  void enqueueVideoDelivery(input).catch((error: unknown) => {
    log.warn(`Could not queue render job ${input.jobId} for delivery.`, error);
  });
}
