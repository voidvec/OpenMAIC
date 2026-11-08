'use client';

import { useState, useCallback, useRef } from 'react';
import pptxgen from 'pptxgenjs';
import { validateShapeGeometry, RENDER_PATH_LIMITS, shapeToTextFallback } from '@openmaic/geometry';
import tinycolor from 'tinycolor2';
import { toast } from 'sonner';
import {
  resolveSaveTarget,
  writeSaveTarget,
  SAVE_DIR_IDS,
  type SaveTarget,
} from '@/lib/download/save-target';

import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import {
  enumerateAssetManifest,
  slideMediaSlotDescriptors,
  type Slide,
  type PPTElementOutline,
  type PPTElementShadow,
  type PPTElementLink,
} from '@openmaic/dsl';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { getElementRange, getLineElementPath, getTableSubThemeColor } from '@/lib/utils/element';
import { type AST, toAST } from '@/lib/export/html-parser';
import { type SvgPoints, toPoints, getSvgPathRange } from '@/lib/export/svg-path-parser';
import { svg2Base64 } from '@/lib/export/svg2base64';
import { latexToOmml } from '@/lib/export/latex-to-omml';
import { inlineMathSource, proseToPlainText } from '@/lib/export/pptx-rich-text';
import {
  aigcLabelFontPx,
  resolveAigcIdentifiers,
  type AigcIdentifiers,
} from '@/lib/video-export/aigc-label';
import { createLogger } from '@/lib/logger';
import { collectSpeechText } from './narration';
import { inlineHtmlAssets, createAssetFetcher } from './inline-assets';
import type { FetchAsset } from './inline-assets';
import { createProxiedFetch } from './proxied-fetch';
import {
  listInteractivePages,
  placeholderStyleFor,
  pptxDeckScenes,
  planPptxDeck,
  pptxSlideNumbers,
  renderScenePlaceholder,
  slidesOnlyDeck,
  type PptxDeckEntry,
} from './pptx-scene-placeholders';
import { qrPngDataUrl } from './qr-png';
import { isAigcLabelEnabled } from '@/lib/config/aigc-label-preference';
import { isOfflineOnlyLinks } from '@/lib/config/export-link-preference';
import { buildDocxBlob, buildMarkdown, collectSceneScripts } from './use-export-script';
import {
  assembleDeliveryBundle,
  bundleTitle,
  type DeliverySku,
  type FormatFile,
} from './delivery-bundle';
import { buildFormatSheet, buildRecordingSheet } from './format-sheet';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from './standalone-html/contract';
import { loadRenderedVideo } from '@/lib/device-storage/rendered-video';
import { advanceDeliveryRevision } from '@/lib/download/delivery-revision';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { VIDEO_RESOLUTIONS } from '@/lib/video-export-app/export-options';
import { listQuizBookletSections, quizBookletPath, renderQuizBooklet } from './quiz-booklet';
import { classroomPageUrl } from '@/lib/classroom/scene-deep-link';
import type { AssetUrlLeaseState } from '@/lib/media/use-asset-url';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import { lookupMediaTask, resolveVideoMediaForElement } from '@/lib/media/media-task-resolution';

const log = createLogger('ExportPPTX');

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_FONT_FAMILY = 'Microsoft YaHei';

// ── Color formatting ──

function formatColor(_color: string) {
  if (!_color) {
    return { alpha: 0, color: '#000000' };
  }
  const c = tinycolor(_color);
  const alpha = c.getAlpha();
  const color = alpha === 0 ? '#ffffff' : c.setAlpha(1).toHexString();
  return { alpha, color };
}

type FormatColor = ReturnType<typeof formatColor>;

// ── HTML → pptxgenjs TextProps ──

function formatHTML(html: string, ratioPx2Pt: number) {
  const ast = toAST(html);
  let bulletFlag = false;
  let indent = 0;

  const slices: pptxgen.TextProps[] = [];

  const parse = (obj: AST[], baseStyleObj: Record<string, string> = {}) => {
    for (const item of obj) {
      const isBlockTag = 'tagName' in item && ['div', 'li', 'p'].includes(item.tagName);

      if (isBlockTag && slices.length) {
        const lastSlice = slices[slices.length - 1];
        if (!lastSlice.options) lastSlice.options = {};
        lastSlice.options.breakLine = true;
      }

      const styleObj = { ...baseStyleObj };
      const styleAttr =
        'attributes' in item ? item.attributes.find((attr) => attr.key === 'style') : null;
      if (styleAttr && styleAttr.value) {
        const styleArr = styleAttr.value.split(';');
        for (const styleItem of styleArr) {
          const match = styleItem.match(/([^:]+):\s*(.+)/);
          if (match) {
            const [key, value] = [match[1].trim(), match[2].trim()];
            if (key && value) styleObj[key] = value;
          }
        }
      }

      if ('tagName' in item) {
        if (item.tagName === 'em') styleObj['font-style'] = 'italic';
        if (item.tagName === 'strong') styleObj['font-weight'] = 'bold';
        if (item.tagName === 'sup') styleObj['vertical-align'] = 'super';
        if (item.tagName === 'sub') styleObj['vertical-align'] = 'sub';
        if (item.tagName === 'a') {
          const attr = item.attributes.find((a) => a.key === 'href');
          styleObj['href'] = attr?.value || '';
        }
        if (item.tagName === 'ul') styleObj['list-type'] = 'ul';
        if (item.tagName === 'ol') styleObj['list-type'] = 'ol';
        if (item.tagName === 'li') bulletFlag = true;
        if (item.tagName === 'p') {
          if ('attributes' in item) {
            const dataIndentAttr = item.attributes.find((a) => a.key === 'data-indent');
            if (dataIndentAttr && dataIndentAttr.value) indent = +dataIndentAttr.value;
          }
        }
      }

      // An inline formula is one run holding its LaTeX source, never the
      // text of its rendered KaTeX tree.
      const mathSource = inlineMathSource(item);

      if ('tagName' in item && item.tagName === 'br') {
        slices.push({ text: '', options: { breakLine: true } });
      } else if ('content' in item || mathSource !== null) {
        const text =
          mathSource !== null
            ? mathSource
            : (item as { content: string }).content
                .replace(/&nbsp;/g, ' ')
                .replace(/&gt;/g, '>')
                .replace(/&lt;/g, '<')
                .replace(/&amp;/g, '&')
                .replace(/\n/g, '');
        const options: pptxgen.TextPropsOptions = {};

        if (styleObj['font-size']) {
          options.fontSize = parseInt(styleObj['font-size']) / ratioPx2Pt;
        }
        if (styleObj['color']) {
          options.color = formatColor(styleObj['color']).color;
        }
        if (styleObj['background-color']) {
          options.highlight = formatColor(styleObj['background-color']).color;
        }
        if (styleObj['text-decoration-line']) {
          if (styleObj['text-decoration-line'].indexOf('underline') !== -1) {
            options.underline = {
              color: options.color || '#000000',
              style: 'sng',
            };
          }
          if (styleObj['text-decoration-line'].indexOf('line-through') !== -1) {
            options.strike = 'sngStrike';
          }
        }
        if (styleObj['text-decoration']) {
          if (styleObj['text-decoration'].indexOf('underline') !== -1) {
            options.underline = {
              color: options.color || '#000000',
              style: 'sng',
            };
          }
          if (styleObj['text-decoration'].indexOf('line-through') !== -1) {
            options.strike = 'sngStrike';
          }
        }
        if (styleObj['vertical-align']) {
          if (styleObj['vertical-align'] === 'super') options.superscript = true;
          if (styleObj['vertical-align'] === 'sub') options.subscript = true;
        }
        if (styleObj['text-align']) options.align = styleObj['text-align'] as pptxgen.HAlign;
        if (styleObj['font-weight']) options.bold = styleObj['font-weight'] === 'bold';
        if (styleObj['font-style']) options.italic = styleObj['font-style'] === 'italic';
        if (styleObj['font-family']) options.fontFace = styleObj['font-family'];
        if (styleObj['href']) options.hyperlink = { url: styleObj['href'] };

        if (bulletFlag && styleObj['list-type'] === 'ol') {
          options.bullet = {
            type: 'number',
            indent: (options.fontSize || DEFAULT_FONT_SIZE) * 1.25,
          };
          options.paraSpaceBefore = 0.1;
          bulletFlag = false;
        }
        if (bulletFlag && styleObj['list-type'] === 'ul') {
          options.bullet = {
            indent: (options.fontSize || DEFAULT_FONT_SIZE) * 1.25,
          };
          options.paraSpaceBefore = 0.1;
          bulletFlag = false;
        }
        if (indent) {
          options.indentLevel = indent;
          indent = 0;
        }

        slices.push({ text, options });
      } else if ('children' in item) parse(item.children, styleObj);
    }
  };
  parse(ast);
  return slices;
}

// ── SVG path → pptxgenjs points ──

type Points = Array<
  | { x: number; y: number; moveTo?: boolean }
  | {
      x: number;
      y: number;
      curve: {
        type: 'arc';
        hR: number;
        wR: number;
        stAng: number;
        swAng: number;
      };
    }
  | {
      x: number;
      y: number;
      curve: { type: 'quadratic'; x1: number; y1: number };
    }
  | {
      x: number;
      y: number;
      curve: { type: 'cubic'; x1: number; y1: number; x2: number; y2: number };
    }
  | { close: true }
>;

