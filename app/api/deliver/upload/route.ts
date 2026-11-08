/**
 * Accept one exported artifact from the browser and queue it for delivery.
 *
 * Why the browser and not the server: a PPTX or a standalone-HTML ZIP is built
 * entirely in page memory (`lib/video-export-app/build-export-zip.ts` and
 * friends) and never touches server storage, so the only copy is the one the
 * buyer's file picker just received. The MP4 is the exception and does *not*
 * come through here — the render proxy queues it by job id instead, so a closed
 * tab cannot cancel it.
 *
 * The body is the raw bytes, not multipart: `formData()` would buffer a 40 MB
 * ZIP in memory, while a raw body streams straight to the shared volume that the
 * Aliyun Drive sidecar reads. Metadata rides in headers, percent-encoded because
 * a course title is Chinese.
 *
 * Failures answer 4xx/5xx but the client treats this call as best-effort: the
 * file is already saved locally, and a delivery that could not be queued is a
 * missing convenience, not a failed export.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import {
  ensureExportDeliverySchema,
  insertExportDelivery,
} from '@/lib/persistence/export-deliveries';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { capBodyStream } from '@/lib/server/capped-stream';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveDeliverConfig } from '@/lib/server/deliver/config';
import {
  decodedHeader,
  decodedRevision,
  formatFromFileName,
  sanitizeFileName,
} from '@/lib/server/deliver/naming';

const log = createLogger('ExportDeliveryUpload');

/** The largest deliverable this accepts; a full course ZIP stays well under it. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const headerOf = (req: NextRequest) => (name: string) => req.headers.get(name);

export async function POST(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const answer = (response: Response) => {
      responseHeaders.forEach((value, name) => {
        if (name.toLowerCase() !== 'set-cookie') response.headers.append(name, value);
      });
      for (const cookie of responseHeaders.getSetCookie()) {
        response.headers.append('Set-Cookie', cookie);
      }
      return response;
    };

    const config = resolveDeliverConfig();
    if (!config) {
      return answer(apiError('PROVIDER_DISABLED', 501, 'Export delivery is not configured'));
    }

    const requestedName = decodedHeader(headerOf(req), 'x-deliver-filename');
    if (!requestedName) {
      return answer(apiError('INVALID_REQUEST', 400, 'x-deliver-filename is required'));
    }
    const filename = sanitizeFileName(requestedName);
    const format = formatFromFileName(filename);
    if (!format) {
      return answer(
        apiError('INVALID_REQUEST', 400, 'Only mp4/pptx/html/zip artifacts are delivered'),
      );
    }
    if (!req.body) {
      return answer(apiError('INVALID_REQUEST', 400, 'Expected a request body'));
    }

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      return answer(apiError('INTERNAL_ERROR', 503, 'No database configured'));
    }

    const id = crypto.randomUUID();
    const directory = join(config.dataRoot, id);
    const localPath = join(directory, filename);
    const capped = capBodyStream(req.body, MAX_UPLOAD_BYTES);

    let bytes = 0;
    try {
      await mkdir(directory, { recursive: true });
      const body = Readable.fromWeb(capped.stream as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
      });
      await streamPipeline(body, createWriteStream(localPath));
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      if (capped.exceeded()) {
        return answer(apiError('INVALID_REQUEST', 413, 'Artifact is too large'));
      }
      log.error('Failed to store the uploaded artifact:', error);
      return answer(apiError('INTERNAL_ERROR', 500, 'Could not store the artifact'));
    }

    if (bytes === 0) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return answer(apiError('INVALID_REQUEST', 400, 'Artifact is empty'));
    }

    try {
      const { pool } = await getServerPersistenceProvider(connectionString);
      const queryable = pool as unknown as Parameters<typeof ensureExportDeliverySchema>[0];
      await ensureExportDeliverySchema(queryable);
      await insertExportDelivery(queryable, {
        id,
        ownerId,
        courseTitle: decodedHeader(headerOf(req), 'x-deliver-title'),
        format,
        filename,
        localPath,
        bytes,
        revision: decodedRevision(headerOf(req)),
      });
    } catch (error) {
      // The worker cannot pick up a row that was never written, so the bytes are
      // dead weight the moment the insert fails.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      log.error('Could not queue the delivery:', error);
      return answer(apiError('INTERNAL_ERROR', 503, 'Could not queue the delivery'));
    }

    log.info(`Queued ${format} artifact ${filename} (${bytes} bytes) as ${id}`);
    return answer(apiSuccess({ id }, 202));
  });
}
