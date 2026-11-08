'use client';

/**
 * Whether exported files carry the AIGC notice.
 *
 * The notice is a legal obligation, not a style choice: 《人工智能生成合成内容标识
 * 办法》article 4 applies to anyone who offers a generated file for download, and
 * article 9 forbids stripping the label afterwards. Every export path therefore
 * ships with it by default, and this module exists only for the one case the
 * regulation cannot decide for us — a customer who has taken over the provider
 * role (their portal, their name in the metadata) and asked for the notice to be
 * carried elsewhere. That is a decision the operator has to record before work
 * starts, which is why it is a persisted switch rather than a per-export toggle.
 *
 * Precedence: the browser's last choice wins over the deployment default, so a
 * `.env` set to `0` still lets a single order turn the notice back on, and vice
 * versa. `NEXT_PUBLIC_AIGC_LABEL` is the seed, not a lock.
 *
 * Everything is guarded for SSR: on the server the answer is always "on", and
 * nothing is read from or written to `localStorage`.
 */
import { useSyncExternalStore } from 'react';

/** Truthy values for `NEXT_PUBLIC_AIGC_LABEL`; anything else except 0/false is on. */
function envDefault(): boolean {
  const raw = process.env.NEXT_PUBLIC_AIGC_LABEL?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

const STORAGE_KEY = 'openmaic:aigc-label';

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
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The
    // deployment default is the right answer then.
  }
  return undefined;
}

/** Whether the next export should stamp the notice. */
export function isAigcLabelEnabled(): boolean {
  if (snapshot === undefined) snapshot = readStored() ?? envDefault();
  return snapshot;
}

/** Persist a choice and notify every mounted export control. */
export function setAigcLabelEnabled(enabled: boolean): void {
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
export function subscribeAigcLabelPreference(listener: Listener): () => void {
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

/** Server-rendered HTML always shows the notice, so hydration never disagrees. */
export function getAigcLabelServerSnapshot(): boolean {
  return true;
}

/** Reactive form for the export menu; the getters above stay usable outside React. */
export function useAigcLabelEnabled(): boolean {
  return useSyncExternalStore(
    subscribeAigcLabelPreference,
    isAigcLabelEnabled,
    getAigcLabelServerSnapshot,
  );
}
