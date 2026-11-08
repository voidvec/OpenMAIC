/**
 * Interactive save-destination handling for every browser-side download.
 *
 * A page cannot write outside the browser's download folder on its own; the
 * only sanctioned route is the File System Access API, and its pickers demand
 * *transient user activation* — i.e. they must be opened from the click handler
 * that starts the export, not from the code that finally has the bytes. Video
 * renders and ZIP packaging finish minutes after the click, so the destination
 * is resolved up front and reused when the bytes exist. Hence the two-phase
 * {@link resolveSaveTarget} / {@link writeSaveTarget} pair, and the rule that
 * the former is awaited directly inside an event handler.
 *
 * Callers must treat `null` as "the user declined" and abort quietly: a
 * dismissed picker is a deliberate no, not a failure to report.
 *
 * Chromium remembers the last directory per picker `id`, so a repeat export
 * reopens where the previous one went without us persisting file handles.
 */
import { saveAs } from 'file-saver';
import { createLogger } from '@/lib/logger';

import { queueArtifactDelivery } from './auto-deliver';

const log = createLogger('SaveTarget');

/** Where an export will be written once its bytes are ready. */
export type SaveTarget =
  | { readonly kind: 'directory'; readonly handle: SaveDirectoryHandle }
  /** No picker available (or it failed): the browser's own download folder. */
  | { readonly kind: 'browser' };

/**
 * Picker `id`s. Chromium keys its per-id "last used directory" memory on these
 * strings, so they must stay stable and distinct per export kind.
 */
export const SAVE_DIR_IDS = {
  classroomZip: 'openmaic-classroom-zip',
  videoZip: 'openmaic-video-zip',
  videoMp4: 'openmaic-video-mp4',
  subtitles: 'openmaic-subtitles',
  slides: 'openmaic-slides',
  script: 'openmaic-script',
  html: 'openmaic-html',
} as const;

/**
 * Structural subset of the File System Access handles we use, declared locally
 * so this module does not depend on the DOM lib carrying the API.
 */
export interface SaveDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<SaveFileHandle>;
}

interface SaveFileHandle {
  createWritable(options?: {
    keepExistingData?: boolean;
  }): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
}) => Promise<SaveDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

/** True when the browser can offer a folder chooser (Chromium-based). */
export function canChooseSaveDirectory(): boolean {
  return directoryPicker() !== null;
}

/**
 * Ask where this export should be written.
 *
 * Await this straight from a click handler, before any long-running work.
 *
 * @returns the chosen destination, or `null` when the user dismissed the
 *   picker — the caller should abort without a success toast.
 */
export async function resolveSaveTarget(id: string): Promise<SaveTarget | null> {
  const picker = directoryPicker();
  if (!picker) return { kind: 'browser' };
  try {
    return { kind: 'directory', handle: await picker({ id, mode: 'readwrite' }) };
  } catch (error) {
    // AbortError is the documented "user closed the picker" — an explicit no.
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    // Anything else (policy block, cross-origin frame) degrades to the
    // browser's download folder instead of failing the export outright.
    log.warn('Folder picker unavailable; using the browser download folder.', error);
    return { kind: 'browser' };
  }
}

/**
 * Write `blob` to `filename` in the resolved destination, falling back to a
 * plain browser download if the chosen folder is no longer writable (revoked
 * permission, folder deleted mid-export).
 *
 * Whatever the destination, the artifact is then queued for cloud delivery
 * ({@link queueArtifactDelivery}) — the seller's copy on Aliyun Drive is what the
 * customer is actually sent, and this is the single point every export passes.
 */
export async function writeSaveTarget(
  target: SaveTarget,
  filename: string,
  blob: Blob,
  options: { deliveryTitle?: string } = {},
): Promise<void> {
  if (target.kind === 'browser') {
    saveAs(blob, filename);
    queueArtifactDelivery(filename, blob, options.deliveryTitle);
    return;
  }
  try {
    const fileHandle = await target.handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    log.warn(`Could not write ${filename} to the chosen folder; downloading instead.`, error);
    saveAs(blob, filename);
  }
  queueArtifactDelivery(filename, blob, options.deliveryTitle);
}
