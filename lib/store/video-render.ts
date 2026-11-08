'use client';

/**
 * Global store for the one-click MP4 render (issue #866).
 *
 * The render is async and long (a 10-minute classroom takes ~10 minutes), so
 * its progress must outlive the export menu: the user can close the menu, switch
 * scenes, and reopen the menu, and still see live progress. Keeping the state in
 * a component (as the first cut did) meant it died with the menu, and the
 * re-mounted menu reset its "already rendering" ref — letting the user submit a
 * duplicate render. Hoisting the whole lifecycle here fixes both.
 *
 * The store owns the submit → poll → download loop. Progress is a percentage
 * plus an estimated time remaining (extrapolated from elapsed time and smoothed
 * with an EMA); no producer stage strings are surfaced. i18n stays out of the
 * store: callers pass `t`, and toasts use sonner's global singleton so they
 * still fire if the calling component has unmounted.
 */
import { create } from 'zustand';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { runPolledTask } from '@/lib/media/polled-task';
import { writeSaveTarget, type SaveTarget } from '@/lib/download/save-target';
import { peekDeliveryRevision } from '@/lib/download/delivery-revision';
import {
  NoScenesError,
  sanitizeFilename,
  VIDEO_RESOLUTIONS,
  type VideoFps,
  type VideoQuality,
  type VideoResolution,
} from '@/lib/video-export-app/export-options';
import { measureVideoDuration, saveRenderedVideo } from '@/lib/device-storage/rendered-video';
import type { Locale } from '@/lib/i18n';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { observeExportChanges } from '@/lib/video-export-app/observe-export-changes';
import { resolveExportStageName } from '@/lib/video-export-app/resolve-stage-name';

type BuildExportZipResult = import('@/lib/video-export-app/build-export-zip').BuildExportZipResult;

const log = createLogger('VideoRenderStore');

const POLL_INTERVAL_MS = 3000;
/**
 * Wait budget used when the render service does not advertise its own job
 * deadline (older services). This is the historical fixed ceiling.
 */
const FALLBACK_POLL_BUDGET_MS = 60 * 60 * 1000;
/**
 * Absolute ceiling on the wait, whatever the service advertises. Guards against
 * a bogus deadline turning a stuck job into an unbounded poll.
 */
const MAX_POLL_BUDGET_MS = 4 * 60 * 60 * 1000;
/**
 * Slack past the service's deadline. The service stops *capturing* at its
 * deadline but still has to encode and remux the frames it already has, so a
 * wait ending exactly at the deadline would abandon a job that is about to
 * succeed.
 */
const DEADLINE_GRACE_MS = 5 * 60 * 1000;
/**
 * Attempt ceiling sized for the absolute cap. The real bound is the time-based
 * budget below: a fixed attempt count shorter than the service's deadline made
 * the client give up (and cancel) renders that were still progressing, which
 * made any classroom longer than that ceiling impossible to export.
 */
const MAX_POLL_ATTEMPTS = Math.ceil(MAX_POLL_BUDGET_MS / POLL_INTERVAL_MS);
/** Below this percent the extrapolated ETA is too noisy to show. */
const ETA_MIN_PERCENT = 3;
/**
 * EMA weight for the newest *speed* sample (percent-per-ms). Lower = smoother
 * and laggier. We smooth speed rather than the whole-run average because this
 * render is not uniform (prep → frame capture, which drops 4→1 worker mid-way,
 * → encode): a recent-speed estimate reacts to those regime changes, and the
 * EMA keeps it from jittering on the producer's uneven percent updates.
 */
const SPEED_SMOOTHING = 0.3;

export type VideoRenderStatus = 'idle' | 'compiling' | 'rendering' | 'succeeded' | 'failed';

/** Minimal i18n surface the store needs, injected by callers. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RenderOptions {
  resolution?: VideoResolution;
  fps?: VideoFps;
  quality?: VideoQuality;
  /** Burn subtitles into the MP4. Default false (sidecar SRT/VTT only). */
  burnInSubtitles?: boolean;
}

/** Fully-resolved render options (the store always holds concrete values). */
type ResolvedOptions = Required<RenderOptions>;

