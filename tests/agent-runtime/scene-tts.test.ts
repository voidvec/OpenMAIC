import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
  enabled: vi.fn(),
  apiKey: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSModel: vi.fn(() => ''),
  slotTTSModel: vi.fn(() => ''),
  enabledServerTTSProviderIds: (...args: unknown[]) => mocks.enabled(...args),
  resolveTTSApiKey: (...args: unknown[]) => mocks.apiKey(...args),
  resolveTTSBaseUrl: vi.fn(() => undefined),
}));
vi.mock('@/lib/server/model-config/media', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: (...args: unknown[]) => mocks.providers(...args),
}));

// Spread the real module so the timeout and rate-limit classes the runtime
// checks with `instanceof` stay real; only the network call is replaced.
vi.mock('@/lib/audio/tts-providers', async (original) => {
  const actual = await original<typeof import('@/lib/audio/tts-providers')>();
  return {
    ...actual,
    generateTTS: (...args: unknown[]) => mocks.generate(...args),
    TTSRequestTimeoutError: class TTSRequestTimeoutError extends Error {
      constructor(
        public readonly provider: string,
        message: string,
      ) {
        super(message);
        this.name = 'TTSRequestTimeoutError';
      }
    },
  };
});

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import {
  describeNarrationVoice,
  synthesizeSceneNarration,
} from '@/lib/server/agent-runtime/scene-tts';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

/** The slot's assignment: an OpenAI TTS provider with a server-held key. */
function slotConnection(providerId = 'openai-tts') {
  return {
    providerId,
    managed: true,
    userEndpoint: false,
    origin: 'configuration',
    apiKey: 'slot-key',
  };
}

