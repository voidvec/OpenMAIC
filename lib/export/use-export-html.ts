'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { resolveSaveTarget, writeSaveTarget, SAVE_DIR_IDS } from '@/lib/download/save-target';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';
import type { LegacySpeechAction } from '@/lib/types/action';
import { resolveAigcIdentifiers } from '@/lib/video-export/aigc-label';
import { isAigcLabelEnabled } from '@/lib/config/aigc-label-preference';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from './standalone-html/contract';
import {
  STANDALONE_HTML_SIZE_WARNING_BYTES,
  StandaloneHtmlTooLargeError,
} from './standalone-html/limits';

const log = createLogger('ExportHtml');

/** Whether any speech in the classroom has narration audio to embed. */
export function classroomHasNarration(scenes: readonly Scene[]): boolean {
  return scenes.some((scene) =>
    (scene.actions ?? []).some((action) => {
      if (action.type !== 'speech') return false;
      const speech = action as LegacySpeechAction;
      return !!speech.audioId || !!speech.audioUrl;
    }),
  );
}

/** Whether any slide in the classroom carries a video element. */
function classroomHasSlideVideo(scenes: readonly Scene[]): boolean {
  return scenes.some((scene) => {
    const content = scene.content as { type?: string; canvas?: { elements?: unknown[] } };
    if (content?.type !== 'slide') return false;
    return (content.canvas?.elements ?? []).some(
      (element) => (element as { type?: string } | null)?.type === 'video',
    );
  });
}

/**
 * Whether the "with narration and video" export adds anything: narration
 * audio, or a slide video (only that export carries videos).
 */
export function classroomHasPlaybackMedia(scenes: readonly Scene[]): boolean {
  return classroomHasNarration(scenes) || classroomHasSlideVideo(scenes);
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1);
}

/** How long the ZIP fallback notice stays up; it carries instructions. */
const ZIP_FALLBACK_TOAST_MS = 12_000;

export interface ExportHtmlOptions {
  /** Embed narration audio and video clips (see `buildStandaloneHtmlExport`). */
  includeNarration: boolean;
}

