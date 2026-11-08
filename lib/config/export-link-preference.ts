'use client';

/**
 * Whether placeholder slides point only at the exported files.
 *
 * A placeholder slide has two ways to reach its scene, and they fail in
 * opposite situations. The online button (plus the QR code beside it) needs a
 * deployment the reader can reach: on a laptop behind localhost it is a dead
 * link, and on any machine it is someone else's server. The relative link needs
 * nothing but the folder the deck shipped in — but only exists when the deck
 * travels with its pages, which is what the Resource Pack and the delivery
 * bundle are for.
 *
 * So this is a preference rather than a per-export choice, and it defaults to
 * "online": a teacher exporting a deck for their own class wants the QR code,
 * while a handover for a machine we will never see wants the relative path. The
 * switch removes the online button and QR entirely instead of leaving a link
 * that cannot resolve, and prints the relative path in their place so the
 * reader can still find the file by hand.
 *
 * It governs exactly the two exports whose link target depends on it: the
 * standalone PPTX and the Resource Pack. The delivery bundle does not listen to
 * it — that zip always ships relative links, because a handover must not depend
 * on the operator remembering a toggle. Interactive pages are files in both
 * packs and link to each other relatively whatever this says.
 *
 * Everything is guarded for SSR: on the server the answer is "online", and
 * nothing is read from or written to `localStorage`.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openmaic:export-offline-links';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * The resolved value, cached so `useSyncExternalStore`'s snapshot stays
 * referentially stable. `undefined` means "not read yet".
 */
let snapshot: boolean | undefined;

function readStored(): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The default
    // is the right answer then.
  }
  return undefined;
}

/** Whether the next export should leave the online classroom out of the deck. */
export function isOfflineOnlyLinks(): boolean {
  if (snapshot === undefined) snapshot = readStored() ?? false;
  return snapshot;
}

/** Persist a choice and notify every mounted export control. */
export function setOfflineOnlyLinks(enabled: boolean): void {
  snapshot = enabled;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // Not persisting is a degraded choice, never a failed export: the value
      // still applies to this page's lifetime.
    }
  }
  for (const listener of listeners) listener();
}

/** Subscribe for `useSyncExternalStore`; also follows edits from other tabs. */
export function subscribeOfflineLinkPreference(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') return () => listeners.delete(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Server-rendered HTML shows the online button, so hydration never disagrees. */
export function getOfflineOnlyLinksServerSnapshot(): boolean {
  return false;
}

/** Reactive form for the export menu; the getters above stay usable elsewhere. */
export function useOfflineOnlyLinks(): boolean {
  return useSyncExternalStore(
    subscribeOfflineLinkPreference,
    isOfflineOnlyLinks,
    getOfflineOnlyLinksServerSnapshot,
  );
}
