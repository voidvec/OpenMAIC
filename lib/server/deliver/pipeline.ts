/**
 * One delivery, end to end: make sure the bytes exist locally, push them into
 * the course's cloud folder, share that folder, and tell the seller.
 *
 * Resumability is the whole design. Each step writes its result to the ledger
 * before the next starts, so a pass that dies after the upload does not upload
 * 116 MB again on the retry — it goes straight to sharing.
 *
 * The MP4 path is the reason this runs on the server at all. The browser used to
 * be the only place the finished video existed, which meant closing the tab
 * cancelled the delivery. Here the render service is polled instead: the download
 * goes container-to-container, and the page is irrelevant once it has submitted
 * the job.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import {
  type ExportDelivery,
  completeExportDelivery,
  deferExportDelivery,
  failExportDelivery,
  findReusableShare,
  markExportDeliveryCollected,
  markExportDeliveryUploaded,
  recordExportDeliveryFailure,
} from '@/lib/persistence/export-deliveries';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import {
  isRenderOwnerBoundResponse,
  renderServiceOwnerHeaders,
  resolveRenderServiceUrl,
} from '@/lib/server/render-service';

import type { DeliverConfig } from './config';
import { notifyDelivered, notifyDeliveryFailed } from './feishu';
import { courseFolder, formatLabel, revisionFolder, sanitizeCourseTitle } from './naming';
import { shareCloudPath, uploadToCloud } from './sidecar';

const log = createLogger('ExportDeliveryPipeline');

/** The retry would never succeed: stop and report instead of looping. */
class DefinitiveFailure extends Error {}

/** Worth another pass: a timeout, a 5xx, a share that was temporarily refused. */
class RetryableFailure extends Error {}

/**
 * The user cancelled the render themselves. Settle the row, but stay quiet: a
 * red card for an action the seller just took deliberately is noise.
 */
class CancelledByUser extends Error {}

/** Internal signal: the render job simply is not finished yet. */
class RetryLater extends Error {
  constructor(readonly renderStatus: string) {
    super(`render job is ${renderStatus}`);
  }
}

export type DeliveryOutcome = 'done' | 'deferred' | 'failed';

export interface DeliveryPipelineDeps {
  config: DeliverConfig;
  queryable: Queryable;
}

/** Header budget only — the body of a 116 MB download is not on a timer. */
const STATUS_TIMEOUT_MS = 30_000;
const DOWNLOAD_HEADER_TIMEOUT_MS = 30_000;

interface RenderJobStatus {
  status: string;
  error?: string | null;
  progress?: number;
  elapsedMs?: number;
}

