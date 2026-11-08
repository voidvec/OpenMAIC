/** Shared contract for frozen interactive HTML in video export. */

/** Maximum wall-clock wait for one packaged iframe to load and freeze. */
export const INTERACTIVE_READY_TIMEOUT_MS = 8_000;

/** Quiet period after resources are ready, before timers/animations are frozen. */
export const INTERACTIVE_SETTLE_MS = 250;

/**
 * Virtual frame interval for the freeze-time frame clock.
 *
 * Capture runs Chromium in deterministic mode with `--enable-begin-frame-control`,
 * so animation frames arrive only when the capture loop asks for one — and it
 * does not ask while it waits for scenes to report ready. The packaged page
 * therefore drives `requestAnimationFrame` from a timer at this interval, which
 * keeps a canvas page's own draw loop running until the freeze lands.
 */
export const INTERACTIVE_FRAME_INTERVAL_MS = 16;

/** Poll interval for the freeze-time frame clock. */
export const INTERACTIVE_FRAME_POLL_MS = 20;

/**
 * Frame-clock ticks a packaged page must run before its timers stop.
 *
 * Freezing on a frame boundary rather than mid-flight keeps a canvas page's
 * bitmap consistent with the DOM beside it, and one tick is not enough: the
 * parabola lab paints on its second frame while the scrolling scenes need five
 * to seven. A page that paints synchronously requests no frames at all and is
 * released after a short grace instead of being held to this count.
 */
export const INTERACTIVE_FRAME_FLUSH_COUNT = 8;

/** Upper bound on waiting for those frames, for pages that never get them. */
export const INTERACTIVE_FRAME_FLUSH_MS = 2_000;

/**
 * Containers treated as a modal layer that has to be cleared before freezing.
 *
 * Every scene that opens on a rules card covers the board it is about, and a
 * frozen dialog is what the viewer gets for the whole scene instead of the
 * lesson. Only containers that name themselves as a dialog are considered — the
 * heuristic deliberately does not look at "any full-screen element", because
 * clicking a page's real controls would change what the scene is teaching.
 */
export const INTERACTIVE_DIALOG_SELECTOR =
  '[role="dialog"],[role="alertdialog"],.modal,.overlay,.dialog,.backdrop';

/** Most dialog layers one scene may peel off before the freeze gives up. */
export const INTERACTIVE_DIALOG_MAX_ROUNDS = 3;

/**
 * How much of the panel a layer is drawn over counts as hiding it.
 *
 * Measured on this deck, a rules card covers its content column almost exactly
 * (0.995 and 1.0 of the positioned parent), while the column itself is only
 * about a third of a wide frame. Judging by frame area would therefore skip
 * every real dialog, so the comparison is against the layer's own container.
 */
export const INTERACTIVE_DIALOG_COVERAGE = 0.5;

/** Floor so a small nested panel cannot qualify on that ratio alone. */
export const INTERACTIVE_DIALOG_MIN_FRAME_AREA = 0.15;

/**
 * How long one dismissed dialog gets to disappear before the freeze moves on.
 *
 * The click runs the page's own handler synchronously, so the layer is usually
 * gone within a frame; this only bounds pages that animate their exit.
 */
export const INTERACTIVE_DIALOG_SETTLE_MS = 600;

/**
 * Hard budget for clearing dialogs in one scene, across all rounds.
 *
 * Clearing has to finish well inside the readiness deadline, or a page that
 * keeps presenting dialogs would be reported as a failure to render instead.
 */
export const INTERACTIVE_DIALOG_BUDGET_MS = 1_500;

/** postMessage discriminator shared by the packaged child page and parent composition. */
export const INTERACTIVE_STATIC_MESSAGE_FLAG = '__openmaicInteractiveStatic';

/** Stable preparation failures recorded by the browser-side adapter. */
export type InteractiveHtmlFailure =
  | 'missing-html'
  | 'packaging-failed'
  | 'unresolved-resource'
  | 'too-large';