export function useExportHtml() {
  const [exporting, setExporting] = useState(false);
  const { t, locale } = useI18n();
  // The exported file is handed to this deployment's learners, so it names
  // this deployment rather than the product it was built from.
  const brand = useBrand();

  const exportStandaloneHtml = useCallback(
    async ({ includeNarration }: ExportHtmlOptions) => {
      const { stage, scenes } = useStageStore.getState();
      if (!stage?.id || scenes.length === 0) return;

      // Resolve the destination before anything else awaits: the folder picker
      // needs the click's user activation, which the dynamic import below (and
      // the build itself) would consume.
      const target = await resolveSaveTarget(SAVE_DIR_IDS.html);
      if (!target) return;

      setExporting(true);
      const toastId = toast.loading(t('export.exporting'));

      try {
        // Loaded on demand: the export path pulls in the snapshot collectors,
        // which the header that hosts this hook should not carry.
        const { buildStandaloneHtmlExport, classroomUrlFor } =
          await import('./standalone-html/build-standalone-html');
        const strings = Object.fromEntries(
          STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, t(`export.htmlPlayer.${key}`)]),
        ) as StandalonePlayerStrings;
        // Anyone with the link can open the classroom, so PBL scenes link back
        // to it on this deployment — but only a PBL scene renders that link.
        // Writing the address into a lesson without one puts the exporter's own
        // host into a file that opens on someone else's machine, where
        // `localhost:3100` is a dead link and reads as a broken handover.
        const classroomUrl = scenes.some((scene) => scene.content.type === 'pbl')
          ? classroomUrlFor(window.location.origin, stage.id)
          : undefined;

        const {
          format,
          blob,
          fileName,
          inlineFailures,
          unresolvedMedia,
          missingAudioCount,
          byteSize,
          singleFileBytes,
        } = await buildStandaloneHtmlExport(stage, scenes, {
          strings,
          lang: locale,
          classroomUrl,
          includeNarration,
          // The narrated and silent variants of one lesson would otherwise be
          // saved under the same name; the cloud folder would show
          // `Lesson.html` next to `Lesson(1).html` with no way to tell which
          // one has audio. Only the narrated file is marked — the silent one
          // keeps the plain name.
          ...(includeNarration ? { nameSuffix: t('export.htmlNarrationSuffix') } : {}),
          // The file leaves the app as a distributable copy of generated
          // content, so it carries both halves of the AIGC notice (§6.1) —
          // unless the operator recorded that this order carries them
          // elsewhere (see `aigc-label-preference`).
          aigc: isAigcLabelEnabled()
            ? {
                label: t('export.aigcLabel'),
                ...resolveAigcIdentifiers(
                  // §6.1 wants the service provider's name. A branded deployment
                  // *is* the provider, so its brand stands in until the operator
                  // names a legal entity explicitly.
                  process.env.NEXT_PUBLIC_AIGC_PROVIDER || brand.productName,
                  process.env.NEXT_PUBLIC_AIGC_CONTENT_ID,
                  stage.id,
                ),
              }
            : undefined,
          // Too large for one file: the page plus its media folders, zipped.
          format: 'auto',
          zipReadme: t('export.htmlZipReadme'),
          generator: brand.productName,
        });

        // The file name distinguishes the two variants ("…-带旁白.html"), but the
        // cloud folder must stay the course: deriving it from the file name put
        // the narrated copy in a sibling folder of its own lesson, so the buyer
        // holding the course link saw only the silent one.
        await writeSaveTarget(target, fileName, blob, { deliveryTitle: stage.name });

        const partialCount = inlineFailures.length + unresolvedMedia.length;
        // Bundling failures and missing narration are different problems, so
        // each gets its own wording.
        const notes = [
          partialCount > 0 ? t('export.inlinePartial', { count: partialCount }) : undefined,
          missingAudioCount > 0
            ? t('export.narrationMissing', { count: missingAudioCount })
            : undefined,
        ].filter((note): note is string => !!note);
        if (format === 'zip') {
          // The ZIP only plays once extracted, which nobody expects from an
          // "HTML" export: say why it is a ZIP and what to do with it, and
          // leave the toast up long enough to read.
          log.warn('Standalone HTML export saved as a ZIP:', { singleFileBytes, byteSize });
          toast.warning(
            t('export.htmlZipFallback', { size: formatMegabytes(singleFileBytes ?? byteSize) }),
            {
              id: toastId,
              description: [t('export.htmlZipFallbackDesc'), ...notes].join(' '),
              duration: ZIP_FALLBACK_TOAST_MS,
            },
          );
        } else if (byteSize > STANDALONE_HTML_SIZE_WARNING_BYTES) {
          log.warn('Standalone HTML export is large:', { byteSize });
          toast.warning(
            t(includeNarration ? 'export.htmlLarge' : 'export.htmlLargeSilent', {
              size: formatMegabytes(byteSize),
            }),
            { id: toastId, description: notes.length > 0 ? notes.join(' ') : undefined },
          );
        } else if (notes.length > 0) {
          log.warn('Some referenced assets could not be embedded:', {
            inlineFailures,
            unresolvedMedia,
            missingAudioCount,
          });
          toast.warning(notes.join(' '), { id: toastId });
        } else {
          toast.success(t('export.exportSuccess'), { id: toastId });
        }
      } catch (error) {
        if (error instanceof StandaloneHtmlTooLargeError) {
          // Too large even for the ZIP: its page alone passes the ceiling
          // (media inside interactive scenes stays in the page), or the
          // archive passes 4 GiB. Leaving narration out only helps when it
          // was included.
          log.warn(
            'Standalone HTML export refused as too large:',
            error.kind,
            error.estimatedBytes,
          );
          const size = formatMegabytes(error.estimatedBytes);
          const key =
            error.kind === 'page'
              ? includeNarration
                ? 'export.htmlPageTooLarge'
                : 'export.htmlPageTooLargeSilent'
              : includeNarration
                ? 'export.htmlTooLarge'
                : 'export.htmlTooLargeSilent';
          toast.error(t(key, { size }), { id: toastId });
          return;
        }
        log.error('Standalone HTML export failed:', error);
        toast.error(t('export.exportFailed'), { id: toastId });
      } finally {
        setExporting(false);
      }
    },
    [t, locale, brand.productName],
  );

  return { exporting, exportStandaloneHtml };
}
