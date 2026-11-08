'use client';

/**
 * Deep app-side module that turns authored interactive HTML into bounded,
 * self-contained pages ready for the pure video compiler and byte collector.
 */
import type { Scene } from '@/lib/types/stage';
import { inlineHtmlAssets, type FetchAsset } from '@/lib/export/inline-assets';
import { injectIntoDocumentHead } from '@/lib/utils/html-document';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import type { InteractiveHtmlMeta, InteractiveHtmlSource } from '@/lib/video-export/deps';
import {
  INTERACTIVE_DIALOG_BUDGET_MS,
  INTERACTIVE_DIALOG_COVERAGE,
  INTERACTIVE_DIALOG_MAX_ROUNDS,
  INTERACTIVE_DIALOG_MIN_FRAME_AREA,
  INTERACTIVE_DIALOG_SELECTOR,
  INTERACTIVE_DIALOG_SETTLE_MS,
  INTERACTIVE_FRAME_FLUSH_COUNT,
  INTERACTIVE_FRAME_FLUSH_MS,
  INTERACTIVE_FRAME_INTERVAL_MS,
  INTERACTIVE_FRAME_POLL_MS,
  INTERACTIVE_READY_TIMEOUT_MS,
  INTERACTIVE_SETTLE_MS,
  INTERACTIVE_STATIC_MESSAGE_FLAG,
} from '@/lib/video-export/interactive-static';

const DEFAULT_MAX_HTML_BYTES = 32 * 1024 * 1024;

export interface PreparedInteractiveHtmlSet extends InteractiveHtmlSource {
  /** Exact packaged HTML for an owning asset-plan entry. */
  content(assetId: string): string | undefined;
}

export interface PrepareInteractiveHtmlOptions {
  /** Deployment origin when packaging outside a browser. */
  baseUrl?: string;
  fetcher?: FetchAsset;
  maxHtmlBytes?: number;
}

