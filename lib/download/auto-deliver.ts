/**
 * Hand a freshly saved artifact to the delivery queue.
 *
 * Called from the one place every browser-side export funnels through
 * ({@link writeSaveTarget}), so a new export kind is covered without touching
 * this module. Two rules decide what it sends:
 *
 * - Only customer deliverables travel: `pptx`, `html` and `zip`. Subtitles and
 *   scripts are saved just as often but would only clutter the cloud folder.
 * - `mp4` is excluded on purpose. The render proxy already queued it by job id
 *   and the worker fetches it server-to-server; uploading it again from the page
 *   would push 116 MB through the browser for nothing, and would fail outright
 *   if the tab were closed.
 *
 * The call is fire-and-forget by design. The file is already on the user's disk,
 * so a queue that is unreachable (feature off, server restarting) must not turn a
 * successful export into an error dialog. `keepalive` is deliberately not used:
 * it caps the body at 64 KB, which no real artifact fits in.
 */
import { createLogger } from '@/lib/logger';
import { useSettingsStore } from '@/lib/store/settings';

import { currentDeliveryRevision } from './delivery-revision';

const log = createLogger('AutoDeliver');

/** Deliverable extensions. `.htm` is accepted because a saved page may use it. */
const DELIVERABLE = /\.(pptx|html?|zip)$/i;

const ENDPOINT = '/api/deliver/upload';

/**
 * Queue `blob` for cloud delivery. Safe to call for any export; non-deliverables
 * and duplicates are filtered here or by the server.
 *
 * `deliveryTitle` is the course the artifact belongs to, when the file name is
 * not a good enough answer. A delivery pack is named `<course>-course-pack.zip`
 * for the buyer's benefit, but the cloud folder must be the course itself —
 * otherwise a pack and a deck of the same lesson land in two sibling folders.
 */
export function queueArtifactDelivery(filename: string, blob: Blob, deliveryTitle?: string): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  if (!DELIVERABLE.test(filename)) return;
  // The operator's off switch (Settings → 通用). Read at call time rather than
  // captured, so flipping it takes effect on the next export without a reload.
  if (!useSettingsStore.getState().deliverToCloud) return;

  const title = deliveryTitle?.trim() || filename.replace(/\.[^./\\]+$/, '');

  void fetch(ENDPOINT, {
    method: 'POST',
    body: blob,
    headers: {
      'x-deliver-filename': encodeURIComponent(filename),
      'x-deliver-title': encodeURIComponent(title),
      // Which round of the course this belongs to; the worker writes each round
      // into its own `v<n>/` so a re-delivery never overwrites files the
      // customer already downloaded.
      'x-deliver-revision': String(currentDeliveryRevision()),
      'content-type': blob.type || 'application/octet-stream',
    },
  })
    .then(async (response) => {
      if (response.ok) return;
      // 501 means the deployment has no delivery pipeline; that is a normal
      // state, not something to report to the user.
      if (response.status === 501) return;
      const detail = await response.text().catch(() => '');
      log.warn(`Delivery queue rejected ${filename}: HTTP ${response.status} ${detail}`);
    })
    .catch((error: unknown) => {
      log.warn(`Could not queue ${filename} for delivery.`, error);
    });
}
