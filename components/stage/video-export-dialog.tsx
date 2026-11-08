'use client';

/**
 * Video-export dialog — a centered modal for configuring and running a
 * classroom → video export.
 *
 * Replaces the cramped dropdown section (`video-export-menu.tsx`): parameters
 * (resolution / fps / quality / subtitles) get room to group, and the modal has
 * a stable lifecycle so a multi-minute render's progress, ETA, and result stay
 * visible instead of vanishing when a dropdown loses focus.
 *
 * Two render paths share one project ZIP:
 * - **Render MP4** (when the render service is configured) — uploads the ZIP,
 *   polls the async job, downloads the MP4. Exposes fps / quality + live progress.
 * - **Download ZIP** — the always-available degrade path (local CLI rendering).
 *
 * Subtitles are burned in only when toggled on (default off, #867 item 2); the
 * "Download subtitles" button always yields an SRT the user can add in an editor.
 */
import { useEffect, useState } from 'react';
import { Film, Loader2, Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { useExportVideo } from '@/lib/video-export-app/use-export-video';
import { useRenderVideo } from '@/lib/video-export-app/use-render-video';
import { useDownloadSubtitles } from '@/lib/video-export-app/use-download-subtitles';
import {
  DELIVERY_PRESET,
  isRenderableFps,
  VIDEO_FPS,
  VIDEO_FPS_MAX,
  VIDEO_FPS_MIN,
  VIDEO_QUALITIES,
  VIDEO_RESOLUTIONS,
  type VideoResolution,
} from '@/lib/video-export-app/export-options';

const RESOLUTIONS = Object.keys(VIDEO_RESOLUTIONS) as VideoResolution[];

/** Format an ETA (ms) as a short localized "about X min Y sec" / "about Y sec". */
function formatRemaining(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? t('export.videoEtaMinSec', { min, sec }) : t('export.videoEtaSec', { sec });
}

/** A row of mutually-exclusive small pill buttons. */
function OptionRow<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (v: T) => string;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      <div className="flex gap-1.5">
        {options.map((opt) => (
          <button
            key={String(opt)}
            onClick={() => onChange(opt)}
            disabled={disabled}
            className={cn(
              'flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50',
              opt === value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
            )}
          >
            {format ? format(opt) : String(opt)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The typed frame-rate field.
 *
 * Split into its own component and re-mounted via `key` so an externally changed
 * value (a preset click, or the handover-preset button) resets the draft without
 * a state-syncing effect — calling setState from an effect is the cascading
 * render the lint rule refuses, and remounting is cheaper than reconciling it.
 */
function FpsInput({
  value,
  onCommit,
  disabled,
  placeholder,
  className,
}: {
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
  placeholder: string;
  className: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (isRenderableFps(parsed)) onCommit(parsed);
    else setDraft(String(value)); // out of range: revert, do not submit
  };
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // Enter commits directly instead of relying on blur: the value must not
        // depend on where focus goes next, and a blur round-trip is awkward to
        // drive from a test.
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') setDraft(String(value));
      }}
      disabled={disabled}
      inputMode="numeric"
      placeholder={placeholder}
      aria-label={placeholder}
      className={className}
    />
  );
}

/**
 * Frame rate: presets plus free entry.
 *
 * The presets cover the usual cases; the field exists because submission specs
 * name rates that are in no menu (25fps is the PAL legacy several provincial
 * education bureaus still require). The typed value is validated on commit, not
 * per keystroke, so typing "25" does not briefly submit "2"; an out-of-range
 * entry reverts to the last good value instead of failing a long render.
 */
function FpsRow({
  label,
  value,
  onChange,
  disabled,
  customLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  customLabel: string;
}) {
  const isCustom = !VIDEO_FPS.includes(value as (typeof VIDEO_FPS)[number]);
  const buttonClass = (active: boolean) =>
    cn(
      'flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50',
      active
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700',
    );

  return (
    <div>
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">
        {label}
        <span className="ml-1 opacity-70">
          ({VIDEO_FPS_MIN}–{VIDEO_FPS_MAX})
        </span>
      </div>
      <div className="flex gap-1.5">
        {VIDEO_FPS.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            disabled={disabled}
            className={buttonClass(opt === value)}
          >
            {opt}
          </button>
        ))}
        <FpsInput
          key={value}
          value={value}
          onCommit={onChange}
          disabled={disabled}
          placeholder={customLabel}
          className={cn(
            'w-16 shrink-0 px-2 py-1.5 text-xs text-center rounded-md border bg-transparent transition-colors disabled:opacity-50',
            isCustom ? 'border-primary text-primary' : 'border-gray-200 dark:border-gray-700',
          )}
        />
      </div>
    </div>
  );
}

