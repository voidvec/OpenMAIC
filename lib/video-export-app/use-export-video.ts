'use client';

/**
 * `useExportVideo` — download the classroom as a self-contained Hyperframes
 * project ZIP for local CLI rendering.
 *
 * This is the degrade path (and #865's original behavior): the whole pipeline
 * runs in the browser via {@link buildExportZip}, then the ZIP is saved to disk.
 * When the render service is configured, `useRenderVideo` uploads the same ZIP
 * to produce an MP4 in-app instead.
 *
 * App-side / impure: imperative store read, a single sonner toast id for
 * progress, interactive save target ({@link resolveSaveTarget}).
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import { createLogger } from '@/lib/logger';
import { resolveSaveTarget, writeSaveTarget, SAVE_DIR_IDS } from '@/lib/download/save-target';
import { acquireExport, releaseExport } from './export-in-flight';
import {
  NoScenesError,
  sanitizeFilename,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
} from './export-options';

const log = createLogger('ExportVideo');

// Re-exported for existing importers (e.g. the export menu).
export { VIDEO_RESOLUTIONS };
export type { VideoResolution };

export function useExportVideo() {
  const [exporting, setExporting] = useState(false);
  const { t, locale } = useI18n();
  // The ZIP is headed with this deployment's name, not the one it was built from.
  const brand = useBrand();

  const exportVideo = useCallback(
    async (resolution: VideoResolution = '1080p', burnInSubtitles = false) => {
      // Shared with the subtitles-only download: only one export operation reads
      // the stage store / Dexie / off-screen renders at a time. The lock comes
      // first because the folder picker below can stay open indefinitely.
      if (!acquireExport()) return;

      // Resolve the destination before compiling: the folder picker needs the
      // click's user activation, which is long gone once the ZIP is ready.
      // `acquireExport` is synchronous, so the activation is still live here.
      const target = await resolveSaveTarget(SAVE_DIR_IDS.videoZip);
      if (!target) {
        releaseExport();
        return;
      }

      setExporting(true);
      const toastId = toast.loading(t('export.videoCompiling'));

      try {
        toast.loading(t('export.videoRendering'), { id: toastId });
        const { buildExportZip } = await import('./build-export-zip');
        const { zipBlob, stageName, missingCount, errorCount } = await buildExportZip({
          resolution,
          burnInSubtitles,
          locale,
          brandName: brand.productName,
        });

        toast.loading(t('export.videoPackaging'), { id: toastId });
        await writeSaveTarget(target, `${sanitizeFilename(stageName)}-video.zip`, zipBlob);
        toast.success(t('export.videoSuccess'), { id: toastId });

        if (missingCount > 0 || errorCount > 0) {
          toast.warning(
            t('export.videoWarnings', { assets: missingCount, diagnostics: errorCount }),
          );
        }
      } catch (error) {
        if (error instanceof NoScenesError) {
          toast.error(t('export.videoNoScenes'), { id: toastId });
        } else {
          log.error('Video export failed:', error);
          toast.error(t('export.videoFailed'), { id: toastId });
        }
      } finally {
        releaseExport();
        setExporting(false);
      }
    },
    [t, locale, brand.productName],
  );

  return { exporting, exportVideo };
}
