'use client';

/**
 * `useRenderVideo` — thin React facade over the global {@link useVideoRenderStore}.
 *
 * The render lifecycle (build ZIP → upload → poll → download) and the selected
 * options both live in the store, so they survive the export menu unmounting
 * (scene switches, menu close) and can be observed from anywhere — e.g. the
 * persistent ring on the export button. This hook just binds `t` and re-exports
 * the reactive slice the menu needs.
 */
import { useCallback } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { resolveSaveTarget, SAVE_DIR_IDS } from '@/lib/download/save-target';

export function useRenderVideo() {
  const { t, locale } = useI18n();
  // The store builds the ZIP that gets rendered, so the brand travels with the
  // request rather than being read there (a store has no React context).
  const brand = useBrand();
  const status = useVideoRenderStore((s) => s.status);
  const percent = useVideoRenderStore((s) => s.percent);
  const etaMs = useVideoRenderStore((s) => s.etaMs);
  const lastElapsedMs = useVideoRenderStore((s) => s.lastElapsedMs);
  const options = useVideoRenderStore((s) => s.options);
  const setOptions = useVideoRenderStore((s) => s.setOptions);
  const startRender = useVideoRenderStore((s) => s.startRender);

  // The destination is picked here, in the click handler: a render takes
  // minutes and the picker only works inside the click's activation window.
  // A dismissed picker means the user changed their mind — stay silent.
  const renderVideo = useCallback(async () => {
    const target = await resolveSaveTarget(SAVE_DIR_IDS.videoMp4);
    if (!target) return;
    await startRender(t, locale, target, brand.productName);
  }, [startRender, t, locale, brand.productName]);

  return {
    rendering: status === 'compiling' || status === 'rendering',
    percent,
    etaMs,
    lastElapsedMs,
    options,
    setOptions,
    renderVideo,
  };
}
