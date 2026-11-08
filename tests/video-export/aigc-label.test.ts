import { describe, test, expect } from 'vitest';
import {
  AIGC_LABEL_MIN_HEIGHT_RATIO,
  AIGC_LABEL_VISIBLE_SECONDS,
  aigcLabelFontPx,
  resolveAigcIdentifiers,
} from '@/lib/video-export/aigc-label';

// ─── resolveAigcIdentifiers ───────────────────────────────────
describe('resolveAigcIdentifiers', () => {
  test('falls back to the project name and the classroom id when nothing is configured', () => {
    expect(resolveAigcIdentifiers(undefined, undefined, 'mRQO6WQiBW')).toEqual({
      provider: 'OpenMAIC',
      contentId: 'mRQO6WQiBW',
    });
  });

  test('uses the configured provider and content code', () => {
    expect(resolveAigcIdentifiers('ACME Academy', 'ACME-2026-0001', 'stage-1')).toEqual({
      provider: 'ACME Academy',
      contentId: 'ACME-2026-0001',
    });
  });

  test('trims surrounding whitespace instead of shipping it into the label', () => {
    expect(resolveAigcIdentifiers('  ACME  ', '  0001  ', 'stage-1')).toEqual({
      provider: 'ACME',
      contentId: '0001',
    });
  });

  test('treats blank and control-character values as absent', () => {
    // A label we cannot render faithfully is worse than the honest default.
    expect(resolveAigcIdentifiers('   ', undefined, 'stage-1').provider).toBe('OpenMAIC');
    expect(resolveAigcIdentifiers('AC\nME', undefined, 'stage-1').provider).toBe('OpenMAIC');
    expect(resolveAigcIdentifiers(undefined, 'A\u0000B', 'stage-1').contentId).toBe('stage-1');
  });

  test('rejects an over-long identifier rather than truncating it into a wrong one', () => {
    const tooLong = 'x'.repeat(97);
    expect(resolveAigcIdentifiers(tooLong, undefined, 'stage-1').provider).toBe('OpenMAIC');
    expect(resolveAigcIdentifiers('ok', tooLong, 'stage-1').contentId).toBe('stage-1');
  });

  test('never emits an empty content id, even when the fallback is unusable', () => {
    expect(resolveAigcIdentifiers(undefined, undefined, '  ').contentId).toBe('unknown');
  });
});

// ─── geometry ─────────────────────────────────────────────────
describe('aigcLabelFontPx', () => {
  test('derives the character height from the shorter frame side', () => {
    // GB 45438-2025 §5.4: character height >= 5% of the shorter side.
    expect(aigcLabelFontPx(1280, 720)).toBe(36);
    expect(aigcLabelFontPx(1920, 1080)).toBe(54);
    expect(aigcLabelFontPx(3840, 2160)).toBe(108);
  });

  test('keeps a positive size for a degenerate frame', () => {
    expect(aigcLabelFontPx(0, 0)).toBe(1);
  });

  test('pins the constants the standard requires', () => {
    expect(AIGC_LABEL_MIN_HEIGHT_RATIO).toBe(0.05);
    expect(AIGC_LABEL_VISIBLE_SECONDS).toBeGreaterThanOrEqual(2);
  });
});
