/**
 * AIGC labelling for exported courseware.
 *
 * 《人工智能生成合成内容标识办法》(effective 2025-09-01) article 4 requires that a
 * provider who offers download/copy/export "ensure the file contains an explicit
 * label that meets the requirements", and GB 45438-2025 §5.4 fixes the shape for
 * video: a text prompt on the opening frame, at an edge or corner, legible, with
 * character height of at least 5% of the frame's shorter side, visible for at
 * least 2 seconds at normal playback speed. §6.1 additionally requires a hidden
 * label in the file metadata carrying the generated-content flag, the provider's
 * name or code, and the content id.
 *
 * The label *text* is localized together with the rest of the export chrome (it
 * must contain the "AI"/"人工智能" and "generated"/"生成合成" elements, which is
 * why it lives in the i18n catalog rather than here). This module only owns the
 * two provider-supplied identifiers and the geometry constants the standard
 * pins down, so the emitter and every app-side export path share one definition
 * of what compliance means instead of each re-deriving the numbers.
 *
 * Pure and dependency-free, so it is importable from the compiler module (whose
 * eslint boundary allows only in-folder relatives) as well as from the app.
 */

/** Longest identifier we will echo into a file we hand to a customer. */
const MAX_IDENTIFIER_LENGTH = 96;

/** Control characters would corrupt the emitted HTML/metadata. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * How long the on-screen label stays visible. The standard's floor is 2s; the
 * extra second absorbs frame-capture rounding and a player's seek-in.
 */
export const AIGC_LABEL_VISIBLE_SECONDS = 3;

/** Character height must reach this fraction of the frame's shorter side. */
export const AIGC_LABEL_MIN_HEIGHT_RATIO = 0.05;

/** Default provider when the deployment has not named itself. */
const DEFAULT_PROVIDER = 'OpenMAIC';

/** What §6.1 requires in the file metadata / HTML head. */
export interface AigcIdentifiers {
  /** 生成合成服务提供者名称或编码. */
  provider: string;
  /** 生成合成服务提供者对内容的唯一编号. */
  contentId: string;
}

function sanitize(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) return fallback;
  if (CONTROL_CHARACTER.test(trimmed)) return fallback;
  return trimmed;
}

/**
 * Resolve the identifiers for one export.
 *
 * @param rawProvider `NEXT_PUBLIC_AIGC_PROVIDER` — the white-label hook; a
 *   customer shipping under their own brand must name themselves here.
 * @param rawContentId `NEXT_PUBLIC_AIGC_CONTENT_ID` — a fixed deployment-wide
 *   code, for providers whose numbering lives outside the app.
 * @param fallbackContentId Per-export stable id (the classroom id), used when no
 *   explicit code is configured: one course keeps one number.
 */
export function resolveAigcIdentifiers(
  rawProvider: string | undefined,
  rawContentId: string | undefined,
  fallbackContentId: string,
): AigcIdentifiers {
  return {
    provider: sanitize(rawProvider, DEFAULT_PROVIDER),
    contentId: sanitize(rawContentId, sanitize(fallbackContentId, 'unknown')),
  };
}

/** Pixel character height the label must reach for a given frame size. */
export function aigcLabelFontPx(width: number, height: number): number {
  return Math.max(1, Math.round(Math.min(width, height) * AIGC_LABEL_MIN_HEIGHT_RATIO));
}
