import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  collectVideoAssets: vi.fn(),
  compileVideoTimeline: vi.fn(),
  createVideoTimelineDeps: vi.fn(),
  createQuizLayoutProbe: vi.fn(),
  emitHyperframes: vi.fn(),
  packageVideoZip: vi.fn(),
  resolveAigcIdentifiers: vi.fn(),
  stageState: vi.fn(),
  toSrt: vi.fn(),
  toVtt: vi.fn(),
}));

vi.mock('@/lib/video-export', () => ({
  compileVideoTimeline: mocks.compileVideoTimeline,
  emitHyperframes: mocks.emitHyperframes,
  resolveAigcIdentifiers: mocks.resolveAigcIdentifiers,
  toSrt: mocks.toSrt,
  toVtt: mocks.toVtt,
}));
vi.mock('@/lib/store', () => ({
  useStageStore: { getState: mocks.stageState },
}));
vi.mock('@/lib/document-store', () => ({
  accessDocument: mocks.accessDocument,
}));
vi.mock('@/lib/video-export-app/timeline-deps', () => ({
  createVideoTimelineDeps: mocks.createVideoTimelineDeps,
}));
vi.mock('@/lib/video-export-app/quiz-layout', () => ({
  createQuizLayoutProbe: mocks.createQuizLayoutProbe,
}));
vi.mock('@/lib/video-export-app/collect', () => ({
  collectVideoAssets: mocks.collectVideoAssets,
}));
vi.mock('@/lib/video-export-app/package-zip', () => ({
  packageVideoZip: mocks.packageVideoZip,
}));

import { buildExportZip, compileSubtitles } from '@/lib/video-export-app/build-export-zip';
import { getVideoExportCoverLabels } from '@/lib/video-export-app/cover-config';

const ENV_KEY = 'NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION';
const originalEnv = process.env[ENV_KEY];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stageState.mockReturnValue({
    stage: { id: 'stage-1', name: 'Stage' },
    scenes: [{ id: 'scene-1' }],
  });
  mocks.createVideoTimelineDeps.mockResolvedValue({
    timing: {},
    assets: {},
    records: {},
  });
  mocks.createQuizLayoutProbe.mockResolvedValue({ measureQuestionList: vi.fn() });
  mocks.compileVideoTimeline.mockReturnValue({ diagnostics: [] });
  mocks.emitHyperframes.mockReturnValue({ files: [] });
  mocks.resolveAigcIdentifiers.mockReturnValue({ provider: 'OpenMAIC', contentId: 'stage-1' });
  mocks.collectVideoAssets.mockResolvedValue({ blobs: new Map(), missing: [] });
  mocks.packageVideoZip.mockResolvedValue(new Blob(['zip']));
});

describe('compileSubtitles Quiz timing', () => {
  it('uses the selected resolution/locale Quiz probe while skipping slide geometry only', async () => {
    mocks.accessDocument.mockResolvedValue(undefined);
    const quizLayout = { measureQuestionList: vi.fn() };
    mocks.createQuizLayoutProbe.mockResolvedValue(quizLayout);
    mocks.compileVideoTimeline.mockReturnValue({ diagnostics: [], subtitles: [] });

    await compileSubtitles({ resolution: '1080p', locale: 'en-US' });

    expect(mocks.createVideoTimelineDeps).toHaveBeenCalledWith(
      expect.objectContaining({ skipGeometry: true }),
    );
    expect(mocks.createQuizLayoutProbe).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080, locale: 'en-US' }),
    );
    expect(mocks.compileVideoTimeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quizLayout }),
    );
  });
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe('buildExportZip CTA boundary', () => {
  it('does not expose a runtime diagnostics sidecar that cannot be updated after packaging', async () => {
    mocks.accessDocument.mockResolvedValue(undefined);

    const result = await buildExportZip({ resolution: '720p', locale: 'en-US' });

    expect(result).not.toHaveProperty('runtimeDiagnosticsPath');
  });
});

