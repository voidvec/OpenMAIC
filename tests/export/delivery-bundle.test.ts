/**
 * The delivery bundle is the file a customer actually opens, so its shape is a
 * promise: numbered files in reading order, the pages in their own folder, and
 * nothing invented when a part is missing. These tests pin the layout and the
 * two failure modes (no deck, two decks) that would otherwise ship the wrong
 * slides under the right name.
 */
import { describe, expect, it } from 'vitest';

import {
  assembleDeliveryBundle,
  bundleTitle,
  DEFAULT_PAGES_DIR,
  DEFAULT_USAGE_NOTE_NAME,
  MissingDeckError,
} from '@/lib/export/delivery-bundle';

/** A resource pack shaped like the exporter's: deck + pages + booklet. */
async function resourcePack(
  members: Record<string, string | Uint8Array> = {
    'demo.pptx': new Uint8Array([1, 2, 3, 4]),
    'interactive/01_开场.html': '<html>1</html>',
    'interactive/02_练习.html': '<html>2</html>',
    'quiz/随堂测试题册.html': '<html>quiz</html>',
  },
): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const [name, data] of Object.entries(members)) zip.file(name, data);
  return zip.generateAsync({ type: 'blob' });
}

async function namesOf(blob: Blob): Promise<string[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort();
}

/** One member of a produced bundle, or null when the bundle has no such file. */
async function readMember(blob: Blob, path: string): Promise<ArrayBuffer | null> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = zip.file(path);
  return entry ? entry.async('arraybuffer') : null;
}

/** A pack whose deck carries the given hyperlink relationships, and one page each. */
async function bundleWithDeck(
  relsXml: string,
  extraDeckParts: Record<string, string> = {},
): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const deck = new JSZip();
  deck.file('[Content_Types].xml', '<Types/>');
  deck.file('ppt/slides/_rels/slide1.xml.rels', relsXml);
  for (const [name, xml] of Object.entries(extraDeckParts)) deck.file(name, xml);
  return assembleDeliveryBundle({
    title: '课程',
    pack: await resourcePack({
      'demo.pptx': await deck.generateAsync({ type: 'uint8array' }),
      'interactive/01_开场.html': '<html>1</html>',
      'quiz/随堂测试题册.html': '<html>quiz</html>',
    }),
    scriptDocx: null,
    scriptMarkdown: null,
    srt: null,
    mp4: null,
    usageNote: 'read me',
  });
}

/** The delivered deck's relationship part, as text. */
async function readDeckRels(blob: Blob): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const deck = await JSZip.loadAsync((await readMember(blob, '01_课程.pptx'))!);
  return deck.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
}

/**
 * Every external, non-URL link in the delivered deck whose target is not a file
 * in the delivered bundle — the customer-visible shape of a broken link.
 */
async function deadLinks(blob: Blob): Promise<string[]> {
  const JSZip = (await import('jszip')).default;
  const bundle = await JSZip.loadAsync(await blob.arrayBuffer());
  const present = new Set(Object.keys(bundle.files).filter((n) => !bundle.files[n].dir));

  const deckName = Object.keys(bundle.files).find((name) => name.endsWith('.pptx'))!;
  const deck = await JSZip.loadAsync(await bundle.files[deckName].async('arraybuffer'));

  const dead: string[] = [];
  for (const name of Object.keys(deck.files)) {
    if (!/^ppt\/slides\/_rels\/[^/]+\.rels$/.test(name)) continue;
    const xml = await deck.files[name].async('string');
    for (const [, target] of xml.matchAll(/Target="([^"]+)"\s+TargetMode="External"/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:
      const path = decodeURIComponent(target.split('#')[0]);
      if (!present.has(path)) dead.push(target);
    }
  }
  return dead;
}

