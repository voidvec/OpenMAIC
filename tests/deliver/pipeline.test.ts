/**
 * The delivery pass, driven through its real sequence with the outside world
 * stubbed: the render service, the Aliyun Drive sidecar, Feishu, and the ledger.
 *
 * What matters here is the order and the resumability, which is why the
 * assertions are about which step ran, not about formatting:
 *
 * - a render still running must defer without spending an attempt,
 * - a browser-uploaded artifact must never ask the render service anything,
 * - an already-uploaded artifact must not be uploaded again,
 * - a cancelled render must settle silently instead of paging the seller.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExportDelivery } from '@/lib/persistence/export-deliveries';
import type { DeliverConfig } from '@/lib/server/deliver/config';

const ledger = {
  completeExportDelivery: vi.fn(async (..._args: unknown[]) => undefined),
  deferExportDelivery: vi.fn(async (..._args: unknown[]) => undefined),
  failExportDelivery: vi.fn(async (..._args: unknown[]) => undefined),
  findReusableShare: vi.fn(
    async (..._args: unknown[]): Promise<{ url: string; pwd: string | null } | null> => null,
  ),
  markExportDeliveryCollected: vi.fn(async (..._args: unknown[]) => undefined),
  markExportDeliveryUploaded: vi.fn(async (..._args: unknown[]) => undefined),
  recordExportDeliveryFailure: vi.fn(
    async (..._args: unknown[]): Promise<{ attempts: number; status: 'pending' | 'failed' }> => ({
      attempts: 1,
      status: 'pending',
    }),
  ),
};

type UploadResult =
  | { ok: true; value: { remotePath: string; output: string } }
  | { ok: false; reason: string };
type ShareResult =
  | { ok: true; value: { url: string; pwd: string | null; output: string } }
  | { ok: false; reason: string };

const sidecar = {
  uploadToCloud: vi.fn(
    async (..._args: unknown[]): Promise<UploadResult> => ({
      ok: true,
      value: { remotePath: '/课件/X/a.pptx', output: '' },
    }),
  ),
  shareCloudPath: vi.fn(
    async (..._args: unknown[]): Promise<ShareResult> => ({
      ok: true,
      value: { url: 'https://www.alipan.com/s/abc', pwd: 'zzzz', output: '' },
    }),
  ),
};

const feishu = {
  notifyDelivered: vi.fn(async (..._args: unknown[]) => undefined),
  notifyDeliveryFailed: vi.fn(async (..._args: unknown[]) => undefined),
};

const proxyFetch = vi.fn();

vi.mock('@/lib/persistence/export-deliveries', () => ledger);
vi.mock('@/lib/server/deliver/sidecar', () => sidecar);
vi.mock('@/lib/server/deliver/feishu', () => feishu);
vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args),
}));
vi.mock('@/lib/server/render-service', () => ({
  resolveRenderServiceUrl: () => ({ url: 'http://render-service:9000' }),
  renderServiceOwnerHeaders: (ownerId: string) => ({ 'x-openmaic-render-owner': ownerId }),
  isRenderOwnerBoundResponse: (response: Response) =>
    response.headers.get('x-openmaic-render-owner-bound') === '1',
}));

const config: DeliverConfig = {
  sidecarUrl: 'http://sidecar',
  sidecarToken: 't',
  dataRoot: '',
  cloudRoot: '/课件',
  feishuWebhookUrl: 'https://hook',
  feishuWebhookSecret: null,
  pollIntervalMs: 5000,
  renderPollMs: 20000,
  maxAttempts: 4,
  retryDelayMs: 60000,
};

function delivery(overrides: Partial<ExportDelivery> = {}): ExportDelivery {
  return {
    id: 'd1',
    ownerId: 'owner-1',
    courseTitle: '第一课',
    format: 'pptx',
    filename: '第一课.pptx',
    renderJobId: null,
    localPath: '/data/d1/第一课.pptx',
    remotePath: null,
    shareUrl: null,
    sharePwd: null,
    bytes: 1024,
    status: 'pending',
    detail: null,
    attempts: 0,
    revision: 1,
    createdAtMs: Date.now() - 60_000,
    ...overrides,
  };
}

function ownerBoundJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'x-openmaic-render-owner-bound': '1', 'content-type': 'application/json' },
  });
}

async function run(target: ExportDelivery) {
  const { runExportDelivery } = await import('@/lib/server/deliver/pipeline');
  return runExportDelivery({ config, queryable: {} as never }, target);
}

beforeEach(async () => {
  vi.clearAllMocks();
  config.dataRoot = await mkdtemp(join(tmpdir(), 'deliver-'));
});

describe('runExportDelivery', () => {
  it('uploads a browser-uploaded artifact, shares the course folder, and notifies', async () => {
    // The local file has to exist: the pipeline stats it before uploading.
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));

    const outcome = await run(delivery({ localPath }));
    expect(outcome).toBe('done');

    expect(proxyFetch).not.toHaveBeenCalled();
    // Uploads land in the round's own folder; the share stays on the course
    // folder so the link the customer already has keeps working.
    expect(sidecar.uploadToCloud).toHaveBeenCalledWith(config, localPath, '/课件/第一课/v1');
    expect(sidecar.shareCloudPath).toHaveBeenCalledWith(config, '/课件/第一课');
    expect(ledger.completeExportDelivery).toHaveBeenCalledWith({} as never, 'd1', {
      remotePath: '/课件/X/a.pptx',
      shareUrl: 'https://www.alipan.com/s/abc',
      sharePwd: 'zzzz',
    });
    expect(feishu.notifyDelivered).toHaveBeenCalledTimes(1);
  });

  // Every delivery writes its bytes to its own directory under the data root,
  // and nothing used to remove them: a week of testing left 700 MB of files the
  // cloud already had. Only a delivery that is not `done` can still need one.
  it('reclaims the local artifact once the cloud has it', async () => {
    const directory = join(config.dataRoot, 'd1');
    await mkdir(directory, { recursive: true });
    const localPath = join(directory, '第一课.pptx');
    await writeFile(localPath, 'x');

    const outcome = await run(delivery({ localPath }));

    expect(outcome).toBe('done');
    await expect(stat(directory)).rejects.toThrow();
  });

  // Reclaiming leaves `local_path` pointing at nothing. That path is a shortcut,
  // not a promise: a row that comes back through the pipeline (a reset status, a
  // manual retry) can still be rebuilt from its render job, so a missing file
  // must fall through to that job instead of being treated as fatal.
  it('re-downloads a reclaimed artifact when the record still has a render job', async () => {
    proxyFetch
      .mockResolvedValueOnce(ownerBoundJson({ status: 'succeeded' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 9])));

    const outcome = await run(
      delivery({
        format: 'mp4',
        filename: '第一课.mp4',
        localPath: join(config.dataRoot, 'd1', '第一课.mp4'),
        renderJobId: 'job-1',
      }),
    );

    expect(outcome).toBe('done');
    // Asked the render service for the status and then the bytes.
    expect(proxyFetch).toHaveBeenCalledTimes(2);
    expect(sidecar.uploadToCloud).toHaveBeenCalledTimes(1);
  });

  it('defers a render that is still running, without spending an attempt', async () => {
    proxyFetch.mockResolvedValueOnce(ownerBoundJson({ status: 'running', progress: 40 }));

    const outcome = await run(
      delivery({ format: 'mp4', filename: '第一课.mp4', localPath: null, renderJobId: 'job-1' }),
    );

    expect(outcome).toBe('deferred');
    expect(ledger.deferExportDelivery).toHaveBeenCalledWith({} as never, 'd1', 20000);
    expect(ledger.recordExportDeliveryFailure).not.toHaveBeenCalled();
    expect(sidecar.uploadToCloud).not.toHaveBeenCalled();
  });

  it('downloads a finished render, then uploads and shares it', async () => {
    proxyFetch
      .mockResolvedValueOnce(ownerBoundJson({ status: 'succeeded' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));

    const outcome = await run(
      delivery({ format: 'mp4', filename: '第一课.mp4', localPath: null, renderJobId: 'job-1' }),
    );

    expect(outcome).toBe('done');
    // Fetched the job status, then its output — never the browser's copy.
    expect(proxyFetch).toHaveBeenCalledTimes(2);
    const collected = ledger.markExportDeliveryCollected.mock.calls[0] as unknown as [
      unknown,
      string,
      { localPath: string; bytes: number },
    ];
    expect(collected[2].bytes).toBe(4);
    // Downloaded into the delivery's own directory, then reclaimed after upload.
    await expect(readFile(collected[2].localPath)).rejects.toThrow();
    expect(sidecar.uploadToCloud).toHaveBeenCalledTimes(1);
  });

  it('does not upload again when a previous pass already did', async () => {
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));

    const outcome = await run(delivery({ localPath, remotePath: '/课件/第一课/第一课.pptx' }));

    expect(outcome).toBe('done');
    expect(sidecar.uploadToCloud).not.toHaveBeenCalled();
    expect(sidecar.shareCloudPath).toHaveBeenCalledTimes(1);
  });

  it('reuses the link an earlier artifact of the same course already got', async () => {
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));
    ledger.findReusableShare.mockResolvedValueOnce({
      url: 'https://www.alipan.com/s/course',
      pwd: 'aaaa',
    });

    const outcome = await run(delivery({ localPath }));

    expect(outcome).toBe('done');
    expect(ledger.findReusableShare).toHaveBeenCalledWith({} as never, 'owner-1', '第一课', 'd1');
    // One link per course: the MP4 that follows the PPTX must not mint a second.
    expect(sidecar.shareCloudPath).not.toHaveBeenCalled();
    expect(ledger.completeExportDelivery).toHaveBeenCalledWith({} as never, 'd1', {
      remotePath: '/课件/X/a.pptx',
      shareUrl: 'https://www.alipan.com/s/course',
      sharePwd: 'aaaa',
    });
    expect(feishu.notifyDelivered).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ shareUrl: 'https://www.alipan.com/s/course' }),
    );
  });

  it('falls back to sharing the file when the folder cannot be shared', async () => {
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));
    sidecar.shareCloudPath
      .mockResolvedValueOnce({ ok: false, reason: 'folder unsupported' })
      .mockResolvedValueOnce({
        ok: true,
        value: { url: 'https://www.alipan.com/s/file', pwd: null, output: '' },
      });

    const outcome = await run(delivery({ localPath }));

    expect(outcome).toBe('done');
    expect(sidecar.shareCloudPath).toHaveBeenLastCalledWith(config, '/课件/X/a.pptx');
    expect(feishu.notifyDelivered).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ sharePwd: null, shareUrl: 'https://www.alipan.com/s/file' }),
    );
  });

  it('counts a failed upload as an attempt and retries later', async () => {
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));
    sidecar.uploadToCloud.mockResolvedValueOnce({ ok: false, reason: 'upload timed out' });

    const outcome = await run(delivery({ localPath }));

    expect(outcome).toBe('deferred');
    expect(ledger.recordExportDeliveryFailure).toHaveBeenCalledWith(
      {} as never,
      'd1',
      expect.stringContaining('upload timed out'),
      4,
      60000,
    );
    expect(feishu.notifyDelivered).not.toHaveBeenCalled();
  });

  it('pages the seller once the last attempt fails', async () => {
    const localPath = join(config.dataRoot, '第一课.pptx');
    await import('node:fs/promises').then((fs) => fs.writeFile(localPath, 'x'));
    sidecar.uploadToCloud.mockResolvedValueOnce({ ok: false, reason: 'still failing' });
    ledger.recordExportDeliveryFailure.mockResolvedValueOnce({
      attempts: 4,
      status: 'failed' as const,
    });

    const outcome = await run(delivery({ localPath }));

    expect(outcome).toBe('failed');
    expect(feishu.notifyDeliveryFailed).toHaveBeenCalledTimes(1);
  });

  it('settles a cancelled render silently', async () => {
    proxyFetch.mockResolvedValueOnce(ownerBoundJson({ status: 'cancelled' }));

    const outcome = await run(
      delivery({ format: 'mp4', filename: '第一课.mp4', localPath: null, renderJobId: 'job-1' }),
    );

    expect(outcome).toBe('failed');
    expect(ledger.failExportDelivery).toHaveBeenCalledTimes(1);
    expect(feishu.notifyDeliveryFailed).not.toHaveBeenCalled();
  });
});
