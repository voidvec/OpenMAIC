/**
 * The delivery bundle: one zip a customer can open and use.
 *
 * The app's exports are built for the app's own reasons — a resource pack for
 * the deck plus its pages, a script for reading aloud, subtitles for an editor —
 * and each one is a separate download. What a buyer receives is a single
 * numbered folder, which is what this module assembles, and it is the browser
 * equivalent of `bench/pack-delivery.py`.
 *
 * Two properties matter and both come from reading the resource pack rather
 * than re-building it: the deck, the interactive pages and the quiz booklet are
 * exactly the ones in the pack (no second generation pass, so no drift), and the
 * numbering is applied here rather than baked into the pack, so a pack exported
 * for other purposes keeps its own names.
 *
 * The pages do move, though: the pack keeps them under `interactive/` and
 * `quiz/`, and the bundle collects them into one localized folder. The deck's
 * hyperlinks still name the pack's paths, so they are rewritten on the way
 * through — see `relinkDeck` for why a relative link was not enough.
 *
 * Pure and framework-free — no store, no i18n, no DOM beyond `Blob`, so it can
 * run in a worker and be tested without a browser.
 */

/** Longest course title we will put in a path; matches the server's sanitizer. */
const MAX_TITLE_LENGTH = 60;

/**
 * The two things a buyer can order, and the only place their delivery differs.
 *
 * `lesson` is sold as a finished video; `contest` is sold *without* one, because
 * contest rules put the teacher on camera and a render with no human in it fails
 * first review. Everything else — deck, script, subtitles, interactive pages,
 * booklet, submission paperwork — is identical. Defined here rather than in the
 * export hook so the dialog that explains the order can name the tier without
 * importing a React hook.
 */
export type DeliverySku = 'lesson' | 'contest';

/** Characters that break a filename on Windows, macOS or the cloud CLI. */
const ILLEGAL_IN_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Directory the per-scene HTML pages and the quiz booklet live in. */
export const DEFAULT_PAGES_DIR = '交互页面';

/** Name of the cover sheet, first in the archive so it sorts first. */
export const DEFAULT_USAGE_NOTE_NAME = '00_使用说明.txt';

/**
 * Folder for the submission paperwork a buyer is handed: the opening frame and
 * the format sheet. Shipped on both tiers, because both can end up in front of a
 * reviewer — but the sheet inside says something different on each: measured
 * parameters on the tier that has a video, a recording brief on the tier that
 * deliberately does not.
 */
export const DEFAULT_FORMAT_DIR = '格式件';

/** One file in the submission folder. Bytes in, no paths: the folder is flat. */
export interface FormatFile {
  /** Bare file name (no directory); the bundle refuses paths. */
  name: string;
  data: ArrayBuffer | Uint8Array;
}

export interface DeliveryBundleInput {
  /** Course title; used for the file names inside the bundle. */
  title: string;
  /** The resource pack as exported (`interactive/*`, `<title>.pptx`, `quiz/*`). */
  pack: Blob;
  /** The narration script, laid out for reading aloud. */
  scriptDocx: Blob | null;
  /** The same script as Markdown — the file a customer edits. */
  scriptMarkdown: string | null;
  /** Subtitles timed against the narration audio. */
  srt: string | null;
  /** The finished video, on the SKU that includes one. */
  mp4: Blob | null;
  /** Rendered from the i18n catalogue by the caller, which owns the wording. */
  usageNote: string;
  /** Folder name for the pages, localized to match the usage note. */
  pagesDir?: string;
  /** Cover-sheet file name, localized to match the usage note. */
  usageNoteName?: string;
  /**
   * The whole classroom as one playable HTML file, with narration embedded.
   *
   * Only the tier without a video carries it. That tier is sold to a teacher
   * who has to record themselves, so the one thing it cannot offer is something
   * that *talks* — and a narrated single file is exactly that: press play and
   * the lesson runs, page after page, in the customer's own browser with no app
   * and no server. The teaching tier already has the MP4, where the same
   * narration is burned in; a second narrated copy there is just a bigger zip.
   *
   * `name` is the caller's localized suffix word (`带旁白`, `narrated`), not a
   * numbered name: the numbering and its `-` stay here, so a file renamed by
   * hand cannot collide with `05` on the tier that has a video.
   */
  singleHtml?: { name: string; data: ArrayBuffer | Uint8Array } | null;
  /**
   * Submission paperwork (opening frame, format sheet). Present on both tiers;
   * the caller decides what the sheet says, because the two tiers satisfy
   * different readers from the same folder name.
   */
  formatFiles?: FormatFile[];
  /** Folder name for `formatFiles`, localized to match the usage note. */
  formatDir?: string;
}

