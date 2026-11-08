'use client';

/**
 * `useExportScript` — download the classroom narration script (the
 * `SpeechAction.text` per scene) as Markdown or a genuine OOXML `.docx` file.
 *
 * Issue #413: teachers want the TTS narration text as a local document for
 * lesson prep/reference, not just the PPTX export. This is a pure client-side
 * collection + serialization + download — no server route or media work.
 *
 * App-side / impure: store read, sonner toast, interactive save target
 * ({@link resolveSaveTarget}).
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { collectSpeechText } from './narration';
import { resolveSaveTarget, writeSaveTarget, SAVE_DIR_IDS } from '@/lib/download/save-target';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('ExportScript');

/** One scene's narration, collected from its speech actions. */
export interface SceneScript {
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  text: string;
}

export type ScriptFormat = 'md' | 'docx';

export const SCRIPT_MIME_TYPES: Record<ScriptFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

interface ScriptExportStageState {
  scenes: readonly unknown[];
  generatingOutlines: readonly unknown[];
  failedOutlines: readonly unknown[];
}

interface ScriptExportMediaTask {
  status: string;
}

/** Keep render-time and click-time narration export readiness in sync. */
export function isScriptExportReady(
  stageState: ScriptExportStageState,
  mediaTasks: Record<string, ScriptExportMediaTask>,
): boolean {
  return (
    stageState.scenes.length > 0 &&
    stageState.generatingOutlines.length === 0 &&
    stageState.failedOutlines.length === 0 &&
    Object.values(mediaTasks).every((task) => task.status === 'done' || task.status === 'failed')
  );
}

/**
 * Collect each scene's narration: concatenate its `SpeechAction.text` values in
 * action order. Scenes with no speech text are omitted entirely. `slideFallback`
 * supplies the locale-appropriate label for scenes with an empty title.
 *
 * The speech walk itself lives in `./narration` so this exporter and the PPTX
 * speaker-notes exporter can't drift on what counts as narration (#1142).
 * Whitespace-only speech is dropped and kept text is trimmed — see the
 * `keepWhitespaceOnly` / `trim` options there.
 */
export function collectSceneScripts(
  scenes: Scene[],
  slideFallback: (order: number) => string,
): SceneScript[] {
  const scripts: SceneScript[] = [];
  for (const scene of scenes) {
    const text = collectSpeechText(scene, { keepWhitespaceOnly: false, trim: true });
    if (!text) continue;
    scripts.push({
      sceneId: scene.id,
      sceneTitle: scene.title || slideFallback(scene.order),
      sceneOrder: scene.order,
      text,
    });
  }
  return scripts;
}

/** Normalize CRLF and lone CR line endings for consistent cross-format output. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Neutralize a scene/stage title before it's interpolated into a Markdown
 * heading: flatten embedded newlines to spaces, then backslash-escape a
 * leading `#` run so it renders as literal text instead of Markdown heading
 * syntax. Escaping (not stripping) preserves titles that legitimately start
 * with `#` (e.g. "#1 Introduction") while still neutralizing the character's
 * special meaning. Newlines are flattened before the leading-`#` check so a
 * title like "\n# Injected" can't dodge the escape by shielding its `#`
 * behind whitespace that a later `trim()` would otherwise re-expose.
 */
function sanitizeMarkdownHeading(text: string): string {
  const flattened = text.replace(/[\r\n]+/g, ' ').trim();
  return flattened.replace(/^#+/, (hashes) =>
    hashes
      .split('')
      .map((h) => `\\${h}`)
      .join(''),
  );
}

/**
 * Serialize collected scripts as a Markdown document.
 *
 * Scenes are separated by a thematic break (`---`) so a reader scrolling the
 * file sees the same page boundaries the DOCX gets from its page breaks. Font
 * and spacing are the reader's business in Markdown, so structure is the only
 * thing this format can be "configured" for.
 */
export function buildMarkdown(stageName: string, scripts: SceneScript[]): string {
  const scenes: string[] = [];
  for (const script of scripts) {
    if (!script.text) continue;
    const body = [`## ${sanitizeMarkdownHeading(script.sceneTitle)}`];
    const paragraphs = normalizeLineEndings(script.text)
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
      .filter(Boolean);
    body.push(...paragraphs);
    scenes.push(body.join('\n\n'));
  }
  // The rule separates scenes from each other only: one directly under the
  // title would read as a stray divider, and the title is not a scene.
  const title = `# ${sanitizeMarkdownHeading(stageName)}`;
  const document = scenes.length > 0 ? [title, scenes.join('\n\n---\n\n')].join('\n\n') : title;
  return document.replace(/\n{3,}/g, '\n\n').trim();
}

type DocxApi = Pick<
  typeof import('docx'),
  'Document' | 'HeadingLevel' | 'Paragraph' | 'TextRun' | 'Footer' | 'PageNumber' | 'AlignmentType'
>;

/**
 * Typeface pair for the script document: a serif body in Chinese official
 * document style, a sans-serif heading face so scene titles separate from the
 * narration at a glance. Latin runs reuse the same pairing so mixed text does
 * not jump between families.
 */
const SCRIPT_BODY_FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' };
const SCRIPT_HEADING_FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体' };

/**
 * Build the document model used by the browser-only DOCX serializer.
 * `docx` is passed in rather than imported at module evaluation time so the
 * normal classroom header does not eagerly load the OOXML library.
 *
 * The comment script is read aloud, so the layout follows what a narrator
 * needs off the page rather than a generic dump: one scene per page, 1.5 line
 * spacing, a two-character first-line indent, and a page number in the footer.
 * Every value below is a fixed typographic choice, not a per-export option —
 * nothing here depends on the course.
 */