function formatPoints(
  points: SvgPoints,
  ratioPx2Inch: number,
  scale = { x: 1, y: 1 },
  origin = { x: 0, y: 0 },
): Points {
  return points.map((point) => {
    if (point.close !== undefined) {
      return { close: true };
    } else if (point.type === 'M') {
      return {
        x: (((point.x as number) - origin.x) / ratioPx2Inch) * scale.x,
        y: (((point.y as number) - origin.y) / ratioPx2Inch) * scale.y,
        moveTo: true,
      };
    } else if (point.curve) {
      if (point.curve.type === 'cubic') {
        return {
          x: (((point.x as number) - origin.x) / ratioPx2Inch) * scale.x,
          y: (((point.y as number) - origin.y) / ratioPx2Inch) * scale.y,
          curve: {
            type: 'cubic' as const,
            x1: (((point.curve.x1 as number) - origin.x) / ratioPx2Inch) * scale.x,
            y1: (((point.curve.y1 as number) - origin.y) / ratioPx2Inch) * scale.y,
            x2: (((point.curve.x2 as number) - origin.x) / ratioPx2Inch) * scale.x,
            y2: (((point.curve.y2 as number) - origin.y) / ratioPx2Inch) * scale.y,
          },
        };
      } else if (point.curve.type === 'quadratic') {
        return {
          x: (((point.x as number) - origin.x) / ratioPx2Inch) * scale.x,
          y: (((point.y as number) - origin.y) / ratioPx2Inch) * scale.y,
          curve: {
            type: 'quadratic' as const,
            x1: (((point.curve.x1 as number) - origin.x) / ratioPx2Inch) * scale.x,
            y1: (((point.curve.y1 as number) - origin.y) / ratioPx2Inch) * scale.y,
          },
        };
      }
    }
    return {
      x: (((point.x as number) - origin.x) / ratioPx2Inch) * scale.x,
      y: (((point.y as number) - origin.y) / ratioPx2Inch) * scale.y,
    };
  });
}

// ── Shadow config ──

function getShadowOption(shadow: PPTElementShadow, ratioPx2Pt: number): pptxgen.ShadowProps {
  const c = formatColor(shadow.color);
  const { h, v } = shadow;

  let offset = 4;
  let angle = 45;

  if (h === 0 && v === 0) {
    offset = 4;
    angle = 45;
  } else if (h === 0) {
    if (v > 0) {
      offset = v;
      angle = 90;
    } else {
      offset = -v;
      angle = 270;
    }
  } else if (v === 0) {
    if (h > 0) {
      offset = h;
      angle = 1;
    } else {
      offset = -h;
      angle = 180;
    }
  } else if (h > 0 && v > 0) {
    offset = Math.max(h, v);
    angle = 45;
  } else if (h > 0 && v < 0) {
    offset = Math.max(h, -v);
    angle = 315;
  } else if (h < 0 && v > 0) {
    offset = Math.max(-h, v);
    angle = 135;
  } else if (h < 0 && v < 0) {
    offset = Math.max(-h, -v);
    angle = 225;
  }

  return {
    type: 'outer',
    color: c.color.replace('#', ''),
    opacity: c.alpha,
    // pptxgenjs shadow blur AND offset are in points; the source model is in
    // pixels. blur was converted but offset was not, so shadows exported ~33%
    // too far at the default viewport (ratioPx2Pt = 96/72 × viewportSize/960).
    blur: shadow.blur / ratioPx2Pt,
    offset: offset / ratioPx2Pt,
    angle,
  };
}

// ── Outline config ──

const dashTypeMap: Record<string, string> = {
  solid: 'solid',
  dashed: 'dash',
  dotted: 'sysDot',
};

function getOutlineOption(outline: PPTElementOutline, ratioPx2Pt: number): pptxgen.ShapeLineProps {
  const c = formatColor(outline?.color || '#000000');
  return {
    color: c.color,
    transparency: (1 - c.alpha) * 100,
    width: (outline.width || 1) / ratioPx2Pt,
    dashType: outline.style ? (dashTypeMap[outline.style] as 'solid' | 'dash' | 'sysDot') : 'solid',
  };
}

// ── Link config ──

// `slideNumbers` maps a slide id to its 1-based PPTX slide number. It is not
// the index in `slides`: placeholder slides for non-slide scenes sit in between.
function getLinkOption(
  link: PPTElementLink,
  slideNumbers: ReadonlyMap<string, number>,
): pptxgen.HyperlinkProps | null {
  const { type, target } = link;
  if (type === 'web') return { url: target };
  if (type === 'slide') {
    const slideNumber = slideNumbers.get(target);
    if (slideNumber !== undefined) return { slide: slideNumber };
  }
  return null;
}

// ── Image helpers ──

function isBase64Image(url: string) {
  return /^data:image\/[^;]+;base64,/.test(url);
}

function isSVGImage(url: string) {
  return /^data:image\/svg\+xml;base64,/.test(url) || /\.svg$/.test(url);
}

// ── Main export hook ──

// ── Build PPTX blob (reused by single-export and resource pack) ──

/**
 * Extract speaker notes text from a scene's actions.
 * Concatenates speech text and action labels into plain text.
 */
/**
 * Speaker notes for one slide: the scene's speech text in action order.
 * Delegates to the shared narration walk in `./narration` (#1142) with its
 * historical options — whitespace-only speech is kept and parts are not
 * trimmed, matching the pre-refactor notes output.
 */