const DEFAULT_OPTIONS: ResolvedOptions = {
  resolution: '1080p',
  // 24 rather than 30: a narrated classroom is mostly slow motion, where the
  // extra frames cost a fifth of the wall time and buy nothing visible. The
  // dialog keeps 30/60 as presets and accepts any rate the render service takes
  // (1–120), so a submission spec asking for 25fps is not a dead end.
  fps: 24,
  quality: 'standard',
  burnInSubtitles: false,
};

interface JobStatusResponse {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  currentStage?: string;
  error?: string;
  done?: boolean;
  /**
   * End-to-end wall time of a terminal job, reported by the render service:
   * submission (queue wait + extraction included) to the finished MP4. This is
   * the number worth recording — a client-measured duration also contains the
   * browser-side ZIP compile, which is not what makes a render slow.
   */
  elapsedMs?: number;
}

/**
 * Last completed export's duration, persisted so it survives a page reload.
 * Deliberately a single record: the durable, comparable history is the render
 * service's own metrics ledger, one line per render with the configuration
 * that produced it.
 */
const LAST_EXPORT_STORAGE_KEY = 'maic:video-render:last-export';

interface LastExportRecord {
  /** Render-service wall time in ms. */
  elapsedMs: number;
  /** When it finished, epoch ms. */
  at: number;
  filename: string;
}

function readLastExport(): LastExportRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LAST_EXPORT_STORAGE_KEY) ?? 'null',
    ) as LastExportRecord | null;
    return parsed && typeof parsed.elapsedMs === 'number' && parsed.elapsedMs >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastExport(record: LastExportRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_EXPORT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode / quota: the in-memory value is still shown this session.
  }
}

interface VideoRenderState {
  status: VideoRenderStatus;
  /** 0..100. */
  percent: number;
  /** Estimated milliseconds remaining, or null while unknown. */
  etaMs: number | null;
  /**
   * Wall time of the last successful export (ms), as reported by the render
   * service. Shown after a render so the cost of an option change (fps,
   * quality, chunk parallelism) is visible instead of guessed.
   */
  lastElapsedMs: number | null;
  filename: string | null;
  error: string | null;
  /**
   * The user's selected render options. Held in the store (not the menu
   * component) so they survive the menu unmounting on scene switches and, while
   * a render runs, reflect the options that render is actually using.
   */
  options: ResolvedOptions;
  setOptions: (patch: Partial<ResolvedOptions>) => void;
  /** True while a render is in flight (compiling or rendering). */
  isActive: () => boolean;
  /**
   * `locale` is the export's, not the store's: it is baked into the emitted
   * card chrome.
   *
   * `saveTarget` must be resolved by the caller from its click handler — the
   * folder picker needs the click's user activation, and a render finishes
   * long after that window closes. Defaults to the browser download folder so
   * non-interactive callers (and tests) still save.
   */
  /**
   * `brandName` heads the emitted project and its README. The store cannot read
   * the brand context, so the caller passes it from `useBrand()`.
   */
  startRender: (
    t: Translate,
    locale: Locale,
    saveTarget?: SaveTarget,
    brandName?: string,
  ) => Promise<void>;
  reset: () => void;
}

/** Whether a status means a render is still in flight. */
function inFlight(status: VideoRenderStatus): boolean {
  return status === 'compiling' || status === 'rendering';
}

// One in-memory retry slot; the active request and the slot share the same Blob.
let cachedZip: {
  stageId: string;
  resolution: VideoResolution;
  burnInSubtitles: boolean;
  locale: Locale;
  result: BuildExportZipResult;
} | null = null;
let exportRevision = 0;
let activeRenders = 0;
let stopObserving: (() => void) | undefined;

function releaseIdleObservers() {
  if (activeRenders === 0 && !cachedZip) {
    stopObserving?.();
    stopObserving = undefined;
  }
}

function invalidateCachedZip() {
  exportRevision += 1;
  cachedZip = null;
  releaseIdleObservers();
}