/** A filename-safe course title, keeping CJK and spacing intact. */
export function bundleTitle(title: string): string {
  const cleaned = title
    .replace(ILLEGAL_IN_NAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'course').slice(0, MAX_TITLE_LENGTH).trim();
}

/** The pack is the only source of the deck, so a pack without one is a bug. */
export class MissingDeckError extends Error {
  constructor() {
    super('resource pack contains no .pptx');
  }
}

/** A slide part or its relationship part — the two places a deck repeats a page path. */
const SLIDE_PARTS = /^ppt\/slides\/(?:slide\d+\.xml|_rels\/[^/]+\.rels)$/;

/**
 * Point the deck's hyperlinks at where the bundle actually puts the pages.
 *
 * A pack keeps its pages under `interactive/` and `quiz/`, and the deck records
 * exactly those paths, relative to the deck, in its hyperlink relationships.
 * The bundle then collects every page into one localized folder
 * (`交互页面/`), which moves the targets out from under the paths the deck
 * remembers: every "open the page" link in a handed-over deck opened nothing.
 * The link is already relative — the defect was which directory it is relative
 * to — so the fix is to swap the directory segment and leave the file name
 * (and any `#quiz-1` anchor) alone.
 *
 * Targets are percent-encoded (`interactive/01_Demo%20%231.html`) but the
 * directory segment is ASCII in both worlds, so this is a literal replacement.
 * A placeholder slide also prints its page's path as text, so the same segment
 * is swapped in `<a:t>` runs: a slide telling the reader to open
 * `interactive/01_x.html` when the bundle put it in `交互页面/` is the same
 * defect as a dead link, just quieter.
 *
 * A deck that will not parse is shipped untouched rather than failing the
 * handover: it is the page files, not the links, that the customer paid for.
 */
async function relinkDeck(
  deck: ArrayBuffer,
  dirMap: ReadonlyMap<string, string>,
): Promise<ArrayBuffer> {
  if (dirMap.size === 0) return deck;
  const JSZip = (await import('jszip')).default;
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(deck);
  } catch {
    return deck;
  }

  let changed = false;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || !SLIDE_PARTS.test(name)) continue;
    const xml = await entry.async('string');
    let next = xml;
    for (const [from, to] of dirMap) {
      next = next
        .replaceAll(`Target="${from}/`, `Target="${to}/`)
        .replaceAll(`<a:t>${from}/`, `<a:t>${to}/`);
    }
    if (next === xml) continue;
    zip.file(name, next);
    changed = true;
  }
  if (!changed) return deck;

  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }) as Promise<ArrayBuffer>;
}

/**
 * Assemble the bundle.
 *
 * Order is the contract with the usage note: the numbered files come first in
 * reading order, then the pages directory. A missing script or subtitle is
 * skipped rather than fatal — a lesson without narration has no subtitles, and
 * a pack with a deck alone is still worth delivering.
 */