function staticCaptureInjection(): string {
  const flag = JSON.stringify(INTERACTIVE_STATIC_MESSAGE_FLAG);
  const settleMs = INTERACTIVE_SETTLE_MS;
  const frameIntervalMs = INTERACTIVE_FRAME_INTERVAL_MS;
  const frameFlushCount = INTERACTIVE_FRAME_FLUSH_COUNT;
  const frameFlushMs = INTERACTIVE_FRAME_FLUSH_MS;
  const framePollMs = INTERACTIVE_FRAME_POLL_MS;
  const dialogSelector = JSON.stringify(INTERACTIVE_DIALOG_SELECTOR);
  const dialogMaxRounds = INTERACTIVE_DIALOG_MAX_ROUNDS;
  const dialogSettleMs = INTERACTIVE_DIALOG_SETTLE_MS;
  const dialogBudgetMs = INTERACTIVE_DIALOG_BUDGET_MS;
  const dialogCoverage = INTERACTIVE_DIALOG_COVERAGE;
  const dialogMinFrameArea = INTERACTIVE_DIALOG_MIN_FRAME_AREA;
  const internalTimeoutMs = Math.max(1_000, INTERACTIVE_READY_TIMEOUT_MS - 1_000);
  return `
<meta data-openmaic-static-csp http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
<script data-openmaic-static-capture>
(function () {
  var FLAG = ${flag};
  var frozen = false;
  var timeouts = new Set();
  var intervals = new Set();
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  var nativeSetInterval = window.setInterval.bind(window);
  var nativeClearInterval = window.clearInterval.bind(window);

  function disabledWorker() { throw new Error('interactive-worker-disabled'); }
  try { window.Worker = disabledWorker; } catch (_) {}
  try { window.SharedWorker = disabledWorker; } catch (_) {}

  function post(kind, code, message) {
    try {
      var payload = {
        kind: kind,
        code: code,
        message: String(message || '').slice(0, 1200)
      };
      payload[FLAG] = true;
      window.parent.postMessage(payload, '*');
    } catch (_) {}
  }

  window.setTimeout = function (fn, delay) {
    if (frozen) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nativeSetTimeout(function () {
      timeouts.delete(id);
      if (!frozen) {
        if (typeof fn === 'function') fn.apply(window, args);
        else Function(String(fn))();
      }
    }, delay);
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); nativeClearTimeout(id); };
  window.setInterval = function (fn, delay) {
    if (frozen) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nativeSetInterval(function () {
      if (!frozen) {
        if (typeof fn === 'function') fn.apply(window, args);
        else Function(String(fn))();
      }
    }, delay);
    intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) { intervals.delete(id); nativeClearInterval(id); };

  // Frame clock. Export capture runs Chromium with --enable-begin-frame-control
  // and --deterministic-mode, so the compositor advances only when the capture
  // loop asks for a frame — and it does not ask while it waits for every scene
  // to report ready. A page that paints from requestAnimationFrame therefore
  // gets no callback at all during that wait, and its canvas stays blank for the
  // whole scene. Drive those callbacks from a timer instead: canvas drawing is
  // synchronous, so the pixels are final before the capture loop takes its
  // first screenshot.
  var frameQueue = [];
  var frameTimer = 0;
  var frameTicks = 0;
  var frameRequests = 0;
  var frameId = 0;
  var frameNow = window.performance && window.performance.now ? window.performance.now() : 0;

  function drainFrameQueue() {
    frameTimer = 0;
    if (frozen) return;
    var batch = frameQueue;
    frameQueue = [];
    frameNow += ${frameIntervalMs};
    for (var i = 0; i < batch.length; i += 1) {
      if (frozen) return;
      try { batch[i].callback(frameNow); } catch (_) {}
    }
    frameTicks += 1;
    if (frameQueue.length > 0) scheduleFrame();
  }

  function scheduleFrame() {
    if (frameTimer || frozen) return;
    frameTimer = nativeSetTimeout(drainFrameQueue, ${frameIntervalMs});
  }

  window.requestAnimationFrame = function (fn) {
    if (frozen || typeof fn !== 'function') return 0;
    frameRequests += 1;
    frameId += 1;
    frameQueue.push({ id: frameId, callback: fn });
    scheduleFrame();
    return frameId;
  };
  window.cancelAnimationFrame = function (id) {
    frameQueue = frameQueue.filter(function (entry) { return entry.id !== id; });
  };

  // Dialog clearing. Scenes commonly open on a rules card that covers the very
  // board they are about, and freezing there hands the viewer a dialog for the
  // whole scene. Only containers that name themselves as a dialog qualify, and
  // only while they actually hide most of the viewport: a page's real controls
  // are what the scene exists to show, so guessing at "any overlay-ish element"
  // would change the lesson instead of revealing it.
  var DIALOG_SELECTOR = ${dialogSelector};
  var DIALOG_MAX_ROUNDS = ${dialogMaxRounds};
  var DIALOG_SETTLE_MS = ${dialogSettleMs};
  var DIALOG_BUDGET_MS = ${dialogBudgetMs};

  function rendered(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function coveringDialog() {
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var nodes = document.querySelectorAll(DIALOG_SELECTOR);
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!rendered(el)) continue;
      var rect = el.getBoundingClientRect();
      var area = rect.width * rect.height;
      // The floor keeps a small nested layer from qualifying on ratio alone.
      if (area < vw * vh * ${dialogMinFrameArea}) continue;
      // A card covers the column it is drawn over, not the whole frame: in this
      // deck the column is a third of a wide frame, so comparing to the frame
      // alone would skip every real dialog.
      var parent = el.offsetParent;
      var base = parent && parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
      if (base && base.width > 1 && base.height > 1) {
        if (area < base.width * base.height * ${dialogCoverage}) continue;
      }
      return el;
    }
    return null;
  }

  // The way out of a dialog is its primary control: the styled one if the page
  // marks it, otherwise the first button. Links are skipped — leaving the page
  // is blocked by the capture CSP and would not reveal anything.
  var CONTROL_SELECTORS = ['.primary', '[data-primary]', 'button', '[role="button"]', 'input[type="submit"]'];

  function primaryControl(root) {
    for (var s = 0; s < CONTROL_SELECTORS.length; s += 1) {
      var nodes = root.querySelectorAll(CONTROL_SELECTORS[s]);
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!rendered(node)) continue;
        if (node.tagName === 'A' && node.getAttribute('href')) continue;
        return node;
      }
    }
    return null;
  }

  function describe(el) {
    return String(el.id || el.className || el.tagName || 'dialog').slice(0, 40);
  }

  function waitForGone(el, limitMs) {
    return new Promise(function (resolve) {
      var elapsed = 0;
      var step = function () {
        if (frozen) return resolve();
        if (!el.isConnected) return resolve();
        if (!rendered(el)) return resolve();
        if (elapsed >= limitMs) return resolve();
        elapsed += ${framePollMs};
        nativeSetTimeout(step, ${framePollMs});
      };
      nativeSetTimeout(step, ${framePollMs});
    });
  }

  function clearDialogs() {
    var cleared = [];
    var rounds = 0;
    var startedAt = Date.now();
    function remaining() { return DIALOG_BUDGET_MS - (Date.now() - startedAt); }
    function next() {
      if (frozen || rounds >= DIALOG_MAX_ROUNDS) return Promise.resolve(cleared);
      if (remaining() <= 0) return Promise.resolve(cleared);
      var dialog = coveringDialog();
      if (!dialog) return Promise.resolve(cleared);
      rounds += 1;
      var control = primaryControl(dialog);
      if (!control) {
        // No way out that the page itself offers. Leave it as authored and
        // record why, rather than hiding an element the author wanted shown.
        cleared.push('blocked:' + describe(dialog));
        return Promise.resolve(cleared);
      }
      cleared.push(describe(dialog));
      try { control.click(); } catch (_) {}
      return waitForGone(dialog, Math.min(DIALOG_SETTLE_MS, remaining())).then(next);
    }
    return Promise.resolve().then(next);
  }

  function waitForImages() {
    return Promise.all(Array.from(document.images || []).map(function (img) {
      if (img.complete) {
        if ((img.currentSrc || img.src || img.getAttribute('srcset')) && img.naturalWidth === 0)
          return Promise.reject(new Error('interactive-image-load-failure'));
        return typeof img.decode === 'function' ? img.decode() : Promise.resolve();
      }
      return new Promise(function (resolve, reject) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener(
          'error',
          function () { reject(new Error('interactive-image-load-failure')); },
          { once: true },
        );
      });
    }));
  }

  function waitForVideos() {
    return Promise.all(Array.from(document.querySelectorAll('video')).map(function (video) {
      if (!video.currentSrc && !video.getAttribute('src') && !video.querySelector('source')) return Promise.resolve();
      if (video.readyState >= 2) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener(
          'error',
          function () { reject(new Error('interactive-video-load-failure')); },
          { once: true },
        );
      });
    }));
  }

  function freeze() {
    if (frozen) return;
    frozen = true;
    timeouts.forEach(nativeClearTimeout); timeouts.clear();
    intervals.forEach(nativeClearInterval); intervals.clear();
    if (frameTimer) nativeClearTimeout(frameTimer);
    frameTimer = 0;
    frameQueue = [];
    try { document.getAnimations().forEach(function (animation) { animation.pause(); }); } catch (_) {}
    Array.from(document.querySelectorAll('video,audio')).forEach(function (media) {
      try { media.pause(); } catch (_) {}
    });
    var style = document.createElement('style');
    style.setAttribute('data-openmaic-static-frozen', '');
    style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.setAttribute('data-openmaic-static-state', 'frozen');
  }

  window.__openmaicFreezeInteractive = freeze;
  window.addEventListener('load', function () {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    var readiness = Promise.all([fonts, waitForImages(), waitForVideos()]);
    var deadlineTimer;
    var deadline = new Promise(function (_, reject) {
      deadlineTimer = nativeSetTimeout(function () { reject(new Error('interactive-readiness-timeout')); }, ${internalTimeoutMs});
    });
    Promise.race([readiness, deadline])
      .then(function () {
        nativeClearTimeout(deadlineTimer);
        return new Promise(function (resolve) { nativeSetTimeout(resolve, ${settleMs}); });
      })
      // Clearing is best effort: a page whose overlay markup defeats the
      // heuristic still has to render, so a failure here must not turn a good
      // scene into the fallback placeholder.
      .then(function () { return clearDialogs().catch(function () { return []; }); })
      .then(function (cleared) {
        if (cleared && cleared.length > 0) {
          document.documentElement.setAttribute(
            'data-openmaic-static-dialogs',
            cleared.join(','),
          );
        }
        // Paint boundary. A page that paints from requestAnimationFrame is
        // mid-animation when its resources finish loading, and the freeze that
        // follows would lock in a blank canvas for the whole scene. Let the
        // frame clock above run a few frames first: it is timer-driven, so it
        // advances even though the capture loop owns the compositor. The count
        // is measured from here, not from page load, so frames spent before a
        // dialog was cleared do not count toward the paint budget. A page that
        // requests no frames paints synchronously and is let go after a short
        // grace instead of waiting out the deadline.
        return new Promise(function (resolve) {
          var elapsed = 0;
          var graceMs = ${framePollMs} * 10;
          var baseTicks = frameTicks;
          var baseRequests = frameRequests;
          var poll = function () {
            if (frameTicks - baseTicks >= ${frameFlushCount}) return resolve();
            if (frameRequests === baseRequests && frameQueue.length === 0 && elapsed >= graceMs)
              return resolve();
            elapsed += ${framePollMs};
            if (elapsed >= ${frameFlushMs}) return resolve();
            nativeSetTimeout(poll, ${framePollMs});
          };
          nativeSetTimeout(poll, ${framePollMs});
        });
      })
      .then(function () { freeze(); post('frozen', 'interactive-static-ready', 'ready'); })
      .catch(function (error) {
        nativeClearTimeout(deadlineTimer);
        freeze();
        post('failure', 'interactive-ready-failure', error && error.message || error);
      });
  }, { once: true });
})();
</script>`;
}