function buildSpeakerNotes(scene: Scene): string {
  return collectSpeechText(scene);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function resolvePptxMediaBinding(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  lease: AssetUrlLeaseState = MISSING_ASSET_LEASE,
  mediaGenerationDisabled = false,
) {
  const resolution = resolveMediaRef(ref, task, lease, mediaGenerationDisabled);
  return { resolution, src: renderableMediaUrl(resolution) ?? '' };
}

/**
 * Resolve one media ref to an embeddable PPTX source through the shared
 * resolver, so no export-element branch carries its own fallback chain.
 *
 * An opaque ref (allocated id or legacy placeholder) resolves pool-first via
 * {@link resolveStoredBytes} -- then the compatibility row, then the task's
 * resolved URL, every level gated on the media-resolution state machine -- and
 * embeds as a data URL. A concrete address resolves to itself through the
 * state machine and keeps the caller's legacy fetch path. Returns '' when no
 * level yields a renderable source; the caller skips the element.
 */
async function resolvePptxEmbeddableSrc(
  ref: string | undefined,
  task: MediaTaskState | undefined,
  stageId?: string,
): Promise<string> {
  if (!ref) return '';
  if (!isConcreteMediaAddress(ref)) {
    const stored = await resolveStoredBytes(ref, {
      stageId,
      resolutionGating: true,
      loadCompatRow: true,
      taskUrlFallback: true,
      fetchPolicy: { requireOk: true, requireNonEmpty: false },
    });
    if (stored) return blobToDataUrl(stored);
  }
  const tasks = useMediaGenerationStore.getState().tasks;
  const effectiveTask = task ?? lookupMediaTask(tasks, ref, stageId);
  return renderableMediaUrl(resolvePptxMediaBinding(ref, effectiveTask).resolution) ?? '';
}

/**
 * Derive the document-wide candidate set for PPTX media resolution through the
 * standard manifest. The PPTX document is the ordered slide list it renders;
 * speaker-note actions and non-rendered whiteboards are intentionally outside
 * this media scope.
 */
export function derivePptxMediaReferenceSet(slides: readonly Slide[]): ReadonlySet<string> {
  const scenes = slides.map(
    (slide, index) =>
      ({
        id: `pptx-slide-${index}`,
        stageId: 'pptx-export',
        type: 'slide',
        title: '',
        order: index,
        content: { type: 'slide', canvas: slide },
      }) as Scene,
  );
  return new Set(enumerateAssetManifest({ stage: {}, scenes }).entries.map(({ ref }) => ref));
}

/**
 * The manifest-guard predicate: is this ref foreign to the PPTX document's
 * asset manifest, with no task ownership that would legitimate it? A generated
 * task may supply concrete runtime URLs (its objectUrl, or the poster of an
 * element without one) that are runtime metadata rather than document refs;
 * every other ref the layout resolves must come from the manifest. Exported so
 * the guard's foreign-ref rejection stays directly testable.
 */
export function isPptxManifestForeignRef(
  ref: string | undefined,
  manifestRefs: ReadonlySet<string>,
  task: MediaTaskState | undefined,
): boolean {
  return !!ref && !manifestRefs.has(ref) && task?.objectUrl !== ref;
}

/**
 * Pin the manifest and layout walks together. Element iteration remains
 * necessary for coordinates, z-order and video binding selection; it may not
 * introduce or omit a media role relative to the manifest.
 */
export function assertPptxMediaReferenceParity(
  slides: readonly Slide[],
  manifestRefs: ReadonlySet<string>,
): void {
  const layoutRefs = new Set<string>();
  for (const slide of slides) {
    for (const slot of slideMediaSlotDescriptors(slide)) {
      if (slot.ref) layoutRefs.add(slot.ref);
    }
  }
  const missingFromLayout = [...manifestRefs].filter((ref) => !layoutRefs.has(ref));
  const missingFromManifest = [...layoutRefs].filter((ref) => !manifestRefs.has(ref));
  if (missingFromLayout.length > 0 || missingFromManifest.length > 0) {
    throw new Error(
      `PPTX media manifest/layout mismatch: ` +
        `manifest-only=${JSON.stringify(missingFromLayout)}, ` +
        `layout-only=${JSON.stringify(missingFromManifest)}`,
    );
  }
}

/**
 * A QR code cannot hold an arbitrarily long url — `uqr` rejects anything past
 * its byte capacity. The code is a convenience; the hyperlink is the content,
 * so a failed encode drops the image instead of aborting the whole export.
 */
async function qrDataUrlFor(url: string): Promise<string | undefined> {
  try {
    return await qrPngDataUrl(url);
  } catch (err) {
    log.warn(`Skipping QR code for a ${url.length}-char url:`, err);
    return undefined;
  }
}

// Exported for the round-trip integration test harness — the test wires its
// own slides + ratios in and inspects the resulting PPTX bytes via JSZip.
// The hook below is still the only intended runtime caller.
//
// `deck` orders the output in lesson order and inserts placeholder slides for
// quiz / interactive scenes (see `planPptxDeck`). Without it the PPTX holds the
// slide scenes only.
/** The AIGC notices an exported deck must carry: visible label plus identifiers. */
export interface PptxAigcNotices extends AigcIdentifiers {
  /** Localized visible label; names the deck as AI-generated. */
  label: string;
}

/** Page geometry of one slide, in both the app's px and the deck's inches. */
interface PptxPageGeometry {
  viewportSize: number;
  viewportRatio: number;
  ratioPx2Inch: number;
  ratioPx2Pt: number;
}

/**
 * Stamp the visible AI-generated label on one slide.
 *
 * A deck leaves the app as a distributable copy of generated content, so
 * 《人工智能生成合成内容标识办法》article 4 applies here exactly as it does to the
 * MP4: the label sits at a corner and its character height reaches 5% of the
 * page's shorter side — the floor GB 45438-2025 sets for 图片 (§5.2) and 视频
 * (§5.4). The two are cited together on purpose: a deck is handed over as a
 * document, but any single page a customer screenshots and posts is an image,
 * so the stricter of the two readings is the one that keeps the file defensible.
 *
 * The type size is therefore not a style choice: on a 16:9 page it works out to
 * ~20pt, and anything smaller drops under the standard's floor. What *is* a
 * style choice is the corner, the box and the ink: the notice is anchored
 * bottom-right (where the interactive pages put theirs, and where slide content
 * rarely reaches), set to one tight line instead of a generously leaded one,
 * and painted mid-grey so it reads as a footer mark rather than a band across
 * the bottom of the slide.
 */
function addPptxAigcLabel(
  pptxSlide: pptxgen.Slide,
  notices: PptxAigcNotices,
  geometry: PptxPageGeometry,
): void {
  const { viewportSize, viewportRatio, ratioPx2Inch, ratioPx2Pt } = geometry;
  const pageWidthPx = viewportSize;
  const pageHeightPx = viewportSize * viewportRatio;
  // Font sizes in a deck are points; the geometry constants are px per inch/pt.
  const fontSizePt = aigcLabelFontPx(pageWidthPx, pageHeightPx) / ratioPx2Pt;
  const pageWidthIn = pageWidthPx / ratioPx2Inch;
  const pageHeightIn = pageHeightPx / ratioPx2Inch;
  const insetIn = pageWidthIn * 0.02;
  // One line of CJK glyphs needs about 1.05em; 1.15 leaves a hair of air so the
  // box never clips, without the 1.5 that used to make the strip half again as
  // tall as the text it holds.
  const boxHeightIn = (fontSizePt * ratioPx2Pt * 1.15) / ratioPx2Inch;
  const boxWidthIn = pageWidthIn * 0.45;
  pptxSlide.addText(notices.label, {
    // Right-aligned so the text ends at the same inset the interactive pages
    // use: a right-aligned box in the corner leaves the slide's own bottom-left
    // (page numbers, source lines) untouched.
    x: pageWidthIn - boxWidthIn - insetIn,
    y: pageHeightIn - boxHeightIn - insetIn / 2,
    w: boxWidthIn,
    h: boxHeightIn,
    fontSize: fontSizePt,
    color: '7F7F7F',
    align: 'right',
    valign: 'middle',
    margin: 0,
  });
}

export async function buildPptxBlob(
  slides: Slide[],
  slideScenes: Scene[],
  viewportRatio: number,
  viewportSize: number,
  ratioPx2Inch: number,
  ratioPx2Pt: number,
  stageId?: string,
  deck: readonly PptxDeckEntry[] = slidesOnlyDeck(slides.length),
  aigc?: PptxAigcNotices,
): Promise<Blob> {
  const pptx = new pptxgen();
  // The hidden half of the notice (§6.1): the provider names itself as the
  // author/company of the package, and the subject carries the content id.
  if (aigc) {
    pptx.author = aigc.provider;
    pptx.company = aigc.provider;
    pptx.subject = `${aigc.label} | ${aigc.provider} | ${aigc.contentId}`;
  }
  const pageGeometry: PptxPageGeometry = {
    viewportSize,
    viewportRatio,
    ratioPx2Inch,
    ratioPx2Pt,
  };
  const documentElements = slides.flatMap((slide) => slide.elements);
  const manifestRefs = derivePptxMediaReferenceSet(slides);
  assertPptxMediaReferenceParity(slides, manifestRefs);
  const resolveManifestMedia = (
    ref: string | undefined,
    task: MediaTaskState | undefined,
  ): Promise<string> => {
    // A generated task may supply a concrete poster URL that is runtime
    // metadata rather than a document ref. Preserve that established fallback;
    // every document-owned ref must still come from the manifest.
    if (isPptxManifestForeignRef(ref, manifestRefs, task)) {
      throw new Error(`PPTX layout attempted to resolve a ref outside the asset manifest: ${ref}`);
    }
    return resolvePptxEmbeddableSrc(ref, task, stageId);
  };

  // Set layout based on aspect ratio
  if (viewportRatio === 0.625) pptx.layout = 'LAYOUT_16x10';
  else if (viewportRatio === 0.75) pptx.layout = 'LAYOUT_4x3';
  else pptx.layout = 'LAYOUT_16x9';

  const slideNumbers = pptxSlideNumbers(deck, slides);
  const placeholderStyle = placeholderStyleFor(slides);
  /** Slides the visible AIGC label is stamped on, once every element is placed. */
  const aigcSlides: pptxgen.Slide[] = [];

  for (const entry of deck) {
    const pptxSlide = pptx.addSlide();

    if (entry.kind === 'placeholder') {
      // Quiz narration often explains the answers, so it stays out of the
      // notes; interactive scenes keep theirs.
      if (entry.placeholder.sceneType === 'interactive') {
        const notes = buildSpeakerNotes(entry.placeholder.scene);
        if (notes) pptxSlide.addNotes(notes);
      }
      const onlineUrl = entry.placeholder.online?.url;
      renderScenePlaceholder(
        pptxSlide,
        entry.placeholder,
        placeholderStyle,
        { viewportSize, viewportRatio },
        { ratioPx2Inch, ratioPx2Pt },
        onlineUrl ? await qrDataUrlFor(onlineUrl) : undefined,
      );
      if (aigc) aigcSlides.push(pptxSlide);
      continue;
    }

    const slideIdx = entry.slideIndex;
    const slide = slides[slideIdx];

    // ── Speaker Notes ──
    const scene = slideScenes[slideIdx];
    if (scene) {
      const notes = buildSpeakerNotes(scene);
      if (notes) pptxSlide.addNotes(notes);
    }

    // ── Background ──
    if (slide.background) {
      const bg = slide.background;
      if (bg.type === 'image' && bg.image) {
        const resolvedSrc = await resolveManifestMedia(bg.image.src, undefined);
        if (!resolvedSrc) {
          // Missing generated backgrounds stay empty instead of leaking an opaque ref to pptxgen.
        } else if (isSVGImage(resolvedSrc)) {
          pptxSlide.addImage({
            data: resolvedSrc,
            x: 0,
            y: 0,
            w: viewportSize / ratioPx2Inch,
            h: (viewportSize * viewportRatio) / ratioPx2Inch,
          });
        } else if (isBase64Image(resolvedSrc)) {
          pptxSlide.background = { data: resolvedSrc };
        } else {
          pptxSlide.background = { path: resolvedSrc };
        }
      } else if (bg.type === 'solid' && bg.color) {
        const c = formatColor(bg.color);
        pptxSlide.background = {
          color: c.color,
          transparency: (1 - c.alpha) * 100,
        };
      } else if (bg.type === 'gradient' && bg.gradient) {
        const colors = bg.gradient.colors;
        const color1 = colors[0].color;
        const color2 = colors[colors.length - 1].color;
        const mixed = tinycolor.mix(color1, color2).toHexString();
        const c = formatColor(mixed);
        pptxSlide.background = {
          color: c.color,
          transparency: (1 - c.alpha) * 100,
        };
      }
    }

    // Stamped after the background and the slide's own elements, so neither
    // the background nor a full-bleed image can cover it.
    if (aigc) aigcSlides.push(pptxSlide);

    if (!slide.elements) continue;

    // ── Elements ──
    for (const sourceElement of slide.elements) {
      // Export the same bounded text projection that playback uses, including
      // historical shapes whose geometry cannot be parsed or scaled safely.
      const el =
        sourceElement.type === 'shape' &&
        !validateShapeGeometry(sourceElement, RENDER_PATH_LIMITS).ok
          ? shapeToTextFallback(sourceElement)
          : sourceElement;
      if (!el) continue;
      // ── TEXT ──
      if (el.type === 'text') {
        const textProps = formatHTML(el.content, ratioPx2Pt);
        const options: pptxgen.TextPropsOptions = {
          x: el.left / ratioPx2Inch,
          y: el.top / ratioPx2Inch,
          w: el.width / ratioPx2Inch,
          h: el.height / ratioPx2Inch,
          fontSize: DEFAULT_FONT_SIZE / ratioPx2Pt,
          fontFace: el.defaultFontName || DEFAULT_FONT_FAMILY,
          color: '#000000',
          valign: el.vAlign ?? 'top',
          margin: 10 / ratioPx2Pt,
          paraSpaceBefore: 5 / ratioPx2Pt,
          lineSpacingMultiple: 1.5 / 1.25,
          autoFit: true,
        };
        if (el.rotate) options.rotate = el.rotate;
        if (el.wordSpace) options.charSpacing = el.wordSpace / ratioPx2Pt;
        if (el.lineHeight) options.lineSpacingMultiple = el.lineHeight / 1.25;
        if (el.fill) {
          const c = formatColor(el.fill);
          const opacity = el.opacity === undefined ? 1 : el.opacity;
          options.fill = {
            color: c.color,
            transparency: (1 - c.alpha * opacity) * 100,
          };
        }
        if (el.defaultColor) options.color = formatColor(el.defaultColor).color;
        if (el.defaultFontName) options.fontFace = el.defaultFontName;
        if (el.shadow) options.shadow = getShadowOption(el.shadow, ratioPx2Pt);
        if (el.outline?.width) options.line = getOutlineOption(el.outline, ratioPx2Pt);
        if (el.opacity !== undefined) options.transparency = (1 - el.opacity) * 100;
        if (el.paragraphSpace !== undefined)
          options.paraSpaceBefore = el.paragraphSpace / ratioPx2Pt;
        if (el.vertical) options.vert = 'eaVert';
        pptxSlide.addText(textProps, options);
        if (el.link) {
          const hyperlink = getLinkOption(el.link, slideNumbers);
          if (hyperlink) {
            // PptxGenJS does not create a relationship for hyperlinks on a
            // rich-text box's options (it emits rIdundefined). A transparent
            // shape above the label also makes the whole element clickable.
            pptxSlide.addShape('rect' as pptxgen.ShapeType, {
              x: options.x,
              y: options.y,
              w: options.w,
              h: options.h,
              rotate: options.rotate,
              fill: { color: '#ffffff', transparency: 100 },
              line: { color: '#ffffff', transparency: 100 },
              hyperlink,
            });
          }
        }
      }

      // ── IMAGE ──
      else if (el.type === 'image') {
        // Resolve the src through the shared stored-bytes resolver (opaque
        // refs embed as data URLs; concrete addresses keep the fetch below).
        let resolvedSrc = await resolveManifestMedia(el.src, undefined);
        if (!resolvedSrc) continue;

        // Fetch and convert to base64 for embedding in PPTX
        // (blob: URLs and remote URLs won't work in offline PPTX)
        if (!isBase64Image(resolvedSrc)) {
          try {
            const resp = await fetch(resolvedSrc);
            if (!resp.ok) {
              log.warn(
                `Failed to fetch image (HTTP ${resp.status}), skipping element: ${resolvedSrc}`,
              );
              continue;
            }
            resolvedSrc = await blobToDataUrl(await resp.blob());
          } catch {
            log.warn('Failed to convert image to base64, skipping element');
            continue;
          }
        }

        const options: pptxgen.ImageProps = {
          x: el.left / ratioPx2Inch,
          y: el.top / ratioPx2Inch,
          w: el.width / ratioPx2Inch,
          h: el.height / ratioPx2Inch,
        };
        if (isBase64Image(resolvedSrc)) options.data = resolvedSrc;
        else options.path = resolvedSrc;

        if (el.flipH) options.flipH = el.flipH;
        if (el.flipV) options.flipV = el.flipV;
        if (el.rotate) options.rotate = el.rotate;
        if (el.link) {
          const linkOption = getLinkOption(el.link, slideNumbers);
          if (linkOption) options.hyperlink = linkOption;
        }
        if (el.filters?.opacity) options.transparency = 100 - parseInt(el.filters.opacity);
        if (el.clip) {
          if (el.clip.shape === 'ellipse') options.rounding = true;

          const [start, end] = el.clip.range;
          const [startX, startY] = start;
          const [endX, endY] = end;

          const originW = el.width / ((endX - startX) / ratioPx2Inch);
          const originH = el.height / ((endY - startY) / ratioPx2Inch);

          options.w = originW / ratioPx2Inch;
          options.h = originH / ratioPx2Inch;

          options.sizing = {
            type: 'crop',
            x: ((startX / ratioPx2Inch) * originW) / ratioPx2Inch,
            y: ((startY / ratioPx2Inch) * originH) / ratioPx2Inch,
            w: (((endX - startX) / ratioPx2Inch) * originW) / ratioPx2Inch,
            h: (((endY - startY) / ratioPx2Inch) * originH) / ratioPx2Inch,
          };
        }

        pptxSlide.addImage(options);
      }

      // ── SHAPE ──
      else if (el.type === 'shape') {
        if (el.special) {
          // Special shapes: render as SVG image
          // Create a temporary SVG element from the path
          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('xmlns', svgNS);
          svg.setAttribute('viewBox', `0 0 ${el.viewBox[0]} ${el.viewBox[1]}`);
          svg.setAttribute('width', String(el.width));
          svg.setAttribute('height', String(el.height));

          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', el.path);
          path.setAttribute('fill', el.fill || 'none');
          if (el.outline?.color) {
            path.setAttribute('stroke', el.outline.color);
            path.setAttribute('stroke-width', String(el.outline.width || 1));
          }
          svg.appendChild(path);

          const base64SVG = svg2Base64(svg);

          const imgOptions: pptxgen.ImageProps = {
            data: base64SVG,
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
          };
          if (el.rotate) imgOptions.rotate = el.rotate;
          if (el.flipH) imgOptions.flipH = el.flipH;
          if (el.flipV) imgOptions.flipV = el.flipV;
          if (el.link) {
            const linkOption = getLinkOption(el.link, slideNumbers);
            if (linkOption) imgOptions.hyperlink = linkOption;
          }
          pptxSlide.addImage(imgOptions);
        } else {
          const scale = {
            x: el.width / el.viewBox[0],
            y: el.height / el.viewBox[1],
          };
          const rawPoints = toPoints(el.path);
          if (!rawPoints.length) continue; // Malformed path — toPoints already logged.
          const points = formatPoints(rawPoints, ratioPx2Inch, scale);

          let fillColor = formatColor(el.fill);
          if (el.gradient) {
            const colors = el.gradient.colors;
            const color1 = colors[0].color;
            const color2 = colors[colors.length - 1].color;
            const mixed = tinycolor.mix(color1, color2).toHexString();
            fillColor = formatColor(mixed);
          }
          if (el.pattern) fillColor = formatColor('#00000000');
          const opacity = el.opacity === undefined ? 1 : el.opacity;

          const shapeOptions: pptxgen.ShapeProps = {
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
            fill: {
              color: fillColor.color,
              transparency: (1 - fillColor.alpha * opacity) * 100,
            },
            points,
          };
          if (el.flipH) shapeOptions.flipH = el.flipH;
          if (el.flipV) shapeOptions.flipV = el.flipV;
          if (el.shadow) shapeOptions.shadow = getShadowOption(el.shadow, ratioPx2Pt);
          if (el.outline?.width) shapeOptions.line = getOutlineOption(el.outline, ratioPx2Pt);
          if (el.rotate) shapeOptions.rotate = el.rotate;
          if (el.link) {
            const linkOption = getLinkOption(el.link, slideNumbers);
            if (linkOption) shapeOptions.hyperlink = linkOption;
          }

          pptxSlide.addShape('custGeom' as pptxgen.ShapeType, shapeOptions);
        }

        // Shape text overlay
        if (el.text) {
          const textProps = formatHTML(el.text.content, ratioPx2Pt);
          const textOptions: pptxgen.TextPropsOptions = {
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
            fontSize: DEFAULT_FONT_SIZE / ratioPx2Pt,
            fontFace: DEFAULT_FONT_FAMILY,
            color: '#000000',
            paraSpaceBefore: 5 / ratioPx2Pt,
            valign: el.text.align,
          };
          if (el.rotate) textOptions.rotate = el.rotate;
          if (el.text.defaultColor) textOptions.color = formatColor(el.text.defaultColor).color;
          if (el.text.defaultFontName) textOptions.fontFace = el.text.defaultFontName;

          pptxSlide.addText(textProps, textOptions);
        }

        // Pattern overlay
        if (el.pattern) {
          const patternOptions: pptxgen.ImageProps = {
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
          };
          if (isBase64Image(el.pattern)) patternOptions.data = el.pattern;
          else patternOptions.path = el.pattern;

          if (el.flipH) patternOptions.flipH = el.flipH;
          if (el.flipV) patternOptions.flipV = el.flipV;
          if (el.rotate) patternOptions.rotate = el.rotate;
          if (el.link) {
            const linkOption = getLinkOption(el.link, slideNumbers);
            if (linkOption) patternOptions.hyperlink = linkOption;
          }
          pptxSlide.addImage(patternOptions);
        }
      }

      // ── LINE ──
      else if (el.type === 'line') {
        const path = getLineElementPath(el);
        const { minX, maxX, minY, maxY } = getElementRange(el);
        // Custom geometry points are relative to its bounding box, which need
        // not begin at the element origin (negative controls / offset endpoints).
        const points = formatPoints(toPoints(path), ratioPx2Inch, undefined, {
          x: minX - el.left,
          y: minY - el.top,
        });
        const c = formatColor(el.color);

        const lineOptions: pptxgen.ShapeProps = {
          x: minX / ratioPx2Inch,
          y: minY / ratioPx2Inch,
          w: (maxX - minX) / ratioPx2Inch,
          h: (maxY - minY) / ratioPx2Inch,
          line: {
            color: c.color,
            transparency: (1 - c.alpha) * 100,
            width: el.width / ratioPx2Pt,
            dashType: dashTypeMap[el.style] as 'solid' | 'dash' | 'sysDot',
            beginArrowType: el.points[0] ? 'arrow' : 'none',
            endArrowType: el.points[1] ? 'arrow' : 'none',
          },
          points,
        };
        if (el.shadow) lineOptions.shadow = getShadowOption(el.shadow, ratioPx2Pt);

        pptxSlide.addShape('custGeom' as pptxgen.ShapeType, lineOptions);
      }

      // ── CHART ──
      else if (el.type === 'chart') {
        const chartData = [];
        for (let i = 0; i < el.data.series.length; i++) {
          const item = el.data.series[i];
          chartData.push({
            name: `Series ${i + 1}`,
            labels: el.data.labels,
            values: item,
          });
        }

        let chartColors: string[] = [];
        if (el.themeColors.length === 10) {
          chartColors = el.themeColors.map((c) => formatColor(c).color);
        } else if (el.themeColors.length === 1) {
          chartColors = tinycolor(el.themeColors[0])
            .analogous(10)
            .map((c) => formatColor(c.toHexString()).color);
        } else {
          const len = el.themeColors.length;
          const supplement = tinycolor(el.themeColors[len - 1])
            .analogous(10 + 1 - len)
            .map((c) => c.toHexString());
          chartColors = [...el.themeColors.slice(0, len - 1), ...supplement].map(
            (c) => formatColor(c).color,
          );
        }

        const chartOptions: pptxgen.IChartOpts = {
          x: el.left / ratioPx2Inch,
          y: el.top / ratioPx2Inch,
          w: el.width / ratioPx2Inch,
          h: el.height / ratioPx2Inch,
          chartColors:
            el.chartType === 'pie' || el.chartType === 'ring'
              ? chartColors
              : chartColors.slice(0, el.data.series.length),
        };

        const textColor = formatColor(el.textColor || '#000000').color;
        chartOptions.catAxisLabelColor = textColor;
        chartOptions.valAxisLabelColor = textColor;

        const fontSize = 14 / ratioPx2Pt;
        chartOptions.catAxisLabelFontSize = fontSize;
        chartOptions.valAxisLabelFontSize = fontSize;

        if (el.fill || el.outline) {
          const plotArea: pptxgen.IChartPropsFillLine = {};
          if (el.fill) plotArea.fill = { color: formatColor(el.fill).color };
          if (el.outline) {
            plotArea.border = {
              pt: el.outline.width! / ratioPx2Pt,
              color: formatColor(el.outline.color!).color,
            };
          }
          chartOptions.plotArea = plotArea;
        }

        if (
          (el.data.series.length > 1 && el.chartType !== 'scatter') ||
          el.chartType === 'pie' ||
          el.chartType === 'ring'
        ) {
          chartOptions.showLegend = true;
          chartOptions.legendPos = 'b';
          chartOptions.legendColor = textColor;
          chartOptions.legendFontSize = fontSize;
        }

        let type = pptx.ChartType.bar;
        if (el.chartType === 'bar') {
          type = pptx.ChartType.bar;
          chartOptions.barDir = 'col';
          if (el.options?.stack) chartOptions.barGrouping = 'stacked';
        } else if (el.chartType === 'column') {
          type = pptx.ChartType.bar;
          chartOptions.barDir = 'bar';
          if (el.options?.stack) chartOptions.barGrouping = 'stacked';
        } else if (el.chartType === 'line') {
          type = pptx.ChartType.line;
          if (el.options?.lineSmooth) chartOptions.lineSmooth = true;
        } else if (el.chartType === 'area') {
          type = pptx.ChartType.area;
        } else if (el.chartType === 'radar') {
          type = pptx.ChartType.radar;
        } else if (el.chartType === 'scatter') {
          type = pptx.ChartType.scatter;
          chartOptions.lineSize = 0;
        } else if (el.chartType === 'pie') {
          type = pptx.ChartType.pie;
        } else if (el.chartType === 'ring') {
          type = pptx.ChartType.doughnut;
          chartOptions.holeSize = 60;
        }

        pptxSlide.addChart(type, chartData, chartOptions);
      }

      // ── TABLE ──
      else if (el.type === 'table') {
        const hiddenCells: string[] = [];
        for (let i = 0; i < el.data.length; i++) {
          const rowData = el.data[i];
          for (let j = 0; j < rowData.length; j++) {
            const cell = rowData[j];
            if (cell.colspan > 1 || cell.rowspan > 1) {
              for (let row = i; row < i + cell.rowspan; row++) {
                for (let col = row === i ? j + 1 : j; col < j + cell.colspan; col++) {
                  hiddenCells.push(`${row}_${col}`);
                }
              }
            }
          }
        }

        const tableData: pptxgen.TableRow[] = [];

        const theme = el.theme;
        let themeColor: FormatColor | null = null;
        let subThemeColors: FormatColor[] = [];
        if (theme) {
          themeColor = formatColor(theme.color);
          subThemeColors = getTableSubThemeColor(theme.color).map((item) => formatColor(item));
        }

        for (let i = 0; i < el.data.length; i++) {
          const row = el.data[i];
          const _row: pptxgen.TableCell[] = [];

          for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            const cellOptions: pptxgen.TableCellProps = {
              colspan: cell.colspan,
              rowspan: cell.rowspan,
              bold: cell.style?.bold || false,
              italic: cell.style?.em || false,
              underline: { style: cell.style?.underline ? 'sng' : 'none' },
              align: cell.style?.align || 'left',
              valign: 'middle',
              fontFace: cell.style?.fontname || DEFAULT_FONT_FAMILY,
              fontSize: (cell.style?.fontsize ? parseInt(cell.style.fontsize) : 14) / ratioPx2Pt,
            };
            if (theme && themeColor) {
              let c: FormatColor;
              if (i % 2 === 0) c = subThemeColors[1];
              else c = subThemeColors[0];

              if (theme.rowHeader && i === 0) c = themeColor;
              else if (theme.rowFooter && i === el.data.length - 1) c = themeColor;
              else if (theme.colHeader && j === 0) c = themeColor;
              else if (theme.colFooter && j === row.length - 1) c = themeColor;

              cellOptions.fill = {
                color: c.color,
                transparency: (1 - c.alpha) * 100,
              };
            }
            if (cell.style?.backcolor) {
              const c = formatColor(cell.style.backcolor);
              cellOptions.fill = {
                color: c.color,
                transparency: (1 - c.alpha) * 100,
              };
            }
            if (cell.style?.color) cellOptions.color = formatColor(cell.style.color).color;

            if (!hiddenCells.includes(`${i}_${j}`)) {
              _row.push({ text: proseToPlainText(cell.text), options: cellOptions });
            }
          }
          if (_row.length) tableData.push(_row);
        }

        const tableOptions: pptxgen.TableProps = {
          x: el.left / ratioPx2Inch,
          y: el.top / ratioPx2Inch,
          w: el.width / ratioPx2Inch,
          h: el.height / ratioPx2Inch,
          colW: el.colWidths.map((item) => (el.width * item) / ratioPx2Inch),
        };
        if (el.theme) tableOptions.fill = { color: '#ffffff' };
        if (el.outline?.width && el.outline?.color) {
          tableOptions.border = {
            type: el.outline.style === 'solid' ? 'solid' : 'dash',
            pt: el.outline.width / ratioPx2Pt,
            color: formatColor(el.outline.color).color,
          };
        }

        pptxSlide.addTable(tableData, tableOptions);
      }

      // ── LATEX ──
      else if (el.type === 'latex') {
        // Try native OMML formula first (editable in PowerPoint)
        // Estimate line count from \\ line breaks to compute a fitting font size.
        // Formula rendered height ≈ lines * 1.5 * fontSize, so fontSize ≈ boxHeight / (lines * 1.5)
        const lineBreaks = (el.latex?.match(/\\\\/g) || []).length;
        const lines = lineBreaks + 1;
        const boxHeightPt = el.height / ratioPx2Pt;
        const fontSize = Math.round(boxHeightPt / (lines * 3));
        const omml = el.latex ? latexToOmml(el.latex, fontSize) : null;

        if (omml) {
          pptxSlide.addFormula({
            omml,
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
            fontSize,
            align: el.align,
          });
        } else if (el.path) {
          // Fallback: render as SVG image (non-editable)
          const range = getSvgPathRange(el.path);
          const sw = el.strokeWidth || 0;
          const vbX = range.minX - sw;
          const vbY = range.minY - sw;
          const vbW = range.maxX - range.minX + sw * 2;
          const vbH = range.maxY - range.minY + sw * 2;

          const svgNS = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(svgNS, 'svg');
          svg.setAttribute('xmlns', svgNS);
          svg.setAttribute('width', String(el.width));
          svg.setAttribute('height', String(el.height));
          svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
          svg.setAttribute('stroke', el.color || '#000000');
          svg.setAttribute('stroke-width', String(sw));
          svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke-linecap', 'round');
          svg.setAttribute('stroke-linejoin', 'round');

          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', el.path);
          svg.appendChild(path);

          const base64SVG = svg2Base64(svg);
          if (!base64SVG) continue;

          const latexOptions: pptxgen.ImageProps = {
            data: base64SVG,
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
          };
          if (el.link) {
            const linkOption = getLinkOption(el.link, slideNumbers);
            if (linkOption) latexOptions.hyperlink = linkOption;
          }

          pptxSlide.addImage(latexOptions);
        }
      }

      // ── VIDEO / AUDIO ──
      else if (el.type === 'video' || el.type === 'audio') {
        const videoBinding =
          el.type === 'video'
            ? resolveVideoMediaForElement(
                useMediaGenerationStore.getState().tasks,
                el,
                stageId,
                documentElements,
              )
            : undefined;
        const sourceRef = videoBinding?.sourceRef ?? el.src;
        const resolvedSrc = await resolveManifestMedia(sourceRef, videoBinding?.task);

        if (!resolvedSrc) continue;

        // Fetch blob and convert to base64 for embedding in PPTX
        // (blob: URLs and remote URLs won't work in offline PPTX)
        try {
          const base64 = isBase64Image(resolvedSrc)
            ? resolvedSrc
            : await (async () => {
                const resp = await fetch(resolvedSrc);
                if (!resp.ok) {
                  throw new Error(`Failed to fetch media (HTTP ${resp.status}): ${resolvedSrc}`);
                }
                return blobToDataUrl(await resp.blob());
              })();

          const mediaOptions: pptxgen.MediaProps = {
            x: el.left / ratioPx2Inch,
            y: el.top / ratioPx2Inch,
            w: el.width / ratioPx2Inch,
            h: el.height / ratioPx2Inch,
            data: base64,
            type: el.type,
          };

          // Determine file extension
          const extMatch = resolvedSrc.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
          if (extMatch && extMatch[1]) mediaOptions.extn = extMatch[1];
          else if (el.ext) mediaOptions.extn = el.ext;
          else mediaOptions.extn = el.type === 'video' ? 'mp4' : 'mp3';

          // Generate cover image for video
          if (el.type === 'video') {
            let coverBase64: string | undefined;

            // 1. Try the poster the element (or its generation task) names,
            // resolved through the same shared chain as the media itself.
            const posterSrc = await resolveManifestMedia(
              videoBinding?.posterRef,
              videoBinding?.posterTask,
            );
            if (posterSrc) {
              if (isBase64Image(posterSrc)) {
                coverBase64 = posterSrc;
              } else {
                try {
                  const posterResp = await fetch(posterSrc);
                  if (!posterResp.ok) {
                    log.warn(`Failed to fetch poster (HTTP ${posterResp.status}), skipping`);
                  } else {
                    coverBase64 = await blobToDataUrl(await posterResp.blob());
                  }
                } catch {
                  // Poster fetch failed, fall through to video frame capture
                }
              }
            }

            // 2. Fallback: capture first frame from video via canvas
            if (!coverBase64) {
              try {
                coverBase64 = await new Promise<string>((resolve, reject) => {
                  const video = document.createElement('video');
                  video.crossOrigin = 'anonymous';
                  video.muted = true;
                  video.preload = 'auto';
                  video.onloadeddata = () => {
                    video.currentTime = 0;
                  };
                  video.onseeked = () => {
                    try {
                      const canvas = document.createElement('canvas');
                      canvas.width = video.videoWidth || el.width;
                      canvas.height = video.videoHeight || el.height;
                      const ctx = canvas.getContext('2d');
                      if (ctx) {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/png'));
                      } else {
                        reject(new Error('No canvas context'));
                      }
                      video.src = ''; // Release
                    } catch (e) {
                      reject(e);
                    }
                  };
                  video.onerror = () => reject(new Error('Video load failed'));
                  // Timeout to avoid hanging
                  setTimeout(() => reject(new Error('Video frame capture timeout')), 10000);
                  video.src = resolvedSrc;
                });
              } catch {
                // Frame capture also failed, video will use default play button
              }
            }

            if (coverBase64) mediaOptions.cover = coverBase64;
          }

          pptxSlide.addMedia(mediaOptions);
        } catch (err) {
          log.warn(`Failed to embed ${el.type} element:`, err);
        }
      }
    }
  }

  // Last, so the label is the topmost shape on every page.
  if (aigc) {
    for (const pptxSlide of aigcSlides) addPptxAigcLabel(pptxSlide, aigc, pageGeometry);
  }

  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

// ── Resource Pack assembly (PPTX + interactive HTML pages as ZIP) ──
// Pure/async builder extracted from the hook so the assembly logic — which
// scenes make it into the ZIP, whether the PPTX builder runs — is unit-testable
// without a React/jsdom harness. The hook stays the only runtime caller.
//
// `getPptxBlob` is invoked whenever the lesson has a scene that gets a PPTX
// slide (`pptxDeckScenes`): a slide, a quiz, a PBL project or an interactive
// page, or only a slide for a slides-only export. With placeholders, every
// shipped HTML page has a placeholder slide, so a non-empty pack holds a PPTX;
// slides only, a lesson without slides ships its HTML pages alone
// (`skippedPptx`). Returns `empty: true` (and a null blob) when there is
// nothing to ship. The HTML page paths come from
// `listInteractivePages`, the same list the PPTX placeholder links use.

export interface ResourcePackResult {
  /** Generated ZIP blob, or null when there is nothing to ship. */
  blob: Blob | null;
  /** True when no scene could be exported (no PPTX slide, no HTML page). */
  empty: boolean;
  /**
   * True when the pack ships HTML pages without a PPTX: placeholder slides
   * are not wanted and the lesson has no slide scene.
   */
  skippedPptx: boolean;
  /** External asset URLs that could not be inlined into the HTML pages. */
  failedAssetUrls: string[];
}

export async function buildResourcePackZip(
  scenes: Scene[],
  opts: {
    viewportRatio: number;
    viewportSize: number;
    ratioPx2Inch: number;
    ratioPx2Pt: number;
    fileName: string;
    /** Called only when the lesson has PPTX content; produces the PPTX blob. */
    getPptxBlob: () => Promise<Blob>;
    /**
     * Produces the quiz booklet, or null when the lesson has no quiz. Called
     * only when there is something to write, so a quiz-less lesson never pays
     * for rendering one.
     */
    getQuizBooklet?: () => { path: string; html: string } | null;
    /** Whether the PPTX includes placeholder slides (default true). */
    includePlaceholders?: boolean;
    /** Passed through to `inlineHtmlAssets`; tests inject a no-op fetcher. */
    fetcher?: FetchAsset;
  },
): Promise<ResourcePackResult> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const failedAssetUrls: string[] = [];

  const hasPptx =
    pptxDeckScenes(scenes, { includePlaceholders: opts.includePlaceholders }).length > 0;
  const pages = listInteractivePages(scenes);

  // Nothing to ship: no PPTX slide and no interactive page.
  if (!hasPptx && pages.length === 0) {
    return { blob: null, empty: true, skippedPptx: false, failedAssetUrls };
  }

  // 1. Add interactive HTML pages
  for (const page of pages) {
    const { html: inlinedHtml, report } = await inlineHtmlAssets(page.html, {
      fetcher: opts.fetcher,
    });
    for (const f of report.failed) {
      if (!failedAssetUrls.includes(f.url)) failedAssetUrls.push(f.url);
    }
    zip.file(page.path, inlinedHtml);
  }

  // 2. Generate the PPTX (slides, plus placeholders unless slides only).
  if (hasPptx) {
    const pptxBlob = await opts.getPptxBlob();
    // Convert to ArrayBuffer so jszip stores a plain byte buffer rather than a
    // Blob (which it can't reliably round-trip outside the browser).
    zip.file(`${opts.fileName}.pptx`, await pptxBlob.arrayBuffer());
  }

  // 3. Add the quiz booklet. Its questions reach the customer no other way:
  // a quiz scene has no HTML of its own, and the deck's placeholder slide is
  // deliberately answer-free.
  const booklet = opts.getQuizBooklet?.();
  if (booklet) zip.file(booklet.path, booklet.html);

  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, empty: false, skippedPptx: !hasPptx, failedAssetUrls };
}