describe('assembleDeliveryBundle', () => {
  it('numbers the deck, script and subtitles, and keeps the pages in one folder', async () => {
    const blob = await assembleDeliveryBundle({
      title: '数据透视表',
      pack: await resourcePack(),
      scriptDocx: new Blob(['docx']),
      scriptMarkdown: '# script',
      srt: '1\n00:00:00,000 --> 00:00:02,000\n你好\n',
      mp4: null,
      usageNote: 'read me',
    });

    expect(await namesOf(blob)).toEqual([
      DEFAULT_USAGE_NOTE_NAME,
      `01_数据透视表.pptx`,
      `02_数据透视表-讲稿.docx`,
      `03_数据透视表-讲稿.md`,
      `04_数据透视表.srt`,
      // The pages keep the exporter's own `01_`, `02_` order inside the folder.
      `${DEFAULT_PAGES_DIR}/01_开场.html`,
      `${DEFAULT_PAGES_DIR}/02_练习.html`,
      `${DEFAULT_PAGES_DIR}/随堂测试题册.html`,
    ]);
  });

  it('skips a missing script or subtitle instead of writing an empty file', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
    });

    const names = await namesOf(blob);
    expect(names.filter((name) => name.startsWith('02_'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('03_'))).toEqual([]);
    expect(names.filter((name) => name.startsWith('04_'))).toEqual([]);
    // The deck is what makes it a delivery: it is always there.
    expect(names).toContain('01_课程.pptx');
  });

  it('puts the finished video before the pages when the SKU includes one', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: new Blob(['mp4']),
      usageNote: 'read me',
    });
    expect(await namesOf(blob)).toContain('05_课程.mp4');
  });

  it('ships the whole classroom as one narrated page on the tier without a video', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      singleHtml: { name: '带旁白', data: new TextEncoder().encode('<html></html>') },
      usageNote: 'read me',
    });
    const names = await namesOf(blob);
    expect(names).toContain('06_课程-带旁白.html');
    // `05` stays a video number even when the tier has no video: a customer
    // comparing two orders must not find `05` meaning a web page in one of them.
    expect(names.some((name) => name.startsWith('05_'))).toBe(false);
  });

  it('adds no narrated page when the caller has none', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
    });
    // The narrated file is best-effort: an oversized lesson falls back to a ZIP
    // the bundle will not nest, and the tier ships without `06`.
    expect((await namesOf(blob)).some((name) => name.startsWith('06_'))).toBe(false);
  });

  it('follows the caller’s localized folder and cover-sheet names', async () => {
    const blob = await assembleDeliveryBundle({
      title: 'Course',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
      pagesDir: 'pages',
      usageNoteName: '00_read-me-first.txt',
    });
    const names = await namesOf(blob);
    expect(names).toContain('00_read-me-first.txt');
    expect(names).toContain('pages/01_开场.html');
  });

  // The cover sheet is the first file a customer opens, and on Windows that is
  // Notepad, which guesses a legacy code page for a BOM-less UTF-8 file and
  // renders the Chinese usage note as mojibake. The mark is the whole difference
  // between a readable handover and a complaint.
  it('writes the cover sheet with a UTF-8 BOM', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: '打开 01_课程.pptx 开始',
    });
    const bytes = await readMember(blob, DEFAULT_USAGE_NOTE_NAME);
    expect(bytes).not.toBeNull();
    // `ignoreBOM: true` keeps the mark in the decoded string; the default strips
    // it, which would make a BOM-less file indistinguishable from a correct one.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes!);
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('打开 01_课程.pptx 开始');
  });

  it('refuses a pack with no deck', async () => {
    await expect(
      assembleDeliveryBundle({
        title: '课程',
        pack: await resourcePack({ 'interactive/01_开场.html': '<html></html>' }),
        scriptDocx: null,
        scriptMarkdown: null,
        srt: null,
        mp4: null,
        usageNote: 'read me',
      }),
    ).rejects.toBeInstanceOf(MissingDeckError);
  });

  it('refuses a pack with two decks rather than picking one', async () => {
    await expect(
      assembleDeliveryBundle({
        title: '课程',
        pack: await resourcePack({
          'a.pptx': new Uint8Array([1]),
          'b.pptx': new Uint8Array([2]),
        }),
        scriptDocx: null,
        scriptMarkdown: null,
        srt: null,
        mp4: null,
        usageNote: 'read me',
      }),
    ).rejects.toThrow(/more than one/);
  });

  it('refuses two pages that would collide once the pack folders are flattened', async () => {
    await expect(
      assembleDeliveryBundle({
        title: '课程',
        pack: await resourcePack({
          'demo.pptx': new Uint8Array([1]),
          'interactive/题册.html': '<html>page</html>',
          'quiz/题册.html': '<html>booklet</html>',
        }),
        scriptDocx: null,
        scriptMarkdown: null,
        srt: null,
        mp4: null,
        usageNote: 'read me',
      }),
    ).rejects.toThrow(/share the file name/);
  });

  // Two tiers share this builder: a teaching handover is the numbered files and
  // the pages, a competition entry adds the paperwork a reviewer asks for. The
  // folder is the only difference, so it must appear exactly when asked for —
  // an empty folder on the teaching tier is a question the buyer has to ask.
  it('adds no submission folder when the tier has none', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
    });
    expect((await namesOf(blob)).filter((name) => name.startsWith('格式件/'))).toEqual([]);
  });

  it('files submission paperwork under its own folder, after the pages', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
      formatFiles: [
        { name: '片头页.png', data: new Uint8Array([1, 2]) },
        { name: '报送格式说明.md', data: new TextEncoder().encode('# 格式') },
      ],
    });
    expect(await namesOf(blob)).toEqual([
      '00_使用说明.txt',
      '01_课程.pptx',
      '交互页面/01_开场.html',
      '交互页面/02_练习.html',
      '交互页面/随堂测试题册.html',
      '格式件/报送格式说明.md',
      '格式件/片头页.png',
    ]);
    expect(new Uint8Array((await readMember(blob, '格式件/片头页.png'))!)).toEqual(
      new Uint8Array([1, 2]),
    );
  });

  it('follows the caller’s localized submission folder name', async () => {
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack(),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
      formatFiles: [{ name: 'intro.png', data: new Uint8Array([1]) }],
      formatDir: 'submission',
    });
    expect(await namesOf(blob)).toContain('submission/intro.png');
  });

  // A separator would let one name escape the folder, and a duplicate would let
  // one submission file ship as another's content under the right name.
  it('refuses a submission file name that is a path', async () => {
    await expect(
      assembleDeliveryBundle({
        title: '课程',
        pack: await resourcePack(),
        scriptDocx: null,
        scriptMarkdown: null,
        srt: null,
        mp4: null,
        usageNote: 'read me',
        formatFiles: [{ name: '../escape.png', data: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/bare name/);
  });

  it('refuses two submission files with the same name', async () => {
    await expect(
      assembleDeliveryBundle({
        title: '课程',
        pack: await resourcePack(),
        scriptDocx: null,
        scriptMarkdown: null,
        srt: null,
        mp4: null,
        usageNote: 'read me',
        formatFiles: [
          { name: '片头页.png', data: new Uint8Array([1]) },
          { name: '片头页.png', data: new Uint8Array([2]) },
        ],
      }),
    ).rejects.toThrow(/share the name/);
  });
});

/**
 * Hyperlinks.
 *
 * A pack's deck names its pages by pack path (`interactive/…`, `quiz/…`). The
 * bundle moves those pages into one localized folder, so shipping the deck
 * untouched hands the customer a deck whose every "open the page" link is dead —
 * and nothing in the archive itself would show it, because the files are all
 * present, just somewhere else.
 */
describe('deck links', () => {
  const PACK_RELS = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="interactive/01_开场.html" TargetMode="External"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="quiz/随堂测试题册.html#quiz-1" TargetMode="External"/>',
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/classroom" TargetMode="External"/>',
    '</Relationships>',
  ].join('');

  it('repoints the deck at the folder the pages ship in, anchors included', async () => {
    const blob = await bundleWithDeck(PACK_RELS);
    const rels = await readDeckRels(blob);
    expect(rels).toContain('Target="交互页面/01_开场.html" TargetMode="External"');
    expect(rels).toContain('Target="交互页面/随堂测试题册.html#quiz-1" TargetMode="External"');
    // A remote link is not ours to rewrite, and neither is a package-internal one.
    expect(rels).toContain('Target="https://example.com/classroom"');
    expect(rels).toContain('Target="../slideLayouts/slideLayout1.xml"');
  });

  it('leaves every link pointing at a file the bundle contains', async () => {
    const blob = await bundleWithDeck(PACK_RELS);
    expect(await deadLinks(blob)).toEqual([]);
  });

  it('moves the path printed on the slide along with the link', async () => {
    // A placeholder slide prints where its page is, so a reader can find it in
    // the folder. Once the pages move, printed and linked path cannot disagree:
    // the note would send the customer to a directory the bundle never made.
    const slide = [
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p>',
      '<a:r><a:t>Open the page</a:t></a:r>',
      '<a:r><a:t> · </a:t></a:r>',
      '<a:r><a:t>interactive/01_开场.html</a:t></a:r>',
      '</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ].join('');
    const blob = await bundleWithDeck(PACK_RELS, { 'ppt/slides/slide1.xml': slide });

    const JSZip = (await import('jszip')).default;
    const deck = await JSZip.loadAsync((await readMember(blob, '01_课程.pptx'))!);
    const xml = await deck.file('ppt/slides/slide1.xml')!.async('string');

    expect(xml).toContain('<a:t>交互页面/01_开场.html</a:t>');
    expect(xml).not.toContain('<a:t>interactive/01_开场.html</a:t>');
    // Text that is not a page path is left alone.
    expect(xml).toContain('<a:t>Open the page</a:t>');
  });

  it('ships a deck it cannot parse untouched rather than losing the delivery', async () => {
    const notAZip = new Uint8Array([1, 2, 3, 4]);
    const blob = await assembleDeliveryBundle({
      title: '课程',
      pack: await resourcePack({
        'demo.pptx': notAZip,
        'interactive/01_开场.html': '<html>1</html>',
        'quiz/随堂测试题册.html': '<html>quiz</html>',
      }),
      scriptDocx: null,
      scriptMarkdown: null,
      srt: null,
      mp4: null,
      usageNote: 'read me',
    });
    const deck = await readMember(blob, '01_课程.pptx');
    expect(new Uint8Array(deck!)).toEqual(notAZip);
  });
});

describe('bundleTitle', () => {
  it('keeps Chinese titles intact', () => {
    expect(bundleTitle('数据透视表 三步做报表')).toBe('数据透视表 三步做报表');
  });

  it('replaces characters that break a path or a CLI argument', () => {
    expect(bundleTitle('a/b:c*d?')).toBe('a b c d');
  });

  it('never yields an empty name', () => {
    expect(bundleTitle('   ')).toBe('course');
    expect(bundleTitle('...')).toBe('course');
  });
});