/** KaTeX emits `about:invalid` font fallbacks after its embedded data fonts. */
function stripInvalidFontFallbacks(html: string): string {
  return html.replace(
    /url\(\s*about:invalid\s*\)(?:\s*format\(\s*["'][^"']+["']\s*\))?\s*,?/gi,
    '',
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class PreparedInteractiveHtmlSetImpl implements PreparedInteractiveHtmlSet {
  constructor(
    private readonly bySceneId: ReadonlyMap<string, InteractiveHtmlMeta>,
    private readonly byAssetId: ReadonlyMap<string, string>,
  ) {}

  html(scene: { id: string }): InteractiveHtmlMeta | null {
    return this.bySceneId.get(scene.id) ?? null;
  }

  content(assetId: string): string | undefined {
    return this.byAssetId.get(assetId);
  }
}

export function emptyPreparedInteractiveHtmlSet(): PreparedInteractiveHtmlSet {
  return new PreparedInteractiveHtmlSetImpl(new Map(), new Map());
}

export async function prepareInteractiveHtmlScenes(
  scenes: readonly Scene[],
  options: PrepareInteractiveHtmlOptions = {},
): Promise<PreparedInteractiveHtmlSet> {
  const bySceneId = new Map<string, InteractiveHtmlMeta>();
  const byAssetId = new Map<string, string>();
  const maxBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;

  for (const scene of scenes) {
    if (scene.content.type !== 'interactive') continue;
    const assetId = `interactive:${scene.id}`;
    const authored = scene.content.html;
    if (!authored?.trim()) {
      bySceneId.set(scene.id, {
        id: assetId,
        present: false,
        failure: 'missing-html',
      });
      continue;
    }

    try {
      const {
        html: inlined,
        report,
        unresolved,
      } = await inlineHtmlAssets(authored, {
        fetcher: options.fetcher,
        baseUrl: options.baseUrl,
        keepImportmapFallbacks: false,
      });
      const sanitized = stripInvalidFontFallbacks(inlined);
      const residual = [
        ...new Set([
          ...report.failed
            .map((failure) => failure.url)
            .filter((url) => !/^about:invalid$/i.test(url)),
          ...unresolved,
        ]),
      ];
      if (residual.length > 0) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'unresolved-resource',
          message: `unresolved-interactive-resource:${residual.slice(0, 3).join(', ')}${residual.length > 3 ? ` (+${residual.length - 3} more)` : ''}`,
        });
        continue;
      }

      const packaged = injectIntoDocumentHead(
        patchHtmlForIframe(sanitized, undefined, { processed: true }),
        staticCaptureInjection(),
      );
      const size = new TextEncoder().encode(packaged).byteLength;
      if (size > maxBytes) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'too-large',
          message: `interactive-html-too-large:${size}/${maxBytes}`,
        });
        continue;
      }

      const contentHash = await sha256(packaged);
      bySceneId.set(scene.id, { id: assetId, present: true, contentHash });
      byAssetId.set(assetId, packaged);
    } catch (error) {
      bySceneId.set(scene.id, {
        id: assetId,
        present: false,
        failure: 'packaging-failed',
        message: `interactive-html-packaging-failed:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return new PreparedInteractiveHtmlSetImpl(bySceneId, byAssetId);
}

declare global {
  interface Window {
    __openmaicFreezeInteractive?: () => void;
  }
}
