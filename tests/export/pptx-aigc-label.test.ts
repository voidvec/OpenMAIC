import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { PPTTextElement, Slide } from '@openmaic/dsl';
import { buildPptxBlob, type PptxAigcNotices } from '@/lib/export/use-export-pptx';
import { aigcLabelFontPx } from '@/lib/video-export/aigc-label';

const VIEWPORT_SIZE = 960;
const VIEWPORT_RATIO = 0.5625;
const RATIO_PX_2_INCH = 96;
const RATIO_PX_2_PT = 96 / 72;

/**
 * The exported deck is a distributable copy of generated content, so it is in
 * the same scope as the exported MP4: a visible label at a corner whose
 * character height reaches the standard's 5%-of-the-shorter-side floor, plus
 * the provider/content identifiers in the package metadata.
 */
const NOTICES: PptxAigcNotices = {
  label: 'AI 生成',
  provider: 'Acme 教育',
  contentId: 'stage-1',
};

function textElement(): PPTTextElement {
  return {
    id: 'title',
    type: 'text',
    left: 60,
    top: 60,
    width: 400,
    height: 80,
    content: '<p>Lesson title</p>',
    defaultFontName: 'Arial',
    defaultColor: '#000000',
    rotate: 0,
  };
}

function slideWith(elements: PPTTextElement[]): Slide {
  return {
    id: 'slide',
    viewportSize: VIEWPORT_SIZE,
    viewportRatio: VIEWPORT_RATIO,
    theme: {
      fontName: 'Arial',
      fontColor: '#000000',
      backgroundColor: '#ffffff',
      themeColors: ['#000000'],
    },
    elements,
    background: { type: 'solid', color: '#ffffff' },
  };
}

async function buildZip(
  slides: Slide[],
  deck: Parameters<typeof buildPptxBlob>[7],
  aigc?: PptxAigcNotices,
): Promise<JSZip> {
  const blob = await buildPptxBlob(
    slides,
    [],
    VIEWPORT_RATIO,
    VIEWPORT_SIZE,
    RATIO_PX_2_INCH,
    RATIO_PX_2_PT,
    'stage-1',
    deck,
    aigc,
  );
  return JSZip.loadAsync(await blob.arrayBuffer());
}

/** Font size (pt) of the run whose text is `text`, from the slide's XML. */
function fontSizeOf(xml: string, text: string): number | undefined {
  const at = xml.indexOf(text);
  if (at < 0) return undefined;
  // The run properties sit before the run's text in DrawingML.
  const run = xml.slice(Math.max(0, at - 600), at);
  const match = /<a:rPr[^>]*\bsz="(\d+)"/.exec(run);
  return match ? Number(match[1]) / 100 : undefined;
}

/** The `<p:sp>` that carries `text`, with its offset and extent in EMU. */
function shapeWithText(
  xml: string,
  text: string,
): { off: { x: number; y: number }; ext: { cx: number; cy: number } } | undefined {
  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const shape = match[0];
    if (!shape.includes(text)) continue;
    const off = /<a:off x="(\d+)" y="(\d+)"\/>/.exec(shape);
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape);
    if (!off || !ext) continue;
    return { off: { x: +off[1], y: +off[2] }, ext: { cx: +ext[1], cy: +ext[2] } };
  }
  return undefined;
}

/** The 16:9 page in EMU, as pptxgenjs writes it for a 960px viewport at 96dpi. */
const PAGE_W_EMU = (VIEWPORT_SIZE / RATIO_PX_2_INCH) * 914400;
const PAGE_H_EMU = ((VIEWPORT_SIZE * VIEWPORT_RATIO) / RATIO_PX_2_INCH) * 914400;

describe('PPTX AIGC label', () => {
  it('stamps the visible label on every page at the standard size floor', async () => {
    const zip = await buildZip([slideWith([textElement()]), slideWith([])], undefined, NOTICES);
    const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const second = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(first).toContain(NOTICES.label);
    expect(second).toContain(NOTICES.label);

    // GB 45438-2025 §5.2 (图片) / §5.4 (视频) floor: 5% of the shorter side.
    const floor = aigcLabelFontPx(VIEWPORT_SIZE, VIEWPORT_SIZE * VIEWPORT_RATIO) / RATIO_PX_2_PT;
    const size = fontSizeOf(first, NOTICES.label);
    expect(size).toBeDefined();
    expect(size!).toBeGreaterThanOrEqual(floor * 0.99);
  });

  it('anchors the label in the bottom-right corner, clear of the slide body', async () => {
    const zip = await buildZip([slideWith([textElement()])], undefined, NOTICES);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const shape = shapeWithText(xml, NOTICES.label);
    expect(shape).toBeDefined();
    // Bottom-right half of the page: the corner slide content rarely reaches.
    expect(shape!.off.x).toBeGreaterThan(PAGE_W_EMU / 2);
    expect(shape!.off.y).toBeGreaterThan(PAGE_H_EMU / 2);
    // One tight line, wholly inside the page.
    expect(shape!.off.y + shape!.ext.cy).toBeLessThanOrEqual(PAGE_H_EMU);
    expect(shape!.off.x + shape!.ext.cx).toBeLessThanOrEqual(PAGE_W_EMU);
  });

  it('names the provider and content id in the package metadata', async () => {
    const zip = await buildZip([slideWith([textElement()])], undefined, NOTICES);
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain(NOTICES.provider);
    expect(core).toContain(NOTICES.contentId);
    expect(core).toContain(NOTICES.label);
  });

  it('omits the notice when the caller does not ask for it', async () => {
    const zip = await buildZip([slideWith([textElement()])], undefined, undefined);
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(slide).not.toContain(NOTICES.label);
    expect(core).not.toContain(NOTICES.contentId);
  });
});
