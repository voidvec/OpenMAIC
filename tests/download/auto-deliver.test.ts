import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings store persists through the KV backend, which refuses writes in a
 * unit-test process (nothing hydrated it) and logs an error per write. This
 * suite only cares about the flag's value, so it stands in a plain object and
 * keeps the run quiet.
 */
const settings = vi.hoisted(() => ({ current: { deliverToCloud: true } }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => settings.current },
}));

import { queueArtifactDelivery } from '@/lib/download/auto-deliver';

/**
 * The delivery queue is fire-and-forget, so every case here asserts on the
 * request it did or did not issue rather than on a return value.
 */
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null));

function headersOf(call: number): Record<string, string> {
  return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('queueArtifactDelivery', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    settings.current = { deliverToCloud: true };
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('queues a deliverable with its course and round', () => {
    queueArtifactDelivery('课程-微课材料包.zip', new Blob(['x']), '课程');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/deliver/upload');
    expect(headersOf(0)).toMatchObject({
      'x-deliver-filename': encodeURIComponent('课程-微课材料包.zip'),
      // The pack carries a suffix the cloud folder must not inherit.
      'x-deliver-title': encodeURIComponent('课程'),
      'x-deliver-revision': '1',
    });
  });

  it('falls back to the file name when no course is given', () => {
    queueArtifactDelivery('lesson.pptx', new Blob(['x']));
    expect(headersOf(0)['x-deliver-title']).toBe(encodeURIComponent('lesson'));
  });

  it('ignores formats that are not deliverables', () => {
    for (const name of ['narration.srt', 'script.md', 'deck.png']) {
      queueArtifactDelivery(name, new Blob(['x']));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing once the operator turns cloud upload off', () => {
    settings.current = { deliverToCloud: false };

    queueArtifactDelivery('lesson.pptx', new Blob(['x']), 'lesson');
    queueArtifactDelivery('lesson.zip', new Blob(['x']), 'lesson');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the switch per call, so flipping it back applies without a reload', () => {
    settings.current = { deliverToCloud: false };
    queueArtifactDelivery('a.pptx', new Blob(['x']));
    expect(fetchMock).not.toHaveBeenCalled();

    settings.current = { deliverToCloud: true };
    queueArtifactDelivery('b.pptx', new Blob(['x']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
