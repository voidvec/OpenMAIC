/**
 * The Aliyun Drive sidecar client.
 *
 * The sidecar is a separate container holding the `aliyunpan` CLI and the
 * scanned-in login token, so this module only speaks JSON to it: `POST /upload`
 * and `POST /share`. It deliberately keeps no state — retries, ordering and
 * bookkeeping live in the delivery ledger, which survives a sidecar restart.
 *
 * The upload budget is generous because a real course video is ~116 MB and the
 * consumer upload endpoints are the slow part; the sidecar's own CLI timeout is
 * the same order of magnitude. A timeout here is reported as a retryable
 * failure, not a definitive one.
 */
import type { DeliverConfig } from './config';

/** Upload of a large MP4 over a consumer link; matches the sidecar's own budget. */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const SHARE_TIMEOUT_MS = 3 * 60 * 1000;

export type SidecarResult<T> = { ok: true; value: T } | { ok: false; reason: string };

interface RawAnswer {
  ok?: unknown;
  reason?: unknown;
  error?: unknown;
  output?: unknown;
  remotePath?: unknown;
  url?: unknown;
  pwd?: unknown;
}

/** The conclusion lines only; the sidecar already drops the progress spam. */
function tail(answer: RawAnswer, limit = 400): string {
  const output = typeof answer.output === 'string' ? answer.output : '';
  const reason = typeof answer.reason === 'string' ? answer.reason : '';
  const error = typeof answer.error === 'string' ? answer.error : '';
  const detail = [reason, error, output].filter(Boolean).join(' | ');
  return detail.length > limit ? detail.slice(-limit) : detail;
}

async function call(
  config: DeliverConfig,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<RawAnswer> {
  const response = await fetch(`${config.sidecarUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deliver-token': config.sidecarToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const answer = (await response.json().catch(() => ({}))) as RawAnswer;
  if (!response.ok && answer.ok !== false) {
    return { ok: false, error: `sidecar HTTP ${response.status}`, output: tail(answer) };
  }
  return answer;
}

/** Push one local file into a cloud folder, creating the folder if needed. */
export async function uploadToCloud(
  config: DeliverConfig,
  localPath: string,
  cloudDir: string,
): Promise<SidecarResult<{ remotePath: string; output: string }>> {
  const answer = await call(config, '/upload', { localPath, cloudDir }, UPLOAD_TIMEOUT_MS);
  if (answer.ok !== true) return { ok: false, reason: tail(answer) || 'upload failed' };
  const remotePath = typeof answer.remotePath === 'string' ? answer.remotePath : '';
  if (!remotePath) return { ok: false, reason: 'sidecar reported success without a remote path' };
  return { ok: true, value: { remotePath, output: tail(answer) } };
}

/**
 * Create a private, non-expiring share for a cloud path.
 *
 * Mode 3 (快传) is refused by the sidecar: its semantics are one-recipient, so a
 * link stops working after the first buyer saves it. That is the opposite of
 * what a shop listing needs.
 */
export async function shareCloudPath(
  config: DeliverConfig,
  cloudPath: string,
): Promise<SidecarResult<{ url: string; pwd: string | null; output: string }>> {
  const answer = await call(config, '/share', { cloudPath, mode: 1, expire: 0 }, SHARE_TIMEOUT_MS);
  if (answer.ok !== true) return { ok: false, reason: tail(answer) || 'share failed' };
  const url = typeof answer.url === 'string' ? answer.url : '';
  if (!url) return { ok: false, reason: 'sidecar reported success without a share URL' };
  const pwd = typeof answer.pwd === 'string' && answer.pwd ? answer.pwd : null;
  return { ok: true, value: { url, pwd, output: tail(answer) } };
}