export function VideoExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { exporting: isExportingVideo, exportVideo } = useExportVideo();
  const { rendering, percent, etaMs, lastElapsedMs, options, setOptions, renderVideo } =
    useRenderVideo();
  const { downloading, downloadSubtitles } = useDownloadSubtitles();
  const { resolution, fps, quality, burnInSubtitles } = options;
  // undefined = unknown (still probing); true/false = capability answer.
  const [serviceEnabled, setServiceEnabled] = useState<boolean | undefined>(undefined);
  const [accepting, setAccepting] = useState<boolean | undefined>(undefined);
  const [checking, setChecking] = useState(true);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [previousOpen, setPreviousOpen] = useState(open);
  // Reopening must not briefly enable MP4 using the last opening's answer.
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setChecking(true);
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    fetch('/api/export-video/capability', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Capability check failed');
        return r.json();
      })
      .then((d: { enabled?: boolean; accepting?: boolean }) => {
        if (!active) return;
        setServiceEnabled(Boolean(d.enabled));
        setAccepting(d.accepting);
      })
      .catch(() => {
        if (active) setServiceEnabled(false);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, probeAttempt]);

  // Any in-flight export operation (ZIP build, in-app render, or subtitle
  // download) blocks the others — they share one compile/store critical section.
  const busy = isExportingVideo || rendering || downloading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="w-4 h-4 text-gray-400 shrink-0" />
            {t('export.video')}
          </DialogTitle>
          <DialogDescription>{t('export.videoDesc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Output settings */}
          {/* Handover preset: one click sets the four values that together make a
              deliverable master. Captions are in the set precisely because that
              is the one that has been forgotten in production. */}
          <button
            onClick={() => setOptions({ ...DELIVERY_PRESET })}
            disabled={busy}
            className="flex flex-wrap items-center justify-center gap-1 rounded-md border border-dashed border-primary/40 bg-primary/5 px-2 py-1.5 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            <span className="font-medium">{t('export.videoDeliveryPreset')}</span>
            <span className="opacity-80">
              {DELIVERY_PRESET.resolution} · {DELIVERY_PRESET.fps}fps ·{' '}
              {t('export.videoQuality_standard')} · {t('export.videoBurnSubtitles')}
            </span>
          </button>
          <OptionRow
            label={t('export.videoResolution')}
            options={RESOLUTIONS}
            value={resolution}
            onChange={(resolution) => setOptions({ resolution })}
            format={(r) => (r === '4k' ? '4K' : r)}
            disabled={busy}
          />
          {serviceEnabled && (
            <>
              <FpsRow
                label={t('export.videoFps')}
                value={fps}
                onChange={(fps) => setOptions({ fps })}
                disabled={busy}
                customLabel={t('export.videoFpsCustom')}
              />
              <OptionRow
                label={t('export.videoQuality')}
                options={VIDEO_QUALITIES}
                value={quality}
                onChange={(quality) => setOptions({ quality })}
                format={(q) => t(`export.videoQuality_${q}`)}
                disabled={busy}
              />
            </>
          )}

          {/* Subtitles */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm">{t('export.videoBurnSubtitles')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('export.videoBurnSubtitlesDesc')}
                </div>
              </div>
              <Switch
                checked={burnInSubtitles}
                onCheckedChange={(burnInSubtitles) => setOptions({ burnInSubtitles })}
                disabled={busy}
              />
            </div>
            <button
              onClick={() => downloadSubtitles('srt')}
              disabled={busy || downloading}
              className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {downloading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Download className="w-3 h-3" />
              )}
              {t('export.videoDownloadSubtitles')}
            </button>
          </div>

          {/* Progress */}
          {rendering && (
            <div>
              <Progress value={percent} />
              <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                {etaMs != null
                  ? t('export.videoProgressWithEta', {
                      percent,
                      remaining: formatRemaining(etaMs, t),
                    })
                  : t('export.videoProgress', { percent })}
              </div>
            </div>
          )}

          {/* Last export cost — makes an fps/quality change comparable instead of
              a guess. The render service keeps the durable per-run record. */}
          {!rendering && lastElapsedMs != null && (
            <div className="text-[11px] text-gray-400 dark:text-gray-500">
              {t('export.videoLastExport', { duration: formatRemaining(lastElapsedMs, t) })}
            </div>
          )}

          {/* Actions */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 flex flex-col gap-1.5">
            {serviceEnabled && (
              <button
                onClick={() => renderVideo()}
                disabled={busy || checking || accepting === false}
                className="w-full px-2 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {rendering && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('export.videoRenderMp4')}
              </button>
            )}
            {serviceEnabled && accepting === false && (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span role="status">{t('export.videoQueueBusy')}</span>
                <button
                  onClick={() => {
                    setChecking(true);
                    setProbeAttempt((attempt) => attempt + 1);
                  }}
                  disabled={checking || busy}
                  className="shrink-0 underline underline-offset-2 disabled:opacity-50"
                >
                  {checking ? t('export.videoCheckingQueue') : t('export.videoRecheckQueue')}
                </button>
              </div>
            )}
            <button
              onClick={() => exportVideo(resolution, burnInSubtitles)}
              disabled={busy}
              className="w-full px-2 py-2 text-sm rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {isExportingVideo && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('export.videoDownloadZip')}
            </button>
            {serviceEnabled === false && (
              <div className="text-[11px] text-gray-400 dark:text-gray-500">
                {t('export.videoServiceHint')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