function rejectionMessageKey(status: number | null, reason?: string): string | undefined {
  if (status === 413) return 'export.videoTooLarge';
  if (status !== 429) return undefined;
  if (reason === 'queue_full') return 'export.videoQueueFull';
  if (reason === 'per_identity_limit') return 'export.videoRenderInProgress';
  return undefined;
}

export const useVideoRenderStore = create<VideoRenderState>()((set, get) => ({
  status: 'idle',
  percent: 0,
  etaMs: null,
  lastElapsedMs: readLastExport()?.elapsedMs ?? null,
  filename: null,
  error: null,
  options: DEFAULT_OPTIONS,

  setOptions: (patch) => {
    const previous = get().options;
    const options = { ...previous, ...patch };
    if (
      options.resolution !== previous.resolution ||
      options.burnInSubtitles !== previous.burnInSubtitles
    )
      invalidateCachedZip();
    set({ options });
  },

  isActive: () => inFlight(get().status),

  reset: () => {
    invalidateCachedZip();
    set({ status: 'idle', percent: 0, etaMs: null, filename: null, error: null });
  },

  startRender: async (t, locale, saveTarget = { kind: 'browser' }, brandName) => {
    // Guard against a duplicate submit — the whole reason state lives here.
    if (inFlight(get().status)) return;

    activeRenders += 1;
    stopObserving ??= observeExportChanges(invalidateCachedZip);
    const { resolution, fps, quality, burnInSubtitles } = get().options;
    const { stage } = useStageStore.getState();
    const stageId = stage?.id;
    if (
      cachedZip &&
      (cachedZip.stageId !== stageId ||
        cachedZip.resolution !== resolution ||
        cachedZip.burnInSubtitles !== burnInSubtitles ||
        cachedZip.locale !== locale)
    )
      invalidateCachedZip();
    const cached = cachedZip?.result;

    set({
      status: cached ? 'rendering' : 'compiling',
      percent: 0,
      etaMs: null,
      filename: null,
      error: null,
    });
    const toastId = toast.loading(t(cached ? 'export.videoRendering' : 'export.videoCompiling'));

    let zipBlob: Blob;
    let stageName: string;
    let missingCount = 0;
    let errorCount = 0;
    try {
      let built = cached;
      if (built && stage) {
        const currentName = await resolveExportStageName(stage);
        // The async name read can overlap an edit/reset. Never reuse a slot
        // that was released while reading, even when the name still matches.
        if (cachedZip?.result !== built || currentName !== built.stageName) {
          invalidateCachedZip();
          built = undefined;
          set({ status: 'compiling' });
          toast.loading(t('export.videoCompiling'), { id: toastId });
        }
      }
      if (!built) {
        const revision = exportRevision;
        const compileStageId = useStageStore.getState().stage?.id;
        const { buildExportZip } = await import('@/lib/video-export-app/build-export-zip');
        built = await buildExportZip({
          resolution,
          burnInSubtitles,
          locale,
          ...(brandName ? { brandName } : {}),
        });
        // Changes during compilation (including reset or switching away and
        // back) cannot repopulate the retry slot with an obsolete snapshot.
        if (compileStageId && revision === exportRevision) {
          cachedZip = {
            stageId: compileStageId,
            resolution,
            burnInSubtitles,
            locale,
            result: built,
          };
        }
      }
      ({ zipBlob, stageName, missingCount, errorCount } = built);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ status: 'failed', error: message });
      if (error instanceof NoScenesError) {
        toast.error(t('export.videoNoScenes'), { id: toastId });
      } else {
        log.error('Video render (compile) failed:', error);
        toast.error(t('export.videoFailed'), { id: toastId });
      }
      activeRenders -= 1;
      releaseIdleObservers();
      return;
    }

    const filename = `${sanitizeFilename(stageName)}.mp4`;
    set({ status: 'rendering', filename });

    // ETA via recent speed: track the previous (percent, timestamp) sample,
    // derive an instantaneous percent-per-ms rate, EMA-smooth it, and project
    // the remaining percent onto it. Reacts to the render's speed regime
    // changes (worker drop, encode) far better than a whole-run average.
    let lastPercent: number | null = null;
    let lastTs = 0;
    let smoothedSpeed: number | null = null; // percent per ms
    // Set once the service accepts the job. Lets the catch below distinguish a
    // *submit* failure (nothing started) from a failure after the render began
    // (hard error, and cancel the server job to free its slot).
    let submittedJobId: string | null = null;
    // HTTP status of a failed submit, so the catch can tell "service genuinely
    // unavailable" (degrade to ZIP) from a real rejection like 429/413/5xx
    // (surface the error instead of an unsolicited download). null = fetch threw.
    let submitStatus: number | null = null;
    let submitReason: string | undefined;
    // Wall time reported by the render service for the finished job. The
    // client-measured fallback is only for an older service that omits it, and
    // it necessarily includes the browser-side ZIP compile.
    let serverElapsedMs: number | null = null;
    // How long to keep polling, from the service's advertised job deadline. It
    // is per-submit: a queue wait counts against the same deadline.
    let pollBudgetMs = FALLBACK_POLL_BUDGET_MS;
    const startedAtMs = Date.now();

    try {
      const form = new FormData();
      form.append('project', zipBlob, 'project.zip');
      form.append('fps', String(fps));
      form.append('quality', quality);
      form.append('format', 'mp4');

      toast.loading(t('export.videoRendering'), { id: toastId });

      const mp4 = await runPolledTask<Blob>({
        label: 'render-video',
        intervalMs: POLL_INTERVAL_MS,
        maxAttempts: MAX_POLL_ATTEMPTS,
        submit: async () => {
          // The course name travels beside the multipart body, not inside it:
          // the submit route forwards the body verbatim, so it can only learn
          // the name from headers. Percent-encoded because a title is Chinese.
          // The delivery worker uses it as the cloud folder name.
          const res = await fetch('/api/export-video/render', {
            method: 'POST',
            body: form,
            headers: {
              'x-deliver-title': encodeURIComponent(stageName),
              'x-deliver-filename': encodeURIComponent(filename),
              // The round the video belongs to, so it lands in the same `v<n>/`
              // as the delivery pack exported for the same handover.
              'x-deliver-revision': String(peekDeliveryRevision()),
              // MP4 delivery is queued server-side by job id, so the operator's
              // "upload to cloud" switch (Settings → 通用) has to be carried
              // here; there is no later point at which it could be applied.
              ...(useSettingsStore.getState().deliverToCloud ? {} : { 'x-deliver-cloud': '0' }),
            },
          });
          const data = (await res.json().catch(() => ({}))) as {
            jobId?: string;
            deadlineMs?: number;
            error?: string;
            details?: string;
            reason?: string;
          };
          if (!res.ok || !data.jobId) {
            submitStatus = res.status;
            submitReason = data.reason;
            const detail = [data.error, data.details].filter(Boolean).join(': ');
            return { status: 'failed', message: detail || `HTTP ${res.status}` };
          }
          if (typeof data.deadlineMs === 'number' && data.deadlineMs > 0) {
            pollBudgetMs = Math.min(data.deadlineMs + DEADLINE_GRACE_MS, MAX_POLL_BUDGET_MS);
          }
          submittedJobId = data.jobId;
          return { status: 'submitted', taskId: data.jobId };
        },
        poll: async (jobId) => {
          // Past the service's deadline plus assembly slack the job will never
          // report success, so stop waiting instead of burning the attempt cap.
          if (Date.now() - startedAtMs > pollBudgetMs) {
            const minutes = Math.round(pollBudgetMs / 60_000);
            return { status: 'failed', message: `render exceeded its ${minutes}m budget` };
          }
          const res = await fetch(`/api/export-video/render/${jobId}`);
          const data = (await res.json().catch(() => ({}))) as JobStatusResponse;
          if (!res.ok) return { status: 'failed', message: data.error || `HTTP ${res.status}` };

          const percent = Math.round((data.progress ?? 0) * 100);

          // Derive a recent speed (percent/ms) from the delta since the last
          // sample, EMA-smooth it, then project the remaining percent. Only
          // forward progress updates the speed; stalls/regressions are ignored
          // so a paused stage doesn't blow the ETA up to infinity.
          const now = Date.now();
          let etaMs = get().etaMs;
          if (lastPercent != null && percent > lastPercent && now > lastTs) {
            const sample = (percent - lastPercent) / (now - lastTs);
            smoothedSpeed =
              smoothedSpeed == null
                ? sample
                : SPEED_SMOOTHING * sample + (1 - SPEED_SMOOTHING) * smoothedSpeed;
          }
          if (percent >= ETA_MIN_PERCENT && percent < 100 && smoothedSpeed && smoothedSpeed > 0) {
            etaMs = (100 - percent) / smoothedSpeed;
          }
          if (lastPercent == null || percent > lastPercent) {
            lastPercent = percent;
            lastTs = now;
          }
          set({ percent, etaMs });

          if (data.status === 'succeeded') {
            if (typeof data.elapsedMs === 'number' && data.elapsedMs >= 0) {
              serverElapsedMs = data.elapsedMs;
            }
            const dl = await fetch(`/api/export-video/render/${jobId}/download`);
            if (!dl.ok) return { status: 'failed', message: `download HTTP ${dl.status}` };
            return { status: 'done', result: await dl.blob() };
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            return { status: 'failed', message: data.error || data.status };
          }
          return { status: 'pending', detail: data.currentStage };
        },
      });

      await writeSaveTarget(saveTarget, filename, mp4);
      // Keep the bytes where the delivery export can find them: it runs minutes
      // later, and the render service keeps neither the job record nor the file
      // across a container restart. Fire-and-forget — a browser that refuses
      // 45 MB of quota must not turn a finished render into a failure.
      void measureVideoDuration(mp4).then((durationSec) =>
        saveRenderedVideo(stageId ?? '', mp4, {
          filename,
          width: VIDEO_RESOLUTIONS[resolution].width,
          height: VIDEO_RESOLUTIONS[resolution].height,
          fps,
          quality,
          durationSec,
        }),
      );
      invalidateCachedZip();
      const elapsedMs = serverElapsedMs ?? Date.now() - startedAtMs;
      writeLastExport({ elapsedMs, at: Date.now(), filename });
      set({ status: 'succeeded', percent: 100, etaMs: 0, lastElapsedMs: elapsedMs });
      toast.success(t('export.videoMp4Success'), { id: toastId });
      if (missingCount > 0 || errorCount > 0) {
        toast.warning(t('export.videoWarnings', { assets: missingCount, diagnostics: errorCount }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (submittedJobId == null) {
        // The submit never succeeded. Only degrade to the ZIP when the service
        // is genuinely unavailable — not configured (501) or unreachable (fetch
        // threw, submitStatus null). For real rejections (429 busy, 413 too
        // large, 5xx) surface the actual reason instead of silently downloading
        // a ZIP the user didn't ask for, so the failure is honest and retryable.
        const unavailable = submitStatus == null || submitStatus === 501;
        if (unavailable) {
          // Same destination as the MP4 would have used: the chosen folder
          // holds whichever artefact the render actually produced.
          await writeSaveTarget(saveTarget, `${sanitizeFilename(stageName)}-video.zip`, zipBlob);
          invalidateCachedZip();
          set({ status: 'idle', percent: 0, etaMs: null });
          toast.info(t('export.videoServiceUnavailable'), { id: toastId });
        } else {
          if (submitStatus === 400 || submitStatus === 413) invalidateCachedZip();
          set({ status: 'failed', error: message });
          const key = rejectionMessageKey(submitStatus, submitReason);
          toast.error(t(key ?? 'export.videoFailed'), { id: toastId });
        }
      } else {
        // The render started but failed / timed out. Cancel the server job so it
        // doesn't hold a concurrency slot and scratch space, then surface the error.
        void fetch(`/api/export-video/render/${submittedJobId}`, { method: 'DELETE' }).catch(
          () => {},
        );
        log.error('Video render failed:', error);
        set({ status: 'failed', error: message });
        toast.error(t('export.videoFailed'), { id: toastId });
      }
    } finally {
      activeRenders -= 1;
      releaseIdleObservers();
    }
  },
}));
