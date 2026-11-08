/**
 * The finished MP4 of a course, kept in the device database between the render
 * and the delivery export.
 *
 * The two are minutes apart at best (a 30-minute render, then the operator
 * exports the handover), and they are two different features: the render dialog
 * writes a file the operator saves, the export menu builds a zip the buyer
 * opens. Without a place to put the bytes, the second one had nothing to ship
 * and produced a "delivery bundle" with no video in it.
 *
 * Why not ask the render service at export time: its job records and its output
 * directory both live in the container's memory and temp space, so a restart
 * between render and export makes the job unfetchable (2026-11-07: a 31-minute
 * render became unreachable exactly this way, and only the cloud copy survived).
 * The browser is the one place that still has the bytes after that.
 *
 * Failure here is never fatal: a bundle without a video is still a bundle, and
 * the caller says so on the cover sheet. So every function swallows storage
 * errors — a private-mode browser with a zero quota must not break a render that
 * otherwise succeeded.
 */
import { createLogger } from '@/lib/logger';

import { db, type RenderedVideoRecord } from './database';

const log = createLogger('RenderedVideo');

export interface RenderedVideoInfo {
  filename: string;
  width: number;
  height: number;
  fps: number;
  quality: string;
  /** Wall-clock length; 0 when it could not be measured. */
  durationSec: number;
}

/** Keep the bytes of a finished render, replacing any previous one for the course. */
export async function saveRenderedVideo(
  stageId: string,
  blob: Blob,
  info: RenderedVideoInfo,
): Promise<boolean> {
  if (!stageId || blob.size === 0) return false;
  const record: RenderedVideoRecord = {
    stageId,
    blob,
    filename: info.filename,
    bytes: blob.size,
    width: info.width,
    height: info.height,
    fps: info.fps,
    quality: info.quality,
    durationSec: info.durationSec,
    createdAt: Date.now(),
  };
  try {
    await db.renderedVideos.put(record);
    return true;
  } catch (error) {
    // Quota is the expected failure: 45 MB of video against a browser that may
    // have far less free than that. Say so once and keep going.
    log.warn('Could not keep the rendered video for the delivery bundle.', error);
    return false;
  }
}

/** The course's finished video, or null when this browser has never rendered it. */
export async function loadRenderedVideo(stageId: string): Promise<RenderedVideoRecord | null> {
  if (!stageId) return null;
  try {
    return (await db.renderedVideos.get(stageId)) ?? null;
  } catch (error) {
    log.warn('Could not read the rendered video.', error);
    return null;
  }
}

/** Drop the copy; used when a course is deleted so the bytes are not orphaned. */
export async function forgetRenderedVideo(stageId: string): Promise<void> {
  if (!stageId) return;
  try {
    await db.renderedVideos.delete(stageId);
  } catch (error) {
    log.warn('Could not drop the rendered video.', error);
  }
}

/**
 * Read a blob's duration through a detached `<video>`.
 *
 * The format sheet a competition entry needs quotes the length of the file the
 * buyer will hand in, and the render response does not carry one. Falls back to
 * 0 rather than throwing: a sheet without a duration is still usable, a bundle
 * that fails to build is not.
 */
export function measureVideoDuration(blob: Blob): Promise<number> {
  if (typeof document === 'undefined') return Promise.resolve(0);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    const done = (value: number) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };
    // Metadata only: the element never joins the document and never plays.
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(0);
    video.src = url;
  });
}
