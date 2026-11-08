'use client';

/**
 * Which round of a course is being delivered.
 *
 * A seller's second delivery is almost never a different course — it is the same
 * course with the changes the buyer asked for. Writing both rounds into the same
 * cloud folder would overwrite the files the buyer already downloaded, so every
 * round gets its own `v<n>/` under the course folder, and the link they were
 * given keeps working because it points at the folder, not at a round.
 *
 * The number is browser state, keyed by classroom id, in the same spirit as the
 * save-directory memory: it is a property of *this operator working on this
 * course on this machine*, not of the course record the server owns. It advances
 * only when a delivery pack is exported — the moment a round is actually
 * delivered — so exporting a lone PPTX to check a page does not burn a number.
 */
import { useStageStore } from '@/lib/store/stage';

const STORAGE_KEY = 'openmaic:delivery-revision';

/** Ceiling on the counter; a course with more rounds than this needs a new title. */
const MAX_REVISION = 999;

/** Key for a classroom that was never saved: one scratch course per machine. */
const UNSAVED_KEY = 'unsaved';

function readMap(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
        map[key] = Math.min(Math.trunc(value), MAX_REVISION);
      }
    }
    return map;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Not remembering the round is a degraded convenience: two rounds land in
    // the same folder and the seller renames one by hand. Never an export error.
  }
}

/** The classroom this window is showing, or a scratch key when none is saved. */
function courseKey(): string {
  return useStageStore.getState().stage?.id || UNSAVED_KEY;
}

/** The round the next export belongs to; 1 for a course never delivered. */
export function currentDeliveryRevision(): number {
  return readMap()[courseKey()] ?? 1;
}

/** The round the next export belongs to, without touching the counter. */
export function peekDeliveryRevision(): number {
  return currentDeliveryRevision();
}

/**
 * Move to the next round after a delivery pack was written.
 *
 * Called *after* the bytes are on disk: a pack that failed to build must not
 * consume a number, or the customer's v2 would start at v3.
 */
export function advanceDeliveryRevision(): number {
  const key = courseKey();
  const map = readMap();
  const next = Math.min((map[key] ?? 1) + 1, MAX_REVISION);
  map[key] = next;
  writeMap(map);
  return next;
}
