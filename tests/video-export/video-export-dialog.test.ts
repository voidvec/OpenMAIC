// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  render: vi.fn(),
  zip: vi.fn(),
  subtitles: vi.fn(),
  setOptions: vi.fn(),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/video-export-app/use-render-video', () => ({
  useRenderVideo: () => ({
    rendering: false,
    percent: 0,
    etaMs: null,
    options: { resolution: '1080p', fps: 30, quality: 'standard', burnInSubtitles: false },
    setOptions: mocks.setOptions,
    renderVideo: mocks.render,
  }),
}));
vi.mock('@/lib/video-export-app/use-export-video', () => ({
  useExportVideo: () => ({ exporting: false, exportVideo: mocks.zip }),
}));
vi.mock('@/lib/video-export-app/use-download-subtitles', () => ({
  useDownloadSubtitles: () => ({ downloading: false, downloadSubtitles: mocks.subtitles }),
}));
import { VideoExportDialog } from '@/components/stage/video-export-dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const onOpenChange = vi.fn();
async function show(open: boolean) {
  await act(async () => root.render(createElement(VideoExportDialog, { open, onOpenChange })));
}
function button(key: string) {
  const found = [...document.querySelectorAll('button')].find((node) => node.textContent === key);
  expect(found, key).toBeDefined();
  return found!;
}
async function click(key: string) {
  await act(async () => button(key).click());
}
/** 交付预设按钮的 textContent 是「标签 + 拼接的参数」，不会和 key 完全相等。 */
async function clickContaining(key: string) {
  const found = [...document.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(key),
  );
  expect(found, key).toBeDefined();
  await act(async () => found!.click());
}
function fpsInput(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    'input[aria-label="export.videoFpsCustom"]',
  );
  expect(found, 'custom fps input').not.toBeNull();
  return found!;
}
/** 受控 input 必须走原生 setter，直接改 value React 收不到。 */
async function typeFps(text: string) {
  const input = fpsInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
function response(accepting?: boolean, enabled = true) {
  return { ok: true, json: async () => ({ enabled, accepting }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('video export queue preflight', () => {
  it('blocks MP4 while busy, leaves other exports usable, and recovers on manual recheck', async () => {
    mocks.fetch.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    await show(true);
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('export.videoQueueBusy');
    await click('export.videoDownloadZip');
    await click('export.videoDownloadSubtitles');
    expect(mocks.zip).toHaveBeenCalledWith('1080p', false);
    expect(mocks.subtitles).toHaveBeenCalledWith('srt');
    await click('export.videoRenderMp4');
    expect(mocks.render).not.toHaveBeenCalled();
    await click('export.videoRecheckQueue');
    expect(button('export.videoRenderMp4').disabled).toBe(false);
    expect(document.querySelector('[role="status"]')).toBeNull();
    await click('export.videoRenderMp4');
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate checks and MP4 while a recheck is pending', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockResolvedValueOnce(response(false)).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await show(true);
    await click('export.videoRecheckQueue');
    expect(button('export.videoCheckingQueue').disabled).toBe(true);
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    await click('export.videoCheckingQueue');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => resolve(response(true)));
    expect(button('export.videoRenderMp4').disabled).toBe(false);
  });

  it('ignores a late response from an earlier opening', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce(response(false));
    await show(true);
    await show(false);
    await show(true);
    await act(async () => resolve(response(true)));
    expect(button('export.videoRenderMp4').disabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('allows older services without admission state', async () => {
    mocks.fetch.mockResolvedValue(response());
    await show(true);
    expect(button('export.videoRenderMp4').disabled).toBe(false);
  });

  it('preserves the ZIP-only UI when the service is disabled', async () => {
    mocks.fetch.mockResolvedValue(response(undefined, false));
    await show(true);
    expect(document.body.textContent).not.toContain('export.videoRenderMp4');
    expect(document.body.textContent).toContain('export.videoServiceHint');
    expect(button('export.videoDownloadZip').disabled).toBe(false);
  });
});

describe('video export options', () => {
  it('applies the handover preset in one click', async () => {
    mocks.fetch.mockResolvedValue(response());
    await show(true);
    await clickContaining('export.videoDeliveryPreset');
    // 一次点齐四个值：漏掉 burnInSubtitles 就是 2026-10-28 那次交付事故。
    expect(mocks.setOptions).toHaveBeenCalledWith({
      resolution: '1080p',
      fps: 30,
      quality: 'standard',
      burnInSubtitles: true,
    });
  });

  it('accepts a frame rate that is in no preset', async () => {
    mocks.fetch.mockResolvedValue(response());
    await show(true);
    // 25fps 是多个赛区文件里真实出现的值，却不在 24/30/60 这三个预设里。
    await typeFps('25');
    expect(mocks.setOptions).toHaveBeenCalledWith({ fps: 25 });
  });

  it('reverts an out-of-range frame rate instead of submitting it', async () => {
    mocks.fetch.mockResolvedValue(response());
    await show(true);
    await typeFps('500');
    expect(mocks.setOptions).not.toHaveBeenCalled();
    expect(fpsInput().value).toBe('30');
  });
});