async function readRenderJobStatus(
  baseUrl: string,
  jobId: string,
  ownerId: string,
): Promise<RenderJobStatus> {
  const response = await proxyFetch(`${baseUrl}/owner-bound/render/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: renderServiceOwnerHeaders(ownerId),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!isRenderOwnerBoundResponse(response)) {
    throw new DefinitiveFailure('render service is too old to be queried for this job');
  }
  if (response.status === 404) {
    throw new DefinitiveFailure('渲染任务已不存在（服务重启或超过产物保留期）');
  }
  if (!response.ok) {
    throw new RetryableFailure(`渲染服务返回 HTTP ${response.status}`);
  }
  return (await response.json()) as RenderJobStatus;
}

/**
 * Download the finished MP4 into the shared volume.
 *
 * The path is inside `dataRoot` because the sidecar resolves `localPath` against
 * that root and refuses anything outside it — the two containers share exactly
 * this directory and nothing else.
 */
async function downloadRenderOutput(
  deps: DeliveryPipelineDeps,
  delivery: ExportDelivery,
  baseUrl: string,
): Promise<{ localPath: string; bytes: number }> {
  const jobId = delivery.renderJobId as string;
  const directory = join(deps.config.dataRoot, delivery.id);
  await mkdir(directory, { recursive: true });
  const localPath = join(directory, basename(delivery.filename));

  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), DOWNLOAD_HEADER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await proxyFetch(
      `${baseUrl}/owner-bound/render/${encodeURIComponent(jobId)}/download`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: renderServiceOwnerHeaders(delivery.ownerId),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(headerTimeout);
  }

  // A presigned object-storage artifact store answers with a redirect; fetch it
  // directly rather than asking the render service to relay the bytes.
  if (response.status === 301 || response.status === 302) {
    const location = response.headers.get('location');
    if (!location) throw new DefinitiveFailure('渲染产物重定向丢失了目标地址');
    response = await proxyFetch(location, { method: 'GET' });
  }

  if (response.status === 409) {
    throw new RetryableFailure('渲染产物暂时不可下载（任务尚未收尾）');
  }
  if (!response.ok || !response.body) {
    throw new RetryableFailure(`渲染产物下载失败（HTTP ${response.status}）`);
  }

  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await streamPipeline(body, createWriteStream(localPath));
  const written = await stat(localPath);
  if (written.size === 0) throw new RetryableFailure('渲染产物下载为空文件');

  await markExportDeliveryCollected(deps.queryable, delivery.id, {
    localPath,
    bytes: written.size,
  });
  log.info(`Collected render output ${jobId} (${written.size} bytes) for ${delivery.id}`);
  return { localPath, bytes: written.size };
}

async function ensureLocalArtifact(
  deps: DeliveryPipelineDeps,
  delivery: ExportDelivery,
): Promise<{ localPath: string; bytes: number }> {
  // A recorded path is a shortcut, not a promise. Once the cloud has a delivery
  // its local copy is reclaimed, so a row that comes back through here — a reset
  // status, a manual retry, a rebuild — finds `local_path` pointing at nothing.
  // Falling through to the render job re-downloads the file, which is the whole
  // reason the job id is kept; throwing turned a recoverable case into a dead end.
  if (delivery.localPath) {
    const existing = await stat(delivery.localPath).catch(() => null);
    if (existing) return { localPath: delivery.localPath, bytes: existing.size };
  }
  if (!delivery.renderJobId) {
    // Nothing to fall back on: a browser-uploaded artifact has no render job, so
    // an artifact that was reclaimed after delivery is genuinely gone.
    throw new DefinitiveFailure(
      delivery.localPath
        ? `本地文件已被回收，且该记录没有渲染任务可供重新取回：${delivery.localPath}`
        : '交付记录既无渲染任务也无本地文件',
    );
  }
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) throw new DefinitiveFailure('渲染服务未配置，无法取回成片');

  const job = await readRenderJobStatus(resolved.url, delivery.renderJobId, delivery.ownerId);
  if (job.status === 'queued' || job.status === 'running') {
    throw new RetryLater(job.status);
  }
  if (job.status !== 'succeeded') {
    if (job.status === 'cancelled') throw new CancelledByUser('渲染已取消，未上传');
    throw new DefinitiveFailure(`渲染任务失败${job.error ? `：${job.error}` : ''}`);
  }
  return downloadRenderOutput(deps, delivery, resolved.url);
}

/**
 * Drop the local bytes of a finished delivery.
 *
 * Every delivery gets its own directory under the data root (the upload route
 * writes there; the render path downloads there), and nothing removes it once
 * the cloud has the file. One 120 MB narrated HTML per re-export adds up fast,
 * and the bytes cannot be missed afterwards: the ledger keeps the remote path,
 * and the only thing that still needed the file — a retry — is exactly what
 * `done` rules out.
 */
async function discardCollectedArtifact(config: DeliverConfig, id: string): Promise<void> {
  try {
    await rm(join(config.dataRoot, id), { recursive: true, force: true });
  } catch (error) {
    // Failing to reclaim the space is not failing the delivery.
    log.warn(`Could not remove the local artifact of ${id}`, error);
  }
}

/**
 * The link a customer will be sent: the course folder, shared privately and
 * without an expiry.
 *
 * A course that already has a link keeps it. All artifacts of one course land
 * in the same cloud folder, so reusing the link means one link per course to
 * send rather than one per export, and the buyer who already received the PPTX
 * link sees the MP4 appear in it. Sharing the file instead of the folder is the
 * fallback for a folder that cannot be shared at all.
 */
async function ensureShare(
  deps: DeliveryPipelineDeps,
  delivery: ExportDelivery,
  folder: string,
  remotePath: string,
): Promise<{ url: string; pwd: string | null }> {
  const reused = await findReusableShare(
    deps.queryable,
    delivery.ownerId,
    delivery.courseTitle,
    delivery.id,
  ).catch((error: unknown) => {
    // A ledger read that fails costs a duplicate link, never the delivery.
    log.warn(`Could not look up an existing share for ${folder}; creating a new one.`, error);
    return null;
  });
  if (reused) {
    log.info(`Reusing the existing share link of ${folder} for ${delivery.id}`);
    return reused;
  }

  let shared = await shareCloudPath(deps.config, folder);
  if (!shared.ok) {
    log.warn(`Sharing folder ${folder} failed (${shared.reason}); sharing the file instead.`);
    shared = await shareCloudPath(deps.config, remotePath);
  }
  if (!shared.ok) throw new RetryableFailure(`创建分享链接失败：${shared.reason}`);
  return { url: shared.value.url, pwd: shared.value.pwd };
}

/**
 * Run one pass over a delivery row.
 *
 * `deferred` means "call me again later" and spends no attempt: a render that is
 * still running and a retry backoff are both normal, not failures.
 */
export async function runExportDelivery(
  deps: DeliveryPipelineDeps,
  delivery: ExportDelivery,
): Promise<DeliveryOutcome> {
  const { config, queryable } = deps;
  const title = sanitizeCourseTitle(
    delivery.courseTitle,
    sanitizeCourseTitle(basename(delivery.filename, extname(delivery.filename))),
  );
  // `folder` is what the customer's link points at; `target` is where this
  // round of the course is written. They differ because a second delivery is
  // usually the same course with the requested changes, and overwriting the
  // files the customer already downloaded is not an acceptable way to ship them.
  const folder = courseFolder(config.cloudRoot, title);
  const target = revisionFolder(folder, delivery.revision);

  try {
    const artifact = await ensureLocalArtifact(deps, delivery);

    let remotePath = delivery.remotePath;
    if (!remotePath) {
      const uploaded = await uploadToCloud(config, artifact.localPath, target);
      if (!uploaded.ok) throw new RetryableFailure(`上传失败：${uploaded.reason}`);
      remotePath = uploaded.value.remotePath;
      await markExportDeliveryUploaded(queryable, delivery.id, remotePath);
      log.info(`Uploaded ${remotePath} for ${delivery.id}`);
    }

    // The course folder is the share target, not the file and not the revision
    // folder: one link and one extraction code cover every format and every
    // round of the same course.
    const share = await ensureShare(deps, delivery, folder, remotePath);

    await completeExportDelivery(queryable, delivery.id, {
      remotePath,
      shareUrl: share.url,
      sharePwd: share.pwd,
    });

    await notifyDelivered(config, {
      courseTitle: title,
      formatLabel: formatLabel(delivery.format),
      bytes: artifact.bytes,
      elapsedMs: Math.max(0, Date.now() - delivery.createdAtMs),
      shareUrl: share.url,
      sharePwd: share.pwd,
      cloudDir: target,
    });
    log.info(`Delivered ${delivery.id} -> ${share.url}`);
    // The cloud copy is the one the customer opens, so the local bytes have
    // done their job. Keeping them cost 700 MB in a week of testing — mostly
    // 120 MB narrated HTMLs — and nothing ever reads them again: the ledger
    // holds the remote path, and a retry that still needs the file is by
    // definition not `done` yet.
    await discardCollectedArtifact(config, delivery.id);
    return 'done';
  } catch (error) {
    if (error instanceof RetryLater) {
      await deferExportDelivery(queryable, delivery.id, config.renderPollMs);
      return 'deferred';
    }

    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CancelledByUser) {
      await failExportDelivery(queryable, delivery.id, message);
      log.info(`Delivery ${delivery.id} dropped: ${message}`);
      return 'failed';
    }
    if (error instanceof DefinitiveFailure) {
      await failExportDelivery(queryable, delivery.id, message);
      log.error(`Delivery ${delivery.id} failed permanently: ${message}`);
      await notifyDeliveryFailed(config, {
        courseTitle: title,
        formatLabel: formatLabel(delivery.format),
        filename: delivery.filename,
        detail: message,
      });
      return 'failed';
    }

    const outcome = await recordExportDeliveryFailure(
      queryable,
      delivery.id,
      message,
      config.maxAttempts,
      config.retryDelayMs,
    );
    log.warn(
      `Delivery ${delivery.id} attempt ${outcome.attempts}/${config.maxAttempts} failed: ${message}`,
    );
    if (outcome.status === 'failed') {
      await notifyDeliveryFailed(config, {
        courseTitle: title,
        formatLabel: formatLabel(delivery.format),
        filename: delivery.filename,
        detail: message,
      });
      return 'failed';
    }
    return 'deferred';
  }
}