describe('buildExportZip app boundary', () => {
  it.each([
    ['persisted name', { document: { stage: { name: 'Renamed course' } } }, 'Renamed course'],
    ['missing document', undefined, 'Stage'],
    ['empty persisted name', { document: { stage: { name: '' } } }, 'Stage'],
  ])(
    'uses the same resolved name for the compiler and download: %s',
    async (_case, document, name) => {
      mocks.accessDocument.mockResolvedValue(document);
      const result = await buildExportZip({ resolution: '720p', locale: 'en-US' });
      expect(result.stageName).toBe(name);
      expect(mocks.compileVideoTimeline).toHaveBeenCalledWith(
        expect.objectContaining({ stage: { id: 'stage-1', name } }),
        expect.anything(),
      );
    },
  );

  it('preserves the in-memory name fallback when document storage is unavailable', async () => {
    mocks.accessDocument.mockRejectedValue(new Error('offline'));
    const result = await buildExportZip({ resolution: '720p', locale: 'en-US' });
    expect(result.stageName).toBe('Stage');
  });

  it('premeasures Quiz layout with the selected resolution/locale and injects the sync probe', async () => {
    mocks.accessDocument.mockResolvedValue(undefined);
    const quizLayout = { measureQuestionList: vi.fn() };
    mocks.createQuizLayoutProbe.mockResolvedValue(quizLayout);

    await buildExportZip({ resolution: '4k', locale: 'zh-CN' });

    expect(mocks.createQuizLayoutProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        scenes: [{ id: 'scene-1' }],
        width: 3840,
        height: 2160,
        locale: 'zh-CN',
        labels: getVideoExportCoverLabels('zh-CN'),
      }),
    );
    expect(mocks.compileVideoTimeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quizLayout }),
    );
  });

  it('freezes the configured CTA and complete locale labels before its first await', async () => {
    let releaseDocument!: (value: unknown) => void;
    mocks.accessDocument.mockReturnValue(
      new Promise((resolve) => {
        releaseDocument = resolve;
      }),
    );
    process.env[ENV_KEY] = 'https://Courses.Example.com/start/';

    const building = buildExportZip({ resolution: '720p', locale: 'en-US' });
    process.env[ENV_KEY] = 'off';
    releaseDocument({ document: { stage: { name: 'Resolved stage' } } });
    await building;

    expect(mocks.emitHyperframes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cta: { destination: 'courses.example.com/start' },
        labels: expect.objectContaining({
          quizCtaPrompt: 'Want to try an interactive quiz?',
          pblCtaPrompt: 'Want to explore project-based learning?',
          ctaVisit: 'Visit',
        }),
        locale: 'en-US',
      }),
    );
  });

  it('does not warn for an explicitly disabled CTA', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.accessDocument.mockResolvedValue(undefined);
    process.env[ENV_KEY] = ' OFF ';

    await buildExportZip({ resolution: '720p', locale: 'zh-CN' });

    expect(warn).not.toHaveBeenCalled();
    expect(mocks.emitHyperframes.mock.calls[0][1]).toMatchObject({ cta: null });
    warn.mockRestore();
  });

  it('warns once per process for invalid environment values and disables the CTA', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.accessDocument.mockResolvedValue(undefined);
    process.env[ENV_KEY] = 'ftp://unsafe.example';

    await buildExportZip({ resolution: '720p', locale: 'en-US' });
    await buildExportZip({ resolution: '1080p', locale: 'en-US' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('NEXT_PUBLIC_VIDEO_EXPORT_CTA_DESTINATION'),
    );
    expect(mocks.emitHyperframes.mock.calls[0][1]).toMatchObject({ cta: null });
    expect(mocks.emitHyperframes.mock.calls[1][1]).toMatchObject({ cta: null });
    warn.mockRestore();
  });
});

describe('buildExportZip AIGC boundary', () => {
  const PROVIDER_KEY = 'NEXT_PUBLIC_AIGC_PROVIDER';
  const ID_KEY = 'NEXT_PUBLIC_AIGC_CONTENT_ID';

  it('names the deployment as the provider when no legal entity is configured', async () => {
    const originalProvider = process.env[PROVIDER_KEY];
    mocks.accessDocument.mockResolvedValue(undefined);
    delete process.env[PROVIDER_KEY];

    try {
      await buildExportZip({ resolution: '720p', locale: 'en-US', brandName: '智造学堂' });

      // §6.1 wants the service provider, and a white-labelled deployment is
      // the one offering the file — its brand is the honest answer there.
      expect(mocks.resolveAigcIdentifiers).toHaveBeenCalledWith('智造学堂', undefined, 'stage-1');
    } finally {
      if (originalProvider !== undefined) process.env[PROVIDER_KEY] = originalProvider;
    }
  });

  it('keeps an explicitly configured provider ahead of the brand', async () => {
    const originalProvider = process.env[PROVIDER_KEY];
    mocks.accessDocument.mockResolvedValue(undefined);
    // A legal entity named by the operator outranks a cosmetic setting.
    process.env[PROVIDER_KEY] = '智造学堂科技有限公司';

    try {
      await buildExportZip({ resolution: '720p', locale: 'en-US', brandName: '智造学堂' });

      expect(mocks.resolveAigcIdentifiers).toHaveBeenCalledWith(
        '智造学堂科技有限公司',
        undefined,
        'stage-1',
      );
    } finally {
      if (originalProvider === undefined) delete process.env[PROVIDER_KEY];
      else process.env[PROVIDER_KEY] = originalProvider;
    }
  });

  it('resolves the label from the deployment name and the classroom id', async () => {
    const originalProvider = process.env[PROVIDER_KEY];
    const originalId = process.env[ID_KEY];
    mocks.accessDocument.mockResolvedValue(undefined);
    delete process.env[PROVIDER_KEY];
    delete process.env[ID_KEY];

    try {
      await buildExportZip({ resolution: '720p', locale: 'en-US' });

      // The classroom id doubles as the §6.1 per-content number: one course,
      // one number, across every re-export.
      expect(mocks.resolveAigcIdentifiers).toHaveBeenCalledWith(undefined, undefined, 'stage-1');
      expect(mocks.emitHyperframes).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          aigc: { provider: 'OpenMAIC', contentId: 'stage-1' },
        }),
      );
    } finally {
      if (originalProvider !== undefined) process.env[PROVIDER_KEY] = originalProvider;
      if (originalId !== undefined) process.env[ID_KEY] = originalId;
    }
  });
});
