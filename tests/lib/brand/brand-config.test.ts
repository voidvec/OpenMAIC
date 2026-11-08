import { describe, expect, it } from 'vitest';
import {
  brandCssVariables,
  DEFAULT_BRAND,
  resolveBrand,
  type BrandConfig,
} from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('uses the original product identity for full chrome', () => {
    expect(DEFAULT_BRAND.productName).toBe('OpenMAIC');
    expect(DEFAULT_BRAND.shortName).toBe('OpenMAIC');
    expect(DEFAULT_BRAND.markSrc).toBe('/openmaic-mark.png');
    expect(DEFAULT_BRAND.themeColor).toBe('#722ed1');
  });

  it('marks its horizontal logo as already containing the wordmark', () => {
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(true);
    expect(DEFAULT_BRAND.logoSrc).toBe('/logo-horizontal.png');
  });
});

describe('resolveBrand', () => {
  it('returns the shipped brand when nothing is configured', () => {
    // Identity, not just equality: callers use `=== DEFAULT_BRAND` to tell a
    // white-labelled deployment from the shipped product (the favicon swap).
    expect(resolveBrand({}, null)).toBe(DEFAULT_BRAND);
  });

  it('prefers the file block over the environment', () => {
    const brand = resolveBrand(
      { OPENMAIC_BRAND_NAME: 'FromEnv', OPENMAIC_BRAND_THEME_COLOR: '#111111' },
      { name: 'FromFile', themeColor: '#0F6E56' },
    );
    expect(brand.productName).toBe('FromFile');
    expect(brand.themeColor).toBe('#0F6E56');
  });

  it('falls back to the environment, then to the shipped values, per field', () => {
    const brand = resolveBrand({ OPENMAIC_BRAND_NAME: 'Acme' }, { name: 'Acme' });
    expect(brand).toMatchObject({
      productName: 'Acme',
      // No short name anywhere: the full name is the short name.
      shortName: 'Acme',
      logoSrc: DEFAULT_BRAND.logoSrc,
      markSrc: DEFAULT_BRAND.markSrc,
      themeColor: DEFAULT_BRAND.themeColor,
      logoHasWordmark: true,
    });
  });

  it('turns the wordmark flag off only on an explicit false', () => {
    const off = resolveBrand(
      { OPENMAIC_BRAND_NAME: 'Acme', OPENMAIC_BRAND_LOGO_HAS_WORDMARK: 'false' },
      null,
    );
    expect(off.logoHasWordmark).toBe(false);
    // A malformed value keeps the default rather than guessing.
    const malformed = resolveBrand(
      { OPENMAIC_BRAND_NAME: 'Acme', OPENMAIC_BRAND_LOGO_HAS_WORDMARK: 'nope' },
      null,
    );
    expect(malformed.logoHasWordmark).toBe(true);
  });

  it.each([
    ['a remote URL', 'https://cdn.example.com/logo.png'],
    ['a protocol-relative URL', '//cdn.example.com/logo.png'],
    ['a path that climbs out of public/', '/brand/../../etc/passwd'],
    ['a Windows path', '\\brand\\logo.png'],
  ])('refuses %s as an asset and keeps the shipped one', (_label, logo) => {
    expect(
      resolveBrand({ OPENMAIC_BRAND_NAME: 'Acme', OPENMAIC_BRAND_LOGO: logo }, null).logoSrc,
    ).toBe(DEFAULT_BRAND.logoSrc);
  });

  it('refuses a colour that is not a hex literal', () => {
    expect(
      resolveBrand({ OPENMAIC_BRAND_NAME: 'Acme', OPENMAIC_BRAND_THEME_COLOR: 'red;}' }, null)
        .themeColor,
    ).toBe(DEFAULT_BRAND.themeColor);
  });

  it('refuses a name that is empty or too long to render', () => {
    expect(resolveBrand({ OPENMAIC_BRAND_NAME: '   ' }, null)).toBe(DEFAULT_BRAND);
    expect(resolveBrand({ OPENMAIC_BRAND_NAME: 'x'.repeat(65) }, null)).toBe(DEFAULT_BRAND);
  });

  it('keeps a dark accent only when one is given', () => {
    const light = resolveBrand({ OPENMAIC_BRAND_NAME: 'Acme' }, null);
    expect(light.themeColorDark).toBeUndefined();
    const both = resolveBrand(
      { OPENMAIC_BRAND_NAME: 'Acme', OPENMAIC_BRAND_THEME_COLOR_DARK: '#3dd6a8' },
      null,
    );
    expect(both.themeColorDark).toBe('#3dd6a8');
  });
});

describe('brandCssVariables', () => {
  it('always carries the accent, and the dark one only when it differs', () => {
    expect(brandCssVariables(DEFAULT_BRAND)).toEqual({ '--brand-primary': '#722ed1' });
    const both: BrandConfig = { ...DEFAULT_BRAND, themeColorDark: '#3dd6a8' };
    expect(brandCssVariables(both)).toEqual({
      '--brand-primary': '#722ed1',
      '--brand-primary-dark': '#3dd6a8',
    });
  });
});
