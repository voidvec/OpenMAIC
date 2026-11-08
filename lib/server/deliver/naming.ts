/**
 * Naming rules shared by the upload route and the delivery worker.
 *
 * Two very different consumers read these strings: the filesystem inside the
 * shared volume, and `aliyunpan` on the way to the cloud. Both are unforgiving
 * in different ways — a `/` in a course title becomes a path separator (or a
 * rejected cloud path), and Windows-invalid characters survive a browser
 * download fine but break a CLI argument — so the sanitising happens once here.
 */
import { extname } from 'node:path';

import type { ExportDeliveryFormat } from '@/lib/persistence/export-deliveries';

/** Characters that are illegal in a filename on any of the platforms this runs on. */
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

const MAX_TITLE_LENGTH = 60;

export function sanitizeCourseTitle(
  title: string | null | undefined,
  fallback = '未命名课程',
): string {
  const cleaned = (title ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || fallback).slice(0, MAX_TITLE_LENGTH).trim();
}

/**
 * A storage filename: keep the extension, drop everything that could escape the
 * directory or trip the CLI. The result is always a bare name, never a path.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const extension = extname(base).replace(UNSAFE, '');
  const stem = base
    .slice(0, base.length - extname(base).length)
    .replace(UNSAFE, ' ')
    .trim();
  const safeStem = stem.replace(/\s+/g, ' ').slice(0, 120) || 'export';
  return `${safeStem}${extension}`;
}

/**
 * The cloud folder one course is collected under — the share target.
 *
 * The link a customer holds points here, not at a revision folder, so a course
 * that comes back for changes does not need a second link: v2 simply appears
 * next to the v1 they already saved.
 */
export function courseFolder(cloudRoot: string, courseTitle: string | null): string {
  const root = cloudRoot.replace(/\/+$/, '');
  return `${root}/${sanitizeCourseTitle(courseTitle)}`;
}

/**
 * Where one round of that course is written.
 *
 * A seller's second delivery is almost never a different course — it is the same
 * course with the requested changes. Writing both into the course folder would
 * overwrite the files the customer already downloaded (same name, same path), so
 * every round gets its own `v<n>/` and nothing is ever replaced in place.
 */
export function revisionFolder(courseFolderPath: string, revision: number): string {
  const safe = Number.isFinite(revision) && revision >= 1 ? Math.trunc(revision) : 1;
  return `${courseFolderPath.replace(/\/+$/, '')}/v${safe}`;
}

/**
 * The artifact kind a filename implies, or null for files that are not a
 * customer deliverable (subtitles, scripts) and must not be auto-uploaded.
 */
export function formatFromFileName(name: string): ExportDeliveryFormat | null {
  switch (extname(name).toLowerCase()) {
    case '.mp4':
      return 'mp4';
    case '.pptx':
      return 'pptx';
    case '.html':
    case '.htm':
      return 'html';
    case '.zip':
      return 'zip';
    default:
      return null;
  }
}

export function formatLabel(format: ExportDeliveryFormat): string {
  switch (format) {
    case 'mp4':
      return 'MP4 视频';
    case 'pptx':
      return 'PPTX 课件';
    case 'html':
      return 'HTML 离线页';
    case 'zip':
      return 'ZIP 压缩包';
  }
}

export function mediaTypeOf(format: ExportDeliveryFormat): string {
  switch (format) {
    case 'mp4':
      return 'video/mp4';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'html':
      return 'text/html; charset=utf-8';
    case 'zip':
      return 'application/zip';
  }
}

/**
 * Read a header that carries a percent-encoded value.
 *
 * HTTP header values are bytes, not text, so a course title cannot travel raw;
 * both producers encode it and both readers decode here. A malformed escape is
 * not worth failing an export over — the value is only a folder name and a card
 * title, so the raw string is used instead.
 */
export function decodedHeader(read: (name: string) => string | null, name: string): string | null {
  const raw = read(name);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Read `x-deliver-revision`: which round of the course this artifact belongs to.
 *
 * Absent or unreadable means v1. The value only selects a folder, so a bad
 * header must never fail an upload that has already been streamed to disk — the
 * wrong folder is recoverable by hand, a lost artifact is not.
 */
export function decodedRevision(read: (name: string) => string | null): number {
  const raw = read('x-deliver-revision');
  if (!raw) return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.trunc(value), 999) : 1;
}
