/** Lightweight video-export options shared by always-loaded classroom UI. */

/** Selectable render resolutions (16:9). Width drives slide snapshots and Quiz layout. */
export const VIDEO_RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
} as const;

export type VideoResolution = keyof typeof VIDEO_RESOLUTIONS;

/**
 * Quick-pick frame rates for MP4 rendering. These are shortcuts, not a
 * whitelist: contest submission specs often ask for a rate nobody puts in a
 * menu (25fps is the PAL legacy most provincial education bureaus still cite),
 * so the dialog also takes a typed value.
 */
export const VIDEO_FPS = [24, 30, 60] as const;

/**
 * Frame-rate bounds the render service enforces (`render-service/src/main.ts`
 * rejects anything outside 1–120). Clamped in the UI so an out-of-range entry
 * fails at the input instead of at the end of a 70-minute render.
 *
 * Note: *distributed chunk execution* is stricter — it assembles chunks on a
 * 24/30/60 grid only. That path is off by default, so a custom rate works on the
 * standard single-machine render. The browser cannot see the service's setting,
 * so this bound stays wide and the render service rejects an incompatible rate
 * at admission (`parseOptions` → HTTP 400) instead of failing the job later.
 */
export const VIDEO_FPS_MIN = 1;
export const VIDEO_FPS_MAX = 120;

/** Frame rate is a plain integer; the presets above are just common values. */
export type VideoFps = number;

/** Whether the render service will accept this frame rate. */
export function isRenderableFps(value: number): boolean {
  return Number.isInteger(value) && value >= VIDEO_FPS_MIN && value <= VIDEO_FPS_MAX;
}

/** Producer quality presets (speed vs fidelity). */
export const VIDEO_QUALITIES = ['draft', 'standard', 'high'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/**
 * The configuration used for a customer handover, in one place.
 *
 * Kept as a single exported object rather than four literals repeated in the
 * dialog, the export script, and the runbook, because the parts that have
 * actually gone wrong in production are the ones nobody restated: captions were
 * exported from a default-off switch and reached the customer with no subtitles
 * at all while the shipped SRT sat unused.
 *
 * 30fps rather than the 24fps product default: submission specs that name a rate
 * name 25 or 30 far more often than 24, and 24 only exists as a render-time
 * saver. Draft quality is excluded on purpose — it is a benchmarking preset.
 */
export const DELIVERY_PRESET = {
  resolution: '1080p',
  fps: 30,
  quality: 'standard',
  burnInSubtitles: true,
} satisfies {
  resolution: VideoResolution;
  fps: VideoFps;
  quality: VideoQuality;
  burnInSubtitles: boolean;
};

export class NoScenesError extends Error {}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'classroom';
}