describe('scene TTS capability routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only the assigned provider is enabled unless a test says otherwise.
    mocks.enabled.mockReturnValue([]);
    mocks.apiKey.mockReturnValue('');
  });

  it('synthesizes nothing when the tts slot is turned off', async () => {
    mocks.providers.mockResolvedValue('off');
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      ownerId: 'user:alice',
    });
    expect(mocks.providers).toHaveBeenCalledWith('tts', 'user:alice');
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in classroom media', async () => {
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3');
    const target = structuredClone(scene);
    const summary = await synthesizeSceneNarration({ scene: target, force: false });
    expect(summary).toMatchObject({ available: true, changed: true, generated: 1 });
    // The durable reference is the RELATIVE classroom-media path (origin-
    // independent), stamped on both `audioId` and the legacy `audioUrl` pair
    // the browser's narration consumers resolve (timeline status/preview,
    // playback fetch, exports) — so agent-generated narration is voiced and
    // playable on any deployment origin.
    expect(target.actions?.[0]).toMatchObject({
      audioId: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
      audioUrl: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-a', mime: 'audio/mpeg' }),
    );
  });

  describe('voice reporting', () => {
    const slot = {
      providerId: 'configured-tts',
      managed: true,
      userEndpoint: false,
      origin: 'configuration',
      options: { defaultVoice: 'slot-default' },
    };
    const agent = (
      role: GeneratedAgentConfig['role'],
      name: string,
      voiceConfig?: { providerId: string; voiceId: string },
    ) =>
      ({
        id: name,
        name,
        role,
        persona: '',
        ...(voiceConfig ? { voiceConfig } : {}),
      }) as GeneratedAgentConfig;

    beforeEach(() => {
      mocks.providers.mockResolvedValue(slot);
      mocks.generate.mockResolvedValue({ audio: new Uint8Array([1]), format: 'mp3' });
      mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
    });

    it("reports the teacher's roster binding when it belongs to the slot provider", async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
        roster: [
          agent('teacher', 'Ms. Lin', { providerId: 'configured-tts', voiceId: 'warm' }),
          agent('student', 'Sam', { providerId: 'configured-tts', voiceId: 'bright' }),
        ],
      });
      expect(mocks.generate.mock.calls[0]![0]).toMatchObject({ voice: 'warm' });
      expect(summary.voice).toEqual({
        binding: 'configured-tts::warm',
        source: 'roster-teacher',
        teacher: 'Ms. Lin',
      });
      expect(describeNarrationVoice(summary.voice!)).toBe(
        'Voice: configured-tts::warm (teacher "Ms. Lin"\'s roster binding).',
      );
    });

    it('says when a teacher bound to another provider falls back to the default voice', async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
        roster: [
          agent('teacher', 'Ms. Lin', { providerId: 'other-tts', voiceId: 'warm' }),
          agent('student', 'Sam'),
        ],
      });
      const voice = mocks.generate.mock.calls[0]![0].voice as string;
      expect(summary.voice).toEqual({
        binding: `configured-tts::${voice}`,
        source: 'provider-default',
        teacher: 'Ms. Lin',
        fallbackReason: 'teacher-bound-to-other-provider',
      });
      expect(describeNarrationVoice(summary.voice!)).toContain(
        'provider default; teacher "Ms. Lin" is bound to a voice of another provider',
      );
    });

    it('says when there is no teacher to take a voice from', async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
      });
      expect(summary.voice).toMatchObject({
        source: 'provider-default',
        fallbackReason: 'no-teacher',
      });
      expect(describeNarrationVoice(summary.voice!)).toContain('the roster has no teacher');
    });
  });

  it('never speaks through a provider the slot did not assign', async () => {
    // A second enabled provider must not be consulted when the first answers.
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3');

    await synthesizeSceneNarration({ scene: structuredClone(scene), force: false });

    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai-tts', apiKey: 'slot-key' }),
      'Hello',
    );
  });

  it('fails over to another enabled provider when the assignment errors', async () => {
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');
    // First call (the assignment) errors, second (the fallback) succeeds.
    mocks.generate
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.wav');

    const summary = await synthesizeSceneNarration({ scene: structuredClone(scene), force: false });

    expect(summary).toMatchObject({ available: true, generated: 1, failed: [] });
    expect(mocks.generate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerId: 'openai-tts' }),
      'Hello',
    );
    expect(mocks.generate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerId: 'minimax-tts' }),
      'Hello',
    );
  });

  it('fails over on a timeout from the assignment instead of wedging', async () => {
    const { TTSRequestTimeoutError } = await import('@/lib/audio/tts-providers');
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');
    // A hung upstream must degrade to the next candidate rather than abort the
    // whole scene.
    mocks.generate
      .mockRejectedValueOnce(
        new TTSRequestTimeoutError('openai-tts', 'TTS request timed out after 30000ms'),
      )
      .mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.wav');

    const summary = await synthesizeSceneNarration({ scene: structuredClone(scene), force: false });

    expect(summary).toMatchObject({ generated: 1, failed: [] });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it('skips a fallback whose required key is missing', async () => {
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    // No legacy key for minimax-tts: it is not a usable candidate at all.
    mocks.apiKey.mockReturnValue('');
    mocks.generate.mockRejectedValue(new Error('connection refused'));

    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      // One usable candidate means the slot's own provider gets the retry
      // budget; skip the backoff so the test does not wait it out.
      sleep: async () => {},
    });

    expect(summary).toMatchObject({ available: true, generated: 0 });
    expect(summary.failed.map((failure) => failure.id)).toEqual(['speech-a']);
    // The keyless fallback never becomes a candidate: every attempt is the
    // slot's provider, so nothing is spent trying a provider that cannot answer.
    expect(mocks.generate).toHaveBeenCalled();
    expect(
      mocks.generate.mock.calls.every(
        ([config]) => (config as { providerId: string }).providerId === 'openai-tts',
      ),
    ).toBe(true);
  });

  it('is sticky: after a failover the next action starts from the winner', async () => {
    const twoActions = {
      ...structuredClone(scene),
      actions: [
        { id: 'speech-a', type: 'speech', text: 'Hello' },
        { id: 'speech-b', type: 'speech', text: 'World' },
      ],
    } as Scene;
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');
    mocks.generate
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-x.wav');

    const summary = await synthesizeSceneNarration({ scene: twoActions, force: false });

    expect(summary.generated).toBe(2);
    const calls = mocks.generate.mock.calls.map((c) => (c[0] as { providerId: string }).providerId);
    expect(calls).toEqual(['openai-tts', 'minimax-tts', 'minimax-tts']);
  });

  it('throws the retryable timeout when every candidate hangs', async () => {
    const { TTSRequestTimeoutError } = await import('@/lib/audio/tts-providers');
    mocks.providers.mockResolvedValue(slotConnection());
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');
    mocks.generate.mockRejectedValue(
      new TTSRequestTimeoutError('openai-tts', 'TTS request timed out after 30000ms'),
    );

    await expect(
      synthesizeSceneNarration({ scene: structuredClone(scene), force: false }),
    ).rejects.toBeInstanceOf(TTSRequestTimeoutError);
  });

  it('reports unavailable when the assignment lacks its required key', async () => {
    // A misconfigured assignment is reported as unavailable instead of being
    // masked by a fallback provider.
    mocks.providers.mockResolvedValue({ ...slotConnection(), apiKey: undefined });
    mocks.enabled.mockReturnValue(['openai-tts', 'minimax-tts']);
    mocks.apiKey.mockReturnValue('legacy-key');

    const summary = await synthesizeSceneNarration({ scene: structuredClone(scene), force: false });

    expect(summary).toMatchObject({ available: false, changed: false, generated: 0 });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
