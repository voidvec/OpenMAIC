/**
 * The naming rules decide three things at once: the folder a course lands in on
 * Aliyun Drive, the filename on disk inside the shared volume, and which saved
 * artifacts are treated as customer deliverables at all. A regression here is
 * silent — a `/` in a title becomes a nested cloud path, an unsupported
 * extension quietly stops being delivered — so each rule is pinned.
 */
import { describe, expect, it } from 'vitest';

import {
  courseFolder,
  decodedHeader,
  decodedRevision,
  formatFromFileName,
  formatLabel,
  mediaTypeOf,
  revisionFolder,
  sanitizeCourseTitle,
  sanitizeFileName,
} from '@/lib/server/deliver/naming';

describe('sanitizeCourseTitle', () => {
  it('keeps Chinese titles as they are', () => {
    expect(sanitizeCourseTitle('HTTPS 如何保护密码')).toBe('HTTPS 如何保护密码');
  });

  it('replaces path separators and Windows-invalid characters with spaces', () => {
    expect(sanitizeCourseTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('collapses whitespace and trims leading dots', () => {
    expect(sanitizeCourseTitle('  ..a    b  ')).toBe('a b');
  });

  it('falls back when the title has nothing usable', () => {
    expect(sanitizeCourseTitle(null)).toBe('未命名课程');
    expect(sanitizeCourseTitle('   ')).toBe('未命名课程');
    expect(sanitizeCourseTitle('///')).toBe('未命名课程');
  });

  it('bounds the length so the folder name stays usable in a URL', () => {
    expect(sanitizeCourseTitle('长'.repeat(200))).toHaveLength(60);
  });
});

describe('sanitizeFileName', () => {
  it('strips any directory part', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\tmp\\课件.pptx')).toBe('课件.pptx');
  });

  it('keeps the extension', () => {
    expect(sanitizeFileName('第一课: 导论.pptx')).toBe('第一课 导论.pptx');
  });

  it('never produces an empty stem', () => {
    expect(sanitizeFileName('')).toBe('export');
    expect(sanitizeFileName('///')).toBe('export');
  });
});

describe('formatFromFileName', () => {
  it.each([
    ['a.mp4', 'mp4'],
    ['a.PPTX', 'pptx'],
    ['a.html', 'html'],
    ['a.htm', 'html'],
    ['a.zip', 'zip'],
  ])('recognises %s', (name, expected) => {
    expect(formatFromFileName(name)).toBe(expected);
  });

  it('ignores artifacts that are not deliverables', () => {
    expect(formatFromFileName('a.srt')).toBeNull();
    expect(formatFromFileName('a.md')).toBeNull();
    expect(formatFromFileName('a')).toBeNull();
  });
});

describe('courseFolder', () => {
  it('appends one folder per course under the configured root', () => {
    expect(courseFolder('/课件', 'HTTPS 如何保护密码')).toBe('/课件/HTTPS 如何保护密码');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(courseFolder('/课件/', 'X')).toBe('/课件/X');
  });
});

describe('revisionFolder', () => {
  it('puts each round in its own v<n> folder, never over the previous one', () => {
    expect(revisionFolder('/课件/第一课', 1)).toBe('/课件/第一课/v1');
    expect(revisionFolder('/课件/第一课', 2)).toBe('/课件/第一课/v2');
  });

  it('treats a missing or nonsensical revision as the first round', () => {
    expect(revisionFolder('/课件/第一课', 0)).toBe('/课件/第一课/v1');
    expect(revisionFolder('/课件/第一课', Number.NaN)).toBe('/课件/第一课/v1');
  });
});

describe('decodedRevision', () => {
  it('reads the round from the header', () => {
    expect(decodedRevision(() => '3')).toBe(3);
  });

  it('falls back to the first round when the header is absent or unusable', () => {
    expect(decodedRevision(() => null)).toBe(1);
    expect(decodedRevision(() => 'second')).toBe(1);
    expect(decodedRevision(() => '0')).toBe(1);
  });
});

describe('decodedHeader', () => {
  it('decodes a percent-encoded Chinese title', () => {
    const value = encodeURIComponent('第一课');
    expect(decodedHeader(() => value, 'x-deliver-title')).toBe('第一课');
  });

  it('returns null for a missing header', () => {
    expect(decodedHeader(() => null, 'x-deliver-title')).toBeNull();
  });

  it('falls back to the raw value when the escape is malformed', () => {
    expect(decodedHeader(() => '%E4%B8', 'x-deliver-title')).toBe('%E4%B8');
  });
});

describe('labels and media types', () => {
  it('labels every deliverable', () => {
    expect(formatLabel('mp4')).toBe('MP4 视频');
    expect(formatLabel('pptx')).toBe('PPTX 课件');
    expect(formatLabel('html')).toBe('HTML 离线页');
    expect(formatLabel('zip')).toBe('ZIP 压缩包');
  });

  it('maps to the media type the browser would send', () => {
    expect(mediaTypeOf('mp4')).toBe('video/mp4');
    expect(mediaTypeOf('zip')).toBe('application/zip');
  });
});