export async function assembleDeliveryBundle(input: DeliveryBundleInput): Promise<Blob> {
  const JSZip = (await import('jszip')).default;
  const title = bundleTitle(input.title);
  // `loadAsync` takes a Blob in the browser but not under Node, and this module
  // is exercised in both; the bytes are the common denominator.
  const pack = await JSZip.loadAsync(await input.pack.arrayBuffer());
  const out = new JSZip();

  const memberNames = Object.keys(pack.files).filter((name) => !pack.files[name].dir);

  let deck: ArrayBuffer | null = null;
  const pages: { name: string; packPath: string; data: ArrayBuffer }[] = [];
  for (const name of memberNames) {
    const entry = pack.files[name];
    if (/\.pptx$/i.test(name)) {
      // A pack with two decks is ambiguous: picking one silently would ship the
      // wrong slides under the right name.
      if (deck) throw new Error('resource pack contains more than one .pptx');
      deck = await entry.async('arraybuffer');
    } else if (/\.html?$/i.test(name)) {
      pages.push({
        name: name.split('/').pop() ?? name,
        packPath: name,
        data: await entry.async('arraybuffer'),
      });
    }
  }
  if (!deck) throw new MissingDeckError();

  const pagesDir = input.pagesDir ?? DEFAULT_PAGES_DIR;

  // Every page lands directly in `pagesDir`, so two pages that only differed by
  // their pack folder would silently become one file — and one of them would
  // ship as the other's content. Refuse instead.
  const pageNames = new Set<string>();
  const dirMap = new Map<string, string>();
  for (const page of pages) {
    if (pageNames.has(page.name)) {
      throw new Error(`two pack pages share the file name ${page.name}`);
    }
    pageNames.add(page.name);
    const dir = page.packPath.includes('/')
      ? page.packPath.slice(0, page.packPath.lastIndexOf('/'))
      : '';
    if (dir && dir !== pagesDir) dirMap.set(dir, pagesDir);
  }

  // The cover sheet is the first file a customer opens, and on Windows that is
  // Notepad, which guesses a legacy code page for a BOM-less UTF-8 file and
  // renders every Chinese character as mojibake. Three bytes of BOM settle it;
  // every editor that understands UTF-8 ignores it.
  out.file(input.usageNoteName ?? DEFAULT_USAGE_NOTE_NAME, `\uFEFF${input.usageNote}`);

  // `01`…`04` are the files a customer opens; the pages directory follows
  // because it is a folder, not an item in the reading order.
  //
  // Blobs are unwrapped to bytes first: JSZip takes a Blob only in the browser,
  // and this module is exercised in both.
  out.file(`01_${title}.pptx`, await relinkDeck(deck, dirMap));
  if (input.scriptDocx) out.file(`02_${title}-讲稿.docx`, await input.scriptDocx.arrayBuffer());
  if (input.scriptMarkdown) out.file(`03_${title}-讲稿.md`, input.scriptMarkdown);
  if (input.srt) out.file(`04_${title}.srt`, input.srt);
  if (input.mp4) out.file(`05_${title}.mp4`, await input.mp4.arrayBuffer());
  // `06` is fixed regardless of tier, so a number means one kind of file in
  // every course a customer buys. The competition tier therefore shows `04`
  // then `06`: `05` is the video it does not include, and the cover sheet says
  // so. Renumbering it to `05` here would make "05" mean video in one order and
  // a web page in the next, which is the kind of drift the numbering prevents.
  //
  // The separator belongs here rather than in the caller's suffix: the suffix is
  // a bare word in every locale (`带旁白`, `narrated`, `erzählt`), and the
  // standalone exporter adds its own `-` when it names the file. Reusing the
  // suffix without it produced `06_课题带旁白.html` — readable, but a second
  // spelling of a name the app already uses elsewhere.
  if (input.singleHtml) {
    out.file(`06_${title}-${input.singleHtml.name}.html`, input.singleHtml.data);
  }

  // Sorted by their own names (`01_`, `02_`…) so the page order matches the
  // lesson order the exporter already chose.
  pages.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const page of pages) out.file(`${pagesDir}/${page.name}`, page.data);

  // Submission paperwork last: it is an appendix to the numbered files rather
  // than another item in the reading order.
  const formatFiles = input.formatFiles ?? [];
  if (formatFiles.length > 0) {
    const formatDir = input.formatDir ?? DEFAULT_FORMAT_DIR;
    const taken = new Set<string>();
    for (const file of formatFiles) {
      // A name carrying a separator would escape the folder, and a duplicate
      // would let one submission file silently ship as another's content.
      const base = file.name.split(/[\\/]/).pop() ?? '';
      if (!base || base !== file.name) {
        throw new Error(`submission file name must be a bare name: ${file.name}`);
      }
      if (taken.has(base)) {
        throw new Error(`two submission files share the name ${base}`);
      }
      taken.add(base);
      out.file(`${formatDir}/${base}`, file.data);
    }
  }

  // `blob` is not a supported output type under Node, and the caller always
  // wants a Blob (it goes to the File System Access API), so package bytes and
  // wrap them here rather than branching on the environment.
  const bytes = await out.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  return new Blob([bytes], { type: 'application/zip' });
}
