import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveAs: vi.fn(),
  warn: vi.fn(),
  queueArtifact: vi.fn(),
}));

vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('@/lib/download/auto-deliver', () => ({ queueArtifactDelivery: mocks.queueArtifact }));

import {
  SAVE_DIR_IDS,
  canChooseSaveDirectory,
  resolveSaveTarget,
  writeSaveTarget,
} from '@/lib/download/save-target';

/**
 * Stand-in for a File System Access directory handle. The module only depends on
 * the structural subset it declares locally, so a plain object is enough.
 */
function makeDirectory(name = 'chosen-folder') {
  const writable = {
    write: vi.fn(async (_blob: Blob) => undefined),
    close: vi.fn(async () => undefined),
  };
  const fileHandle = { createWritable: vi.fn(async () => writable) };
  const handle = {
    name,
    getFileHandle: vi.fn(async (_name: string, _options?: { create?: boolean }) => fileHandle),
  };
  return { handle, fileHandle, writable };
}

/** Install a `window` carrying the given folder picker (or none). */
function stubPicker(picker: unknown): void {
  vi.stubGlobal('window', picker ? { showDirectoryPicker: picker } : {});
}

describe('SAVE_DIR_IDS', () => {
  it('gives every export kind its own picker id', () => {
    // Chromium keys its remembered "last directory" per id, so a duplicate
    // would let one export drag the next one to an unrelated folder.
    const ids = Object.values(SAVE_DIR_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('canChooseSaveDirectory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when the browser exposes no folder picker', () => {
    stubPicker(null);
    expect(canChooseSaveDirectory()).toBe(false);
  });

  it('is true when showDirectoryPicker is available', () => {
    stubPicker(vi.fn());
    expect(canChooseSaveDirectory()).toBe(true);
  });
});

describe('resolveSaveTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the browser download folder without a picker', async () => {
    stubPicker(null);

    await expect(resolveSaveTarget(SAVE_DIR_IDS.slides)).resolves.toEqual({ kind: 'browser' });
  });

  it('asks the picker for readwrite access under the export kind id', async () => {
    const { handle } = makeDirectory();
    const picker = vi.fn(async () => handle);
    stubPicker(picker);

    await expect(resolveSaveTarget(SAVE_DIR_IDS.slides)).resolves.toEqual({
      kind: 'directory',
      handle,
    });
    expect(picker).toHaveBeenCalledWith({ id: SAVE_DIR_IDS.slides, mode: 'readwrite' });
  });

  it('reports a dismissed picker as null rather than an error', async () => {
    stubPicker(
      vi.fn(async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }),
    );

    await expect(resolveSaveTarget(SAVE_DIR_IDS.script)).resolves.toBeNull();
    // An explicit "no" is a decision, not a failure worth logging.
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('falls back to the browser folder when the picker itself fails', async () => {
    stubPicker(
      vi.fn(async () => {
        throw new Error('blocked in a cross-origin frame');
      }),
    );

    await expect(resolveSaveTarget(SAVE_DIR_IDS.videoMp4)).resolves.toEqual({ kind: 'browser' });
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});

describe('writeSaveTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads through the browser when no folder was chosen', async () => {
    const blob = new Blob(['deck']);

    await writeSaveTarget({ kind: 'browser' }, 'deck.pptx', blob);

    expect(mocks.saveAs).toHaveBeenCalledWith(blob, 'deck.pptx');
  });

  it('creates and writes the file inside the chosen folder', async () => {
    const { handle, writable } = makeDirectory();
    const blob = new Blob(['deck']);

    await writeSaveTarget({ kind: 'directory', handle }, 'deck.pptx', blob);

    expect(handle.getFileHandle).toHaveBeenCalledWith('deck.pptx', { create: true });
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('falls back to a download when the chosen folder is no longer writable', async () => {
    const { handle } = makeDirectory();
    handle.getFileHandle.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const blob = new Blob(['deck']);

    await writeSaveTarget({ kind: 'directory', handle }, 'deck.pptx', blob);

    expect(mocks.saveAs).toHaveBeenCalledWith(blob, 'deck.pptx');
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  // The delivery title is what names the cloud folder, and it cannot be derived
  // from the file name: exports mark their variants in the name (`…-带旁白.html`)
  // while the folder has to stay the course, or one course ends up split across
  // sibling folders and the buyer's link shows only part of it.
  it('forwards the delivery title alongside the file name', async () => {
    const blob = new Blob(['html']);

    await writeSaveTarget({ kind: 'browser' }, 'Lesson-带旁白.html', blob, {
      deliveryTitle: 'Lesson',
    });

    expect(mocks.queueArtifact).toHaveBeenCalledWith('Lesson-带旁白.html', blob, 'Lesson');
  });
});
