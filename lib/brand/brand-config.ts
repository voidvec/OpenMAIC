/**
 * Brand configuration.
 *
 * The reference (live deployment) resolves the brand per vendor from the
 * desktop shell's User-Agent token. This workspace has no vendor shell, so the
 * brand is a deployment setting instead: one product identity per deployment,
 * read on the server and passed down through `BrandProvider`. That is what a
 * white-label installation needs — a customer runs their own copy and every
 * surface says their name, not ours.
 *
 * Two sources, in this order:
 *
 * 1. the `brand` block of `openmaic.yml` (the operator's configuration file,
 *    already mounted for the model configuration);
 * 2. `OPENMAIC_BRAND_*` variables, for `pnpm dev` and deployments that keep
 *    their settings in the environment.
 *
 * Anything missing or malformed falls back per field, so a typo in a cosmetic
 * setting never stops the server. The values are only ever rendered as text and
 * as same-origin asset paths — never as HTML, and never as a remote URL.
 */
import type { CSSProperties } from 'react';

export interface BrandConfig {
  /** Full product name (page titles, logo alt text). */
  productName: string;
  /** Short name for space-constrained spots. */
  shortName: string;
  /** Horizontal logo asset under `public/`. */
  logoSrc: string;
  /** Whether `logoSrc` already carries the product wordmark. */
  logoHasWordmark: boolean;
  /** Square brand mark under `public/` (favicon, workspace header). */
  markSrc: string;
  /** Accent colour for light surfaces (also the browser theme colour). */
  themeColor: string;
  /**
   * Accent for dark surfaces. One accent rarely reads well on both palettes,
   * so a branded deployment may name a lighter variant; without one the light
   * accent is reused.
   */
  themeColorDark?: string;
}

/** The default brand: the product itself, with no operator overrides. */
export const DEFAULT_BRAND: BrandConfig = {
  productName: 'OpenMAIC',
  shortName: 'OpenMAIC',
  logoSrc: '/logo-horizontal.png',
  logoHasWordmark: true,
  markSrc: '/openmaic-mark.png',
  themeColor: '#722ed1',
};

/** The `brand` block of `openmaic.yml`, already schema-checked. */
export interface BrandFileBlock {
  name: string;
  shortName?: string;
  logo?: string;
  mark?: string;
  logoHasWordmark?: boolean;
  themeColor?: string;
  themeColorDark?: string;
}

/** The environment variables read when the file names no brand. */
export type BrandEnv = Readonly<Record<string, string | undefined>>;

/** A name long enough to break every layout is a mistake, not a brand. */
const MAX_NAME_LENGTH = 64;

/** Control characters would either vanish or corrupt the rendered markup. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** `#rgb`, `#rrggbb` or `#rrggbbaa`: the syntax a CSS custom property accepts. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function sanitizeName(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTER.test(name)) return undefined;
  return name;
}

/**
 * An asset the deployment serves itself. A remote URL would leak a request to
 * a third party from every page, and `..` would read outside `public/`, so both
 * are refused and the default asset is kept instead.
 */
function sanitizeAssetPath(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.includes('\\') || value.split('/').includes('..')) return fallback;
  if (CONTROL_CHARACTER.test(value)) return fallback;
  return value;
}

function sanitizeColor(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && HEX_COLOR.test(value) ? value : undefined;
}

/**
 * `'false'` is the only way to turn the wordmark flag off: an unset or
 * malformed value keeps the default, so a half-filled configuration still
 * renders a whole brand.
 */
function resolveWordmark(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === 'false') return false;
  if (value === 'true') return true;
  return fallback;
}

/**
 * The brand this deployment serves.
 *
 * @param env `OPENMAIC_BRAND_*`, read when the file gives no value.
 * @param block The `brand` block of `openmaic.yml`, which wins over `env`.
 */
export function resolveBrand(
  env: BrandEnv = process.env,
  block: BrandFileBlock | null = null,
): BrandConfig {
  const envName = sanitizeName(env.OPENMAIC_BRAND_NAME);
  const name = sanitizeName(block?.name) ?? envName;
  // No name anywhere: the deployment is not white-labelled, so it must render
  // exactly the shipped product identity rather than a half-applied one.
  if (!name) return DEFAULT_BRAND;

  const themeColor =
    sanitizeColor(block?.themeColor) ??
    sanitizeColor(env.OPENMAIC_BRAND_THEME_COLOR) ??
    DEFAULT_BRAND.themeColor;
  const themeColorDark =
    sanitizeColor(block?.themeColorDark) ?? sanitizeColor(env.OPENMAIC_BRAND_THEME_COLOR_DARK);

  return {
    productName: name,
    shortName:
      sanitizeName(block?.shortName) ?? sanitizeName(env.OPENMAIC_BRAND_SHORT_NAME) ?? name,
    logoSrc: sanitizeAssetPath(block?.logo ?? env.OPENMAIC_BRAND_LOGO, DEFAULT_BRAND.logoSrc),
    logoHasWordmark:
      block?.logoHasWordmark ?? resolveWordmark(env.OPENMAIC_BRAND_LOGO_HAS_WORDMARK, true),
    markSrc: sanitizeAssetPath(block?.mark ?? env.OPENMAIC_BRAND_MARK, DEFAULT_BRAND.markSrc),
    themeColor,
    ...(themeColorDark ? { themeColorDark } : {}),
  };
}

/**
 * A style object that may carry CSS custom properties. React's own
 * `CSSProperties` has no index signature for them, so the two are combined
 * rather than cast at every call site. Type-only: no runtime React dependency.
 */
export type BrandCssVariables = CSSProperties & Record<`--${string}`, string>;

/**
 * Inline custom properties that re-point the palette at the brand accent.
 *
 * Returned as `--brand-*` rather than `--primary` so `globals.css` keeps
 * owning the light/dark split: an inline `--primary` on `<html>` would beat
 * the `.dark` rule and flatten both themes to one colour.
 */
export function brandCssVariables(brand: BrandConfig): BrandCssVariables {
  return {
    '--brand-primary': brand.themeColor,
    ...(brand.themeColorDark ? { '--brand-primary-dark': brand.themeColorDark } : {}),
  };
}
