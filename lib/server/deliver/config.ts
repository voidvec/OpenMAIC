/**
 * Configuration for the export delivery pipeline.
 *
 * The pipeline is a local-deployment capability, not an upstream one: it drives
 * the Aliyun Drive sidecar and a Feishu group bot. It is therefore **off unless
 * asked for**, so an upstream deployment that never sets these variables behaves
 * exactly as before — no table, no worker, no outbound calls.
 *
 * Everything is read from the environment rather than `openmaic.yml` on purpose:
 * the yml schema is strict, and adding a `deliver:` block there would mean
 * touching the upstream schema, its example file and its docs for a feature the
 * upstream does not ship.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportDelivery');

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RENDER_POLL_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 60_000;

export interface DeliverConfig {
  /** Base URL of the Aliyun Drive sidecar (`http://deliver-sidecar:8099`). */
  sidecarUrl: string;
  /** Shared secret the sidecar demands in `x-deliver-token`. */
  sidecarToken: string;
  /**
   * Root the sidecar is allowed to read from. The Next side must write the
   * artifact inside this tree, because the sidecar resolves `localPath` against
   * it and refuses anything else.
   */
  dataRoot: string;
  /** Cloud root folder every course folder is created under. */
  cloudRoot: string;
  /** Feishu custom-bot webhook, or null when notifications are off. */
  feishuWebhookUrl: string | null;
  feishuWebhookSecret: string | null;
  /** How often the worker looks for work. */
  pollIntervalMs: number;
  /** How long to wait before re-checking a render job that is still running. */
  renderPollMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

function trimmed(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function intEnv(name: string, fallback: number, minimum: number): number {
  const raw = trimmed(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    log.warn(`${name}="${raw}" is not a usable number; using ${fallback}.`);
    return fallback;
  }
  return Math.trunc(value);
}

/** `DELIVER_ENABLED`: unset or `0`/`false` keeps the pipeline entirely off. */
export function isDeliveryEnabled(): boolean {
  const raw = trimmed('DELIVER_ENABLED')?.toLowerCase();
  return raw !== undefined && raw !== '0' && raw !== 'false';
}

/**
 * The effective configuration, or null when the pipeline is disabled or
 * incomplete. A missing sidecar URL or token is not fatal: it turns the
 * feature off with one warning, which is the right behaviour for a deployment
 * that simply does not run the sidecar.
 */
export function resolveDeliverConfig(): DeliverConfig | null {
  if (!isDeliveryEnabled()) return null;

  const sidecarUrl = trimmed('DELIVER_SIDECAR_URL')?.replace(/\/+$/, '');
  const sidecarToken = trimmed('DELIVER_SIDECAR_TOKEN');
  if (!sidecarUrl || !sidecarToken) {
    log.warn(
      'DELIVER_ENABLED is set but DELIVER_SIDECAR_URL / DELIVER_SIDECAR_TOKEN are not; ' +
        'export delivery stays off.',
    );
    return null;
  }

  return {
    sidecarUrl,
    sidecarToken,
    dataRoot: trimmed('DELIVER_DATA_ROOT') ?? '/data',
    cloudRoot: trimmed('DELIVER_CLOUD_ROOT') ?? '/课件',
    feishuWebhookUrl: trimmed('FEISHU_WEBHOOK_URL') ?? null,
    feishuWebhookSecret: trimmed('FEISHU_WEBHOOK_SECRET') ?? null,
    pollIntervalMs: intEnv('DELIVER_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 1_000),
    renderPollMs: intEnv('DELIVER_RENDER_POLL_MS', DEFAULT_RENDER_POLL_MS, 5_000),
    maxAttempts: intEnv('DELIVER_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1),
    retryDelayMs: intEnv('DELIVER_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS, 5_000),
  };
}