// ── Hook ──

export interface UseExportPPTXOptions {
  /**
   * Origin the placeholder slides link to (`<origin>/classroom/<id>`).
   * Defaults to the page's own origin; hosts serving the classroom elsewhere
   * can override it.
   */
  classroomOrigin?: string;
}

/** Per-export choices, made in the export menu. */
export interface PptxExportChoice {
  /**
   * Whether the PPTX includes placeholder slides for quiz, interactive and
   * PBL scenes (default true). When false it holds the slide scenes only.
   */
  includePlaceholders?: boolean;
}

/**
 * What the handover is for. Re-exported so callers keep one import path; both
 * tiers ship the same numbered files, and the difference is the video (teaching
 * only) versus the opening frame (competition only).
 */
export type { DeliverySku };

export function useExportPPTX({ classroomOrigin }: UseExportPPTXOptions = {}) {
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const { t, locale } = useI18n();
  const brand = useBrand();

  const scenes = useStageStore((s) => s.scenes);
  const stage = useStageStore((s) => s.stage);
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  const ratioPx2Inch = 96 * (viewportSize / 960);
  const ratioPx2Pt = (96 / 72) * (viewportSize / 960);

  const slideScenes = scenes.filter((s) => s.content.type === 'slide');
  const slides = slideScenes.map((s) => (s.content as SlideContent).canvas);

  // Every exported deck carries the AIGC notice unless the operator turned it
  // off for this deployment: a deck is a distributable copy of generated
  // content, in the same scope as the exported MP4. The classroom id doubles as
  // the per-content number (§6.1). `undefined` is what every downstream builder
  // treats as "no notice", so the switch has exactly one expression per path.
  const deckAigcNotices = useCallback((): PptxAigcNotices | undefined => {
    if (!isAigcLabelEnabled()) return undefined;
    return {
      label: t('export.aigcLabel'),
      ...resolveAigcIdentifiers(
        // §6.1 wants the service provider's name, and a branded deployment is
        // the provider until the operator names a legal entity explicitly.
        process.env.NEXT_PUBLIC_AIGC_PROVIDER || brand.productName,
        process.env.NEXT_PUBLIC_AIGC_CONTENT_ID,
        stage?.id ?? 'unknown',
      ),
    };
  }, [t, stage?.id, brand.productName]);

  // The online classroom page the placeholder slides link to (button + QR
  // code). Anyone with the link can open a classroom, so no status lookup is
  // needed; without a stage id there is nothing to link to.
  const getClassroomUrl = useCallback(
    () =>
      stage?.id ? classroomPageUrl(classroomOrigin ?? window.location.origin, stage.id) : undefined,
    [stage?.id, classroomOrigin],
  );

  // Shared guard + state wrapper for export actions.
  // `hasPptxContent` is passed by actions that need something to put in the
  // PPTX: slides, quizzes, PBL projects and interactive pages all become PPTX
  // slides (only slides when placeholders are off). The resource pack reports
  // an empty lesson itself via `result.empty`. When the guard rejects, callers
  // get a toast instead of silence.
  const withExportGuard = useCallback(
    (
      action: (target: SaveTarget) => Promise<void>,
      hasPptxContent = true,
      saveId: string = SAVE_DIR_IDS.slides,
    ) => {
      if (exportingRef.current) return;
      if (!hasPptxContent) {
        toast.warning(t('export.noSlides'));
        return;
      }
      exportingRef.current = true;
      setExporting(true);
      // The folder picker is opened here, in the caller's task: the
      // `setTimeout` below (which yields the UI thread so the spinner paints)
      // would otherwise spend the click's user activation, and the picker
      // would be refused. Only the heavy work moves off the click's task.
      void (async () => {
        const target = await resolveSaveTarget(saveId);
        if (!target) {
          exportingRef.current = false;
          setExporting(false);
          return;
        }
        setTimeout(async () => {
          try {
            await action(target);
          } catch (err) {
            log.error('Export failed:', err);
            // The bundle fails for reasons the generic sentence cannot express —
            // two pages that share a name, a pack with no deck — and the
            // operator is the one who has to fix it. Naming the reason in the
            // second line beats "export failed" plus a console hunt.
            toast.error(t('export.exportFailed'), {
              description: err instanceof Error && err.message ? err.message : undefined,
            });
          } finally {
            exportingRef.current = false;
            setExporting(false);
          }
        }, 100);
      })();
    },
    [t],
  );

  // ── Export PPTX only ──
  const exportPPTX = useCallback(
    ({ includePlaceholders = true }: PptxExportChoice = {}) => {
      withExportGuard(
        async (target) => {
          const fileName = stage?.name || 'slides';
          // No Resource Pack next to a standalone PPTX, so placeholders link to
          // the online classroom only (no offline copy to point at). In
          // offline-only mode they lose that link too: a placeholder slide
          // that names its scene is still useful, a QR code pointing at a
          // classroom the reader cannot reach is not. `planPptxDeck` swaps the
          // sentence above the links for one that sends the reader to whoever
          // sent the deck — it must not promise a local copy this file cannot
          // contain.
          const deck = planPptxDeck(scenes, t, {
            linkInteractivePages: false,
            classroomUrl: getClassroomUrl(),
            includePlaceholders,
            offlineOnlyLinks: isOfflineOnlyLinks(),
          });
          const blob = await buildPptxBlob(
            slides,
            slideScenes,
            viewportRatio,
            viewportSize,
            ratioPx2Inch,
            ratioPx2Pt,
            stage?.id,
            deck,
            deckAigcNotices(),
          );
          await writeSaveTarget(target, `${fileName}.pptx`, blob);
          toast.success(t('export.exportSuccess'));
        },
        pptxDeckScenes(scenes, { includePlaceholders }).length > 0,
      );
    },
    [
      withExportGuard,
      getClassroomUrl,
      slides,
      slideScenes,
      scenes,
      stage,
      viewportSize,
      viewportRatio,
      ratioPx2Inch,
      ratioPx2Pt,
      t,
      deckAigcNotices,
    ],
  );

  // ── The pack both exports below start from ──
  // Written once, from one pass over the scene list: the deck, the interactive
  // pages and the quiz booklet must never come from two different traversals,
  // or a quiz could link to a section the booklet does not have.
  const buildPack = useCallback(
    (
      includePlaceholders: boolean,
      // The pack and the bundle both ship the pages next to the deck, but only
      // the bundle is built *for a handover*: its reader is someone whose machine
      // we will never see, so an online button pointing at this operator's
      // deployment is a dead link and the QR beside it scans into nothing. The
      // resource pack keeps following the operator's own preference.
      offlineOnlyLinks = isOfflineOnlyLinks(),
    ) => {
      const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });
      const classroomUrl = getClassroomUrl();
      return buildResourcePackZip(scenes, {
        viewportRatio,
        viewportSize,
        ratioPx2Inch,
        ratioPx2Pt,
        fileName: stage?.name || 'slides',
        fetcher: sharedFetcher,
        getPptxBlob: () =>
          buildPptxBlob(
            slides,
            slideScenes,
            viewportRatio,
            viewportSize,
            ratioPx2Inch,
            ratioPx2Pt,
            stage?.id,
            planPptxDeck(scenes, t, {
              linkInteractivePages: true,
              classroomUrl,
              includePlaceholders,
              // The pack and the bundle both carry the pages next to the deck,
              // so they can survive without the online classroom at all.
              offlineOnlyLinks,
            }),
            deckAigcNotices(),
          ),
        // The booklet is the only copy of a quiz the customer can open offline,
        // and the deck links to it, so the two must be written from the same
        // scene list in the same pass.
        getQuizBooklet: () => {
          const sections = listQuizBookletSections(scenes);
          if (sections.length === 0) return null;
          const notices = deckAigcNotices();
          return {
            path: quizBookletPath(t('export.quiz.bookletTitle')),
            html: renderQuizBooklet({
              sections,
              notices: notices ?? null,
              text: {
                title: t('export.quiz.bookletTitle'),
                answerSection: t('export.quiz.answerSection'),
                questionNumber: t('export.quiz.questionNumber'),
                questionCount: t('export.quiz.questionCount'),
                // The booklet reuses the names the player and the quiz editor
                // already give these concepts.
                typeLabel: {
                  single: t('quiz.singleChoice'),
                  multiple: t('quiz.multipleChoice'),
                  short_answer: t('quiz.shortAnswer'),
                },
                pointsSuffix: t('quiz.pointsSuffix'),
                answerKey: t('export.htmlPlayer.quizReferenceAnswer'),
                noAnswer: t('export.htmlPlayer.quizNoReferenceAnswer'),
                analysis: t('export.htmlPlayer.quizExplanation'),
                gradingPoints: t('edit.quiz.commentPromptLabel'),
                aigcLabel: notices?.label ?? '',
                lang: locale,
                generator: brand.productName,
              },
            }),
          };
        },
        includePlaceholders,
      });
    },
    [
      scenes,
      slides,
      slideScenes,
      stage,
      viewportRatio,
      viewportSize,
      ratioPx2Inch,
      ratioPx2Pt,
      getClassroomUrl,
      t,
      locale,
      brand.productName,
      deckAigcNotices,
    ],
  );

  // ── Export Resource Pack (PPTX + HTML pages + quiz booklet as ZIP) ──
  // No PPTX-content check in the guard: `buildResourcePackZip` reports an
  // empty lesson itself and the hook shows "nothing to export".
  const exportResourcePack = useCallback(
    ({ includePlaceholders = true }: PptxExportChoice = {}) => {
      withExportGuard(async (target) => {
        const fileName = stage?.name || 'slides';
        const result = await buildPack(includePlaceholders);

        if (result.empty) {
          toast.warning(t('export.nothingToExport'));
          return;
        }
        if (result.skippedPptx) {
          toast.info(t('export.noSlidesSkipped'));
        }
        await writeSaveTarget(target, `${fileName}.zip`, result.blob!);
        toast.success(t('export.exportSuccess'));
        if (result.failedAssetUrls.length > 0) {
          log.warn(
            'Resource Pack: some interactive-scene assets could not be inlined:',
            result.failedAssetUrls,
          );
          const hosts = [
            ...new Set(
              result.failedAssetUrls.map((u) => {
                try {
                  return new URL(u).host;
                } catch {
                  return u;
                }
              }),
            ),
          ];
          toast.warning(t('export.inlinePartial', { count: result.failedAssetUrls.length }), {
            description: hosts.join(', '),
          });
        }
      });
    },
    [withExportGuard, buildPack, stage, t],
  );

  // ── Export Delivery Bundle (the pack plus script and subtitles, merged) ──
  // One click, because the alternative is what the operator does today: export
  // the pack, export the script twice, export the subtitles, then merge them by
  // hand. The merge needs no server: every part is built from the same stage in
  // the same tab, so it happens here and the single zip goes straight to the
  // cloud folder (the save target queues it).
  const exportDeliveryBundle = useCallback(
    ({
      includePlaceholders = true,
      sku = 'lesson',
    }: PptxExportChoice & { sku?: DeliverySku } = {}) => {
      withExportGuard(
        async (target) => {
          const fileName = stage?.name || 'slides';
          // Always relative links here: the reader gets the pages in the same
          // zip, so a link that resolves inside the folder is strictly better
          // than a QR code for a server they cannot reach. This is a property of
          // the bundle, not a preference — a handover must not depend on the
          // operator remembering to flip a toggle before exporting.
          const pack = await buildPack(includePlaceholders, true);
          if (pack.empty) {
            toast.warning(t('export.nothingToExport'));
            return;
          }
          if (pack.skippedPptx) {
            toast.info(t('export.noSlidesSkipped'));
          }

          // The script is text: both formats come from the same collection, so
          // the .docx and the .md can never disagree about scene order.
          const scripts = collectSceneScripts(scenes, (order) =>
            t('export.slideFallback', { order }),
          );
          let scriptDocx: Blob | null = null;
          if (scripts.length > 0) {
            scriptDocx = await buildDocxBlob(fileName, scripts);
          }
          const scriptMarkdown = scripts.length > 0 ? buildMarkdown(fileName, scripts) : null;

          // Subtitles are optional: a lesson whose narration has not been
          // rendered yet has no timeline to write, and a bundle without the
          // .srt is still the bundle a customer paid for.
          let srt: string | null = null;
          let cueCount = 0;
          // Where the subtitle timeline ends, which is the only length figure
          // the submission tier has: it ships no video, but the narration it
          // will be read aloud against does exist.
          let narrationSec = 0;
          // The render options, read once: they are the target frame size the
          // submission tier's recording brief quotes.
          const renderOptions = useVideoRenderStore.getState().options;
          try {
            // Read, not subscribe: the resolution is only needed once, here, and
            // a hook would re-render this whole panel on every slider move.
            const resolution = renderOptions.resolution;
            const { compileSubtitles } = await import('@/lib/video-export-app/build-export-zip');
            const compiled = await compileSubtitles({ resolution, locale });
            cueCount = compiled.cueCount;
            srt = compiled.cueCount > 0 ? compiled.srt : null;
            const lastCue = srt
              ? [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->/g)].pop()
              : null;
            if (lastCue) {
              narrationSec =
                Number(lastCue[1]) * 3600 + Number(lastCue[2]) * 60 + Number(lastCue[3]);
            }
          } catch (error) {
            log.warn(
              'Delivery bundle: subtitles could not be compiled; shipping without them.',
              error,
            );
          }

          // The two tiers differ in exactly one place, and it is not cosmetic:
          // the teaching tier sells a finished video, while the competition tier
          // is sold *without* one — contest rules put the teacher on camera, and
          // a render with no human in it fails the first review. Attaching the
          // video to the competition tier would hand the buyer the one file the
          // rules say cannot be theirs, so it is not attached at all.
          const wantsVideo = sku === 'lesson';
          const rendered = wantsVideo ? await loadRenderedVideo(stage?.id ?? '') : null;
          if (wantsVideo && !rendered) {
            // This tier is sold as including the video, so its absence is the
            // buyer's problem to discover later. Say it now instead. The
            // competition tier has no video by design and stays quiet.
            toast.warning(t('export.bundle.noVideo'));
          }

          // The competition tier's stand-in for a video: the whole classroom as
          // one narrated HTML file. It is the only item in that order that
          // *speaks*, and speaking is the part the buyer cannot produce on
          // their own — they still have to record themselves, so what they get
          // here is a model of the pacing to talk over, not a performance.
          //
          // `format: 'auto'` rather than `'html'`: a lesson carrying a lot of
          // audio cannot be one file, and the ZIP fallback would put a package
          // inside the package the customer is already unpacking. When it falls
          // back, that tier ships without `06` — the per-page folder still
          // opens, it just does not play narration.
          let singleHtml: { name: string; data: ArrayBuffer } | null = null;
          if (!wantsVideo && stage) {
            try {
              const { buildStandaloneHtmlExport, classroomUrlFor } =
                await import('./standalone-html/build-standalone-html');
              const strings = Object.fromEntries(
                STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
              ) as StandalonePlayerStrings;
              const narrated = await buildStandaloneHtmlExport(stage, scenes, {
                strings,
                lang: locale,
                includeNarration: true,
                format: 'auto',
                // Same notice as the MP4: this file leaves the app as a
                // distributable copy of generated content.
                aigc: deckAigcNotices(),
                generator: brand.productName,
                // Only a PBL scene renders a link back to the online classroom.
                // Writing this deployment's address into a lesson without one
                // puts a dead `localhost` link in a file that opens elsewhere.
                classroomUrl: scenes.some((scene) => scene.content.type === 'pbl')
                  ? classroomUrlFor(window.location.origin, stage.id)
                  : undefined,
              });
              if (narrated.format === 'html') {
                singleHtml = {
                  // The localized suffix (`-带旁白`), so the buyer can tell this
                  // apart from the silent pages in `交互页面/`.
                  name: t('export.htmlNarrationSuffix'),
                  data: await narrated.blob.arrayBuffer(),
                };
              } else {
                log.warn(
                  'Delivery bundle: the whole-classroom HTML exceeded the single-file limit; shipping without 06.',
                  { singleFileBytes: narrated.singleFileBytes },
                );
              }
            } catch (error) {
              log.warn(
                'Delivery bundle: the whole-classroom HTML could not be built; shipping without 06.',
                error,
              );
            }
          }

          // Both tiers carry submission paperwork, but it says different things:
          // a measured sheet for the video that exists, a recording brief for
          // the video the buyer has to shoot. The opening frame is generated by
          // the operator's tooling rather than here, so the sheet only names it
          // when a caller passes one in.
          const formatFiles: FormatFile[] = [];
          if (wantsVideo && rendered) {
            formatFiles.push({
              name: '报送格式说明.md',
              data: new TextEncoder().encode(
                buildFormatSheet({
                  title: bundleTitle(fileName),
                  filename: `05_${bundleTitle(fileName)}.mp4`,
                  bytes: rendered.bytes,
                  width: rendered.width,
                  height: rendered.height,
                  fps: rendered.fps,
                  durationSec: rendered.durationSec,
                  quality: rendered.quality,
                  cues: cueCount,
                  // The bundle does not generate the opening frame; a caller
                  // that has one passes it in and flips this to true.
                  hasIntro: false,
                }),
              ),
            });
          } else if (!wantsVideo) {
            const size = VIDEO_RESOLUTIONS[renderOptions.resolution];
            formatFiles.push({
              name: '报送格式说明.md',
              data: new TextEncoder().encode(
                buildRecordingSheet({
                  title: bundleTitle(fileName),
                  width: size.width,
                  height: size.height,
                  fps: renderOptions.fps,
                  narrationSec,
                  cues: cueCount,
                  hasIntro: false,
                }),
              ),
            });
          }

          // The sheet used to say the deck's interactive pages "are index
          // slides, click one to open it". That described the placeholder deck
          // and was false for the slides-only deck this export actually writes,
          // so the sheet now states how many pages there are and that they cost
          // no slides, instead of describing the deck at all.
          const interactiveCount = listInteractivePages(scenes).length;

          const blob = await assembleDeliveryBundle({
            title: fileName,
            pack: pack.blob!,
            scriptDocx,
            scriptMarkdown,
            srt,
            // Null on the competition tier: see `wantsVideo`.
            mp4: wantsVideo ? (rendered?.blob ?? null) : null,
            // The other half of that trade: the tier with no video gets the
            // classroom as a playable file instead.
            singleHtml,
            // The cover sheet describes what is in the zip, so it is per tier:
            // the teaching sheet numbers `05` (the video it carries), while the
            // competition sheet stops at `04` and points at `格式件/` instead. A
            // lesson whose pages are all interactive or all slides has no
            // booklet at all — pointing at one the buyer will not find is worse
            // than saying nothing, so that paragraph is a variable too.
            usageNote: t(
              wantsVideo ? 'export.bundle.usageNote' : 'export.bundle.usageNoteContest',
              {
                title: fileName,
                provider: brand.productName,
                booklet:
                  listQuizBookletSections(scenes).length > 0 ? t('export.bundle.bookletNote') : '',
                // The `06` paragraph names a file, so it only appears when that
                // file is in the zip: the narrated HTML is best-effort, and a
                // sheet promising a file the customer cannot find is the exact
                // failure it exists to prevent.
                player: singleHtml ? t('export.bundle.playerNote') : '',
                // Same reasoning for the page count: a paragraph is a variable
                // because a lesson with no interactive scene has no
                // `交互页面/` to point at.
                interactive:
                  interactiveCount > 0
                    ? t('export.bundle.interactiveNote', { pages: interactiveCount })
                    : '',
              },
            ),
            pagesDir: t('export.bundle.pagesDir'),
            usageNoteName: t('export.bundle.usageNoteName'),
            formatFiles: formatFiles.length > 0 ? formatFiles : undefined,
          });

          await writeSaveTarget(
            target,
            t('export.bundle.fileName', { title: bundleTitle(fileName) }),
            blob,
            // The file name carries "-course pack" for the buyer; the cloud
            // folder must stay the course, or the pack and the deck of the same
            // lesson end up as two sibling folders in the seller's drive.
            { deliveryTitle: fileName },
          );
          // Only now, after the bytes exist: a build that threw must not consume
          // a round number, or the buyer's v2 would start at v3. The upload
          // already read the current number, so this advances the *next* export.
          //
          // And only when this round is actually going to the cloud. With
          // delivery switched off nothing is uploaded, so advancing here would
          // spend a number the cloud folder never receives — the first round a
          // customer is sent would then open on `v4/` with `v1`–`v3` empty.
          if (useSettingsStore.getState().deliverToCloud) advanceDeliveryRevision();
          toast.success(t('export.exportSuccess'));
        },
        true,
        SAVE_DIR_IDS.classroomZip,
      );
    },
    [withExportGuard, buildPack, scenes, stage, t, locale, brand.productName, deckAigcNotices],
  );

  return { exporting, exportPPTX, exportResourcePack, exportDeliveryBundle };
}