export function buildDocxDocument(
  stageName: string,
  scripts: SceneScript[],
  api: DocxApi,
): InstanceType<DocxApi['Document']> {
  const children = [new api.Paragraph({ text: stageName, heading: api.HeadingLevel.HEADING_1 })];
  let firstScene = true;

  for (const script of scripts) {
    if (!script.text) continue;
    children.push(
      new api.Paragraph({
        text: script.sceneTitle,
        heading: api.HeadingLevel.HEADING_2,
        // A narrator works one scene at a time; start each one on a fresh page.
        pageBreakBefore: !firstScene,
      }),
    );
    firstScene = false;
    for (const raw of normalizeLineEndings(script.text).split(/\n{2,}/)) {
      const paragraph = raw.trim();
      if (!paragraph) continue;
      const lines = paragraph.split('\n');
      children.push(
        new api.Paragraph({
          children: lines.map(
            (line, index) => new api.TextRun({ text: line, break: index > 0 ? 1 : undefined }),
          ),
        }),
      );
    }
  }

  return new api.Document({
    styles: {
      default: {
        document: {
          // 小四 (12pt = 24 half-points), 1.5 倍行距, 首行缩进两字 (480 twips).
          run: { font: SCRIPT_BODY_FONT, size: 24 },
          paragraph: {
            spacing: { line: 360, before: 0, after: 120 },
            indent: { firstLine: 480 },
          },
        },
        heading1: {
          run: { font: SCRIPT_HEADING_FONT, size: 32, bold: true, color: '000000' },
          paragraph: { alignment: api.AlignmentType.CENTER, spacing: { before: 0, after: 360 } },
        },
        heading2: {
          run: { font: SCRIPT_HEADING_FONT, size: 28, bold: true, color: '000000' },
          paragraph: {
            spacing: { before: 240, after: 180 },
            // Headings carry no first-line indent; the body's does not leak up.
            indent: { firstLine: 0 },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          // 上下 2.54cm / 左右 3.17cm（twips：1cm ≈ 567）.
          page: { margin: { top: 1440, bottom: 1440, left: 1797, right: 1797 } },
        },
        footers: {
          default: new api.Footer({
            children: [
              new api.Paragraph({
                alignment: api.AlignmentType.CENTER,
                children: [
                  new api.TextRun({
                    children: ['— ', api.PageNumber.CURRENT, ' —'],
                    size: 20,
                    color: '595959',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

/** Build a genuine OOXML DOCX blob using the browser-compatible `docx` package. */
export async function buildDocxBlob(stageName: string, scripts: SceneScript[]): Promise<Blob> {
  const api = await import('docx');
  const document = buildDocxDocument(stageName, scripts, api);
  return api.Packer.toBlob(document);
}

/**
 * Build a safe download file name: `<stem>-script.<ext>`. Illegal filename
 * characters are stripped, whitespace runs collapse to a single `-`, and an
 * empty stem falls back to `script`.
 */
export function buildScriptFileName(stageName: string, ext: ScriptFormat): string {
  const cleaned = stageName
    .replace(/[\u0000-\u001f\u007f\u200b-\u200c\u200e-\u200f\ufeff\\/:*?"<>|]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-script.${ext}` : `script.${ext}`;
}

/** Shared export hook — exposes Markdown and DOCX downloads. */
export function useExportScript() {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);

  const downloadScript = useCallback(
    async (format: ScriptFormat) => {
      if (exportingRef.current) return;

      const stageState = useStageStore.getState();
      const mediaTasks = useMediaGenerationStore.getState().tasks;
      if (!isScriptExportReady(stageState, mediaTasks)) {
        toast.warning(t('share.notReady'));
        return;
      }

      const { scenes, stage } = stageState;
      const scripts = collectSceneScripts(scenes, (order) => t('export.slideFallback', { order }));
      if (scripts.length === 0) {
        toast.warning(t('export.nothingToExport'));
        return;
      }

      const isAsync = format === 'docx';
      if (isAsync) {
        exportingRef.current = true;
        setExporting(true);
      }

      // Ask where to save while the click's user activation is still live: the
      // DOCX packer runs on the async path, past the picker's window.
      const target = await resolveSaveTarget(SAVE_DIR_IDS.script);
      if (!target) {
        if (isAsync) {
          exportingRef.current = false;
          setExporting(false);
        }
        return;
      }

      try {
        const fileName = stage?.name || 'classroom';
        let blob: Blob;
        if (format === 'md') {
          blob = new Blob([buildMarkdown(fileName, scripts)], {
            type: SCRIPT_MIME_TYPES.md,
          });
        } else {
          blob = await buildDocxBlob(fileName, scripts);
          // Some Blob implementations inherit a generic type from the packer;
          // normalize it before handing the file to the browser download API.
          if (blob.type !== SCRIPT_MIME_TYPES.docx) {
            blob = new Blob([blob], { type: SCRIPT_MIME_TYPES.docx });
          }
        }
        await writeSaveTarget(target, buildScriptFileName(fileName, format), blob);
        toast.success(t('export.exportSuccess'));
      } catch (error) {
        log.error(`Script export failed (${format}):`, error);
        toast.error(t('export.exportFailed'));
      } finally {
        if (isAsync) {
          exportingRef.current = false;
          setExporting(false);
        }
      }
    },
    [t],
  );

  return {
    exporting,
    exportScriptDocx: () => void downloadScript('docx'),
    exportScriptMd: () => void downloadScript('md'),
  };
}
