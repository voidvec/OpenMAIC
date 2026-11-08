import { createHash } from 'node:crypto';

import { DEFAULT_MAX_DELAY_MS } from '@openmaic/generation';
import {
  agentToolBudgetRemainingMs,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
} from '@/lib/agent/runtime/tool-timeout';
import { configuredDefaultVoice } from '@/lib/audio/provider-default-voice';
import {
  authorizeMediaModel,
  serverMediaConnection,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { ModelAuthorizationError } from '@/lib/server/model-config/model-authorization';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import { audioFailureKind } from '@/lib/audio/provider-error';
import { DEFAULT_TTS_MODELS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import {
  generateTTS,
  TTSRateLimitError,
  TTSRequestTimeoutError,
  type TTSGenerationResult,
} from '@/lib/audio/tts-providers';
import { runFailureCode, type RunFailureErrorCode } from '@/lib/server/generation/run/failure-code';
import { SCENE_MAX_RETRIES, withRouteRetry } from '@/lib/server/generation/run/retry';
import { isUpstreamQuotaExhausted } from '@/lib/server/llm-error-response';
import { createSemaphore } from '@/lib/utils/concurrency';
import type { ConfiguredTTSVoice, TTSProviderId } from '@/lib/audio/types';
import { BROWSER_NATIVE_TTS_PROVIDER_ID } from '@/lib/audio/provider-enablement';
import type { LegacySpeechAction, SpeechAction } from '@/lib/types/action';
import type { GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import { adapterOptions } from '@/lib/server/model-config/adapter-options';
import {
  enabledServerTTSProviderIds,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  slotTTSModel,
} from '@/lib/server/provider-config';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneTts');

export interface SceneTtsFailure {
  id: string;
  /** `runFailureCode().errorCode`. Never a provider body or `error.message`. */
  reason: RunFailureErrorCode;
  /** Safe recovery instruction, independent of the provider’s public error code. */
  recovery?: 'reclone';
}

/**
 * The one voice every line of this synthesis used. Narration is voiced by the
 * roster teacher's binding when it belongs to the tts slot's provider, and by
 * the provider default otherwise; saying which is what lets the agent see that
 * a roster change did (or did not) reach the audio.
 */
export interface SceneTtsVoice {
  /** `providerId::voiceId`; the voice part is empty when the provider has no default. */
  binding: string;
  source: 'roster-teacher' | 'provider-default';
  /** The teacher whose binding applied, or who was passed over for the default. */
  teacher?: string;
  /** Why a teacher binding did not apply. */
  fallbackReason?: 'no-teacher' | 'teacher-unbound' | 'teacher-bound-to-other-provider';
}

export interface SceneTtsSummary {
  available: boolean;
  changed: boolean;
  generated: number;
  skipped: number;
  failed: SceneTtsFailure[];
  voice?: SceneTtsVoice;
}

/** Small default. `OPENMAIC_AGENT_TTS_CONCURRENCY` overrides it. The cap is per process. */
const AGENT_TTS_IN_FLIGHT_DEFAULT = 1;
const AGENT_TTS_CONCURRENCY_ENV = 'OPENMAIC_AGENT_TTS_CONCURRENCY';

interface ProviderGateEntry {
  gate: ReturnType<typeof createSemaphore>;
  /** Narration calls using this entry, including those waiting on Retry-After. */
  callers: number;
  /** Epoch ms. Provider calls on this connection wait until then. */
  notBefore: number;
}

const providerGates = new Map<string, ProviderGateEntry>();

function agentTtsInFlightLimit(): number {
  const raw = process.env[AGENT_TTS_CONCURRENCY_ENV]?.trim();
  if (!raw) return AGENT_TTS_IN_FLIGHT_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : AGENT_TTS_IN_FLIGHT_DEFAULT;
}

function connectionGateKey(connection: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  managed: boolean;
  deploymentProviderId?: string;
}): string {
  if (connection.managed && connection.deploymentProviderId) {
    return `managed:${connection.deploymentProviderId}`;
  }
  const keyHash = createHash('sha256')
    .update(connection.apiKey ?? '', 'utf8')
    .digest('hex');
  return `account:${connection.providerId}\0${connection.baseUrl ?? ''}\0${keyHash}`;
}

type ConnectionGateIdentity = {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  managed: boolean;
  deploymentProviderId?: string;
};

function sweepIdleProviderGates(now: number) {
  for (const [key, entry] of providerGates) {
    if (entry.callers === 0 && entry.notBefore <= now) providerGates.delete(key);
  }
}

function holdProviderGate(connection: ConnectionGateIdentity) {
  sweepIdleProviderGates(Date.now());
  const key = connectionGateKey(connection);
  let entry = providerGates.get(key);
  if (!entry) {
    entry = { gate: createSemaphore(agentTtsInFlightLimit()), callers: 0, notBefore: 0 };
    providerGates.set(key, entry);
  }
  entry.callers += 1;
  return { key, entry };
}

function releaseProviderGate(held: { key: string; entry: ProviderGateEntry }) {
  held.entry.callers -= 1;
  if (
    held.entry.callers === 0 &&
    held.entry.notBefore <= Date.now() &&
    providerGates.get(held.key) === held.entry
  ) {
    providerGates.delete(held.key);
  }
}

function noteConnectionRetryAfter(entry: ProviderGateEntry, retryAfterMs: number) {
  const clamped = Math.min(DEFAULT_MAX_DELAY_MS, retryAfterMs);
  if (!(clamped > 0)) return;
  entry.notBefore = Math.max(entry.notBefore, Date.now() + clamped);
}

function consumeConnectionCooldown(entry: ProviderGateEntry, coveredUntil: number) {
  // An injected sleep does not move Date.now(). Pull a covered deadline back to
  // now so the next acquire does not wait forever. A real sleep has already
  // passed it, so this assignment does not change notBefore.
  if (entry.notBefore <= coveredUntil) {
    entry.notBefore = Math.min(entry.notBefore, Date.now());
  }
}

function cooldownExceedsBudgetError(): Error {
  return Object.assign(new Error('TTS retry wait exceeds the remaining tool budget'), {
    statusCode: 429,
    ttsBudgetWait: true,
  });
}

function isTtsBudgetWaitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { ttsBudgetWait?: unknown }).ttsBudgetWait === true
  );
}

/** Test-only. Drops connection gates and their Retry-After deadlines. */
export function resetAgentTtsProviderGatesForTests(): void {
  providerGates.clear();
}

/** Model-visible tally. Error codes only, never action ids or provider bodies. */
export function formatTtsFailureTally(
  failed: readonly Pick<SceneTtsFailure, 'reason' | 'recovery'>[],
): string {
  if (failed.length === 0) return '0 failed';
  const counts = new Map<string, number>();
  for (const failure of failed) {
    counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([code, count]) => `${code}\u00d7${count}`).join(', ');
  const guidance = failed.some((failure) => failure.recovery === 'reclone')
    ? ' Re-upload the reference audio to clone the saved voice again.'
    : '';
  return `${failed.length} failed (${breakdown})${guidance}`;
}

export interface SceneTtsInput {
  scene: Scene;
  force: boolean;
  roster?: readonly GeneratedAgentConfig[] | null;
  signal?: AbortSignal;
  /** The run's owner, whose tts slot applies. */
  ownerId?: string;
  /** Retry sleep. Production waits; tests pass a fake clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Budget when `signal` is not the tool-timeout signal. Defaults to the
   * `generate_tts` budget. A tool-timeout deadline on `signal` wins.
   */
  budgetMs?: number;
}

function remainingBudgetMs(input: SceneTtsInput, startedAt: number): number {
  const fromTool = agentToolBudgetRemainingMs(input.signal);
  if (fromTool !== undefined) return fromTool;
  return (input.budgetMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS) - (Date.now() - startedAt);
}

async function waitForConnectionCooldown(
  entry: ProviderGateEntry,
  input: SceneTtsInput,
  startedAt: number,
): Promise<void> {
  for (;;) {
    const deadline = entry.notBefore;
    const wait = deadline - Date.now();
    if (wait <= 0) return;
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (wait >= remainingBudgetMs(input, startedAt)) throw cooldownExceedsBudgetError();
    await (input.sleep ?? abortableSleep)(wait, input.signal);
    // Same fake-timer pullback as consumeConnectionCooldown.
    if (entry.notBefore <= deadline) {
      entry.notBefore = Math.min(entry.notBefore, Date.now());
      return;
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One ready-to-call TTS provider: config resolved once, before synthesis. */
interface TtsCandidate {
  providerId: TTSProviderId;
  apiKey: string;
  baseUrl: string | undefined;
  voice: string;
  /** The deployment's configured voice list, when the provider declares one. */
  voices?: ConfiguredTTSVoice[];
  modelId: string;
  managed: boolean;
  /** Set on a managed connection: the gate key of the slot's own account. */
  deploymentProviderId?: string;
  publicOnly: boolean;
  providerOptions?: Record<string, unknown>;
  /**
   * The slot's own connection, when this candidate is the assignment. The
   * fallbacks are built from legacy env vars and have no connection to
   * authorize against.
   */
  connection?: MediaConnection;
}

function narratorVoice(roster: SceneTtsInput['roster']) {
  return roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig)?.voiceConfig;
}

function voiceReport(
  roster: SceneTtsInput['roster'],
  providerId: string,
  voice: string,
): SceneTtsVoice {
  // The same teacher narratorVoice picks: the first bound one, else the first.
  const teacher =
    roster?.find((agent) => agent.role === 'teacher' && agent.voiceConfig) ??
    roster?.find((agent) => agent.role === 'teacher');
  const bound = teacher?.voiceConfig;
  const binding = `${providerId}::${voice}`;
  if (bound?.providerId === providerId && bound.voiceId) {
    return { binding, source: 'roster-teacher', teacher: teacher!.name };
  }
  return {
    binding,
    source: 'provider-default',
    ...(teacher?.name ? { teacher: teacher.name } : {}),
    fallbackReason: !teacher
      ? 'no-teacher'
      : bound?.providerId && bound.voiceId
        ? 'teacher-bound-to-other-provider'
        : 'teacher-unbound',
  };
}

/** One line for a tool result: which voice the synthesized lines used, and why. */
export function describeNarrationVoice(voice: SceneTtsVoice): string {
  if (voice.source === 'roster-teacher') {
    return `Voice: ${voice.binding} (teacher "${voice.teacher}"'s roster binding).`;
  }
  const why =
    voice.fallbackReason === 'no-teacher'
      ? 'the roster has no teacher'
      : voice.fallbackReason === 'teacher-bound-to-other-provider'
        ? `teacher "${voice.teacher}" is bound to a voice of another provider`
        : `teacher "${voice.teacher}" has no voice bound`;
  return `Voice: ${voice.binding} (provider default; ${why}).`;
}

function audioMime(format: string) {
  return format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
}

/** Check whether a TTS connection is enabled and usable. */
export function hasConfiguredTtsCapability(
  connection: MediaConnection | 'off' | null | undefined,
): boolean {
  if (
    !connection ||
    connection === 'off' ||
    !connection.providerId ||
    connection.providerId === BROWSER_NATIVE_TTS_PROVIDER_ID
  ) {
    return false;
  }
  const providerId = connection.providerId as TTSProviderId;
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (provider?.requiresApiKey && !connection.apiKey) {
    return false;
  }
  return true;
}

function defaultVoice(providerId: TTSProviderId) {
  return DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || '';
}

/** The candidate for the slot's own connection (the tts slot's assignment). */
function slotCandidate(
  connection: Exclude<MediaConnection, 'off'>,
  bound: ReturnType<typeof narratorVoice>,
): TtsCandidate {
  const providerId = connection.providerId as TTSProviderId;
  const voice =
    bound?.providerId === providerId && bound.voiceId
      ? bound.voiceId
      : configuredDefaultVoice(connection.options, connection.voices) || defaultVoice(providerId);
  const model =
    connection.modelId ?? (DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '');
  // A configured slot's own model; the legacy server pins apply only to a default.
  const modelId =
    (connection.origin === 'configuration'
      ? slotTTSModel(providerId, model, voice, connection.voices)
      : resolveTTSModel(providerId, model, voice, connection.voices)) || '';
  // Authorizing the wire model is a per-line check, not a per-run one: a
  // refusal must reach the caller as a failure of that line, and it must come
  // after the saved voice is checked (see requestNarration).
  return {
    providerId,
    apiKey: connection.apiKey ?? '',
    baseUrl: connection.baseUrl,
    voice,
    ...(connection.voices ? { voices: connection.voices } : {}),
    modelId,
    managed: connection.managed,
    deploymentProviderId: connection.deploymentProviderId,
    publicOnly: connection.userEndpoint,
    providerOptions: adapterOptions(connection),
    connection,
  };
}

/**
 * The legacy deployment providers this instance also serves, as fallbacks
 * behind the slot's assignment. Only enabled providers survive (force-disabled
 * loses, #665), and one that cannot resolve a model is dropped rather than
 * turning every narration line into a failure: a fallback must never be worse
 * than having none.
 */
function fallbackCandidates(
  primaryId: TTSProviderId,
  bound: ReturnType<typeof narratorVoice>,
): TtsCandidate[] {
  const candidates: TtsCandidate[] = [];
  for (const rawId of enabledServerTTSProviderIds()) {
    const providerId = rawId as TTSProviderId;
    if (providerId === primaryId || providerId === BROWSER_NATIVE_TTS_PROVIDER_ID) continue;
    const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
    if (!provider) continue;
    const apiKey = resolveTTSApiKey(providerId);
    if (provider.requiresApiKey && !apiKey) continue;
    const voice =
      bound?.providerId === providerId && bound.voiceId ? bound.voiceId : defaultVoice(providerId);
    let modelId = '';
    try {
      modelId =
        resolveTTSModel(
          providerId,
          DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
          voice,
        ) || '';
    } catch {
      continue;
    }
    candidates.push({
      providerId,
      apiKey,
      baseUrl: resolveTTSBaseUrl(providerId),
      voice,
      modelId,
      // Operator configuration: its endpoint may be on a local network and is
      // not a caller-supplied URL to police.
      managed: true,
      publicOnly: false,
    });
  }
  return candidates;
}

/**
 * Gate identity for one candidate. The concurrency cap and the Retry-After
 * deadline belong to the account a call is billed to, and two candidates are
 * two accounts — a failover must not inherit the first provider's cooldown.
 */
function candidateGateIdentity(candidate: TtsCandidate): ConnectionGateIdentity {
  return {
    providerId: candidate.providerId,
    baseUrl: candidate.baseUrl,
    apiKey: candidate.apiKey,
    managed: candidate.managed,
    deploymentProviderId: candidate.deploymentProviderId,
  };
}

/**
 * One narration line through one candidate: take its connection slot, wait out
 * any Retry-After the account is serving, and retry the same provider on a
 * retryable failure. Gating and pacing stay one account's problem; deciding
 * that the account is unusable and moving on is the caller's job.
 *
 * The in-flight slot covers the provider call only: the retry sleep and the
 * cooldown wait do not hold it. A retryable rate limit stores Retry-After on the
 * connection, so the last attempt and a parallel call still wait before the next
 * acquire. A quota refusal does not. A wait the remaining tool budget cannot
 * cover fails this line instead of sleeping. A timeout still aborts the tool
 * instead of being retried.
 */
async function requestNarration(
  candidate: TtsCandidate,
  held: { key: string; entry: ProviderGateEntry },
  speech: SpeechAction,
  input: SceneTtsInput,
  startedAt: number,
  /**
   * Retries for this provider before the caller moves to the next one. With a
   * single candidate that is the only way forward, so it keeps the classroom
   * clip's budget. With several, backing off on a provider that just refused is
   * time the next provider could have spent speaking — the failover is the
   * retry.
   */
  maxRetries: number,
): Promise<TTSGenerationResult> {
  let retryAfterMs = 0;
  let lastError: unknown;
  return withRouteRetry(
    async () => {
      if (input.signal?.aborted) throw new Error('aborted');
      for (;;) {
        await waitForConnectionCooldown(held.entry, input, startedAt);
        // Re-check inside the slot. A queued caller can be released after a
        // sibling records Retry-After; leave the slot and wait outside it.
        let deferred = false;
        const audio = await held.entry.gate.run(async () => {
          if (held.entry.notBefore > Date.now()) {
            deferred = true;
            return undefined;
          }
          try {
            // Check the saved voice against this provider before spending a
            // call, and authorize the wire model it resolves to. Both failures
            // are the line's, not the run's: the caller records them and moves
            // to the next candidate.
            getVoiceRegistrationAdapter(candidate.providerId)?.assertVoiceCompatible?.(
              candidate.voice,
              candidate.voices,
            );
            // Resolve and authorize the wire model only after checking the saved voice.
            if (candidate.connection) {
              authorizeMediaModel(candidate.connection, 'tts', candidate.modelId);
            }
            return await generateTTS(
              {
                providerId: candidate.providerId,
                modelId: candidate.modelId,
                apiKey: candidate.apiKey,
                baseUrl: candidate.baseUrl,
                managed: candidate.managed,
                publicOnly: candidate.publicOnly,
                voice: candidate.voice,
                ...(candidate.voices ? { voices: candidate.voices } : {}),
                speed: speech.speed,
                // The provider's own options (a VoxCPM backend, say).
                providerOptions: candidate.providerOptions,
                signal: input.signal,
              },
              speech.text,
            );
          } catch (error) {
            lastError = error;
            // Quota exhaustion is not a retryable rate limit. Do not keep its
            // Retry-After. MiniMax attaches ProviderQuotaExhaustedError;
            // OpenAI-compatible providers attach the JSON body as cause.data
            // (insufficient_quota).
            if (
              error instanceof TTSRateLimitError &&
              error.retryAfterMs !== undefined &&
              !isUpstreamQuotaExhausted(error)
            ) {
              retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
              noteConnectionRetryAfter(held.entry, error.retryAfterMs);
            }
            throw error;
          }
        });
        if (!deferred) {
          if (audio === undefined) throw new Error('TTS provider returned no audio');
          return audio;
        }
      }
    },
    {
      label: `agent-tts ${speech.id}`,
      maxRetries,
      refusalStatus: 400,
      signal: input.signal,
      sleep: async (ms, signal) => {
        if (signal?.aborted || input.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const pace = retryAfterMs;
        retryAfterMs = 0;
        const wait = Math.min(DEFAULT_MAX_DELAY_MS, Math.max(ms, pace));
        if (wait > 0 && wait >= remainingBudgetMs(input, startedAt)) {
          throw lastError ?? cooldownExceedsBudgetError();
        }
        const coveredUntil = Date.now() + wait;
        await (input.sleep ?? abortableSleep)(wait, signal);
        consumeConnectionCooldown(held.entry, coveredUntil);
      },
      rethrow: (error) =>
        error instanceof TTSRequestTimeoutError ||
        error instanceof ModelAuthorizationError ||
        audioFailureKind(error) === 'voice-incompatible' ||
        audioFailureKind(error) === 'timeout' ||
        input.signal?.aborted === true ||
        isTtsBudgetWaitError(error),
    },
  );
}

/** Server-configured narration synthesis into the stage's classroom-media path. */
export async function synthesizeSceneNarration(input: SceneTtsInput): Promise<SceneTtsSummary> {
  const startedAt = Date.now();
  // The tts slot decides the provider; the narrator's bound voice applies
  // only when it belongs to that provider.
  const connection = await serverMediaConnection('tts', input.ownerId);
  if (!hasConfiguredTtsCapability(connection)) {
    return { available: false, changed: false, generated: 0, skipped: 0, failed: [] };
  }
  const activeConnection = connection as MediaConnection;
  const providerId = activeConnection.providerId as TTSProviderId;
  const bound = narratorVoice(input.roster);
  // The assigned provider speaks first; a runtime failure (a flaky endpoint, a
  // hung request) degrades to the deployment's other enabled providers instead
  // of costing the course its narration. A misconfigured assignment (no key)
  // is still reported as unavailable above rather than masked by a fallback.
  const candidates = [
    slotCandidate(activeConnection, bound),
    ...fallbackCandidates(providerId, bound),
  ];
  // Sticky winner: once a fallback answers, later actions start from it so a
  // flapping first choice is not re-probed on every line.
  let preferredIdx = 0;
  let generated = 0;
  let skipped = 0;
  const failed: SceneTtsFailure[] = [];
  // One gate per candidate, held for the whole run. Taking a slot is cheap until
  // a call actually runs, and keeping every gate alive means a failover lands on
  // a connection whose cap and cooldown are already tracked rather than on a
  // fresh gate that believes the account is idle.
  const held = candidates.map((candidate) => holdProviderGate(candidateGateIdentity(candidate)));
  try {
    for (const action of input.scene.actions ?? []) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speech = action as SpeechAction;
      if (!input.force && speech.audioId) {
        skipped += 1;
        continue;
      }
      if (input.signal?.aborted) throw new Error('aborted');
      let served = false;
      let timeoutError: unknown;
      let authorizationError: ModelAuthorizationError | null = null;
      let lastError: unknown;
      // A single candidate is retried; several mean the next one is cheaper than
      // a backoff, so each gets exactly one attempt.
      const retriesPerProvider = candidates.length > 1 ? 0 : SCENE_MAX_RETRIES;
      for (let attempt = 0; attempt < candidates.length && !served; attempt += 1) {
        const idx = (preferredIdx + attempt) % candidates.length;
        const candidate = candidates[idx];
        try {
          const audio = await requestNarration(
            candidate,
            held[idx],
            speech,
            input,
            startedAt,
            retriesPerProvider,
          );
          if (input.signal?.aborted) throw new Error('aborted');
          // The persisted reference is the RELATIVE classroom-media path (the
          // agent runtime has no request origin; relative stays valid on any
          // deployment origin — see classroom-media-bytes.ts). The browser's
          // narration consumers (timeline status/preview, playback, exports)
          // resolve a speech line through the legacy (audioId, audioUrl) pair:
          // `audioId` alone is never resolvable to bytes client-side, while a
          // present `audioUrl` marks the line voiced and is what the audio
          // element / fetch fallback plays. Stamp the same relative path on both.
          const audioId = await persistClassroomMediaBytes({
            stageId: input.scene.stageId,
            bytes: Buffer.from(audio.audio),
            mime: audioMime(audio.format),
            prefix: `tts-${action.id}`,
            signal: input.signal,
          });
          speech.audioId = audioId;
          (speech as LegacySpeechAction).audioUrl = audioId;
          if (attempt > 0) {
            log.warn(
              `TTS failover: ${candidates[preferredIdx].providerId} failed for ${action.id}, served by ${candidate.providerId}`,
            );
          }
          preferredIdx = idx;
          served = true;
          generated += 1;
        } catch (error) {
          if (input.signal?.aborted) throw error;
          // An adapter timeout is not this provider's trouble to retry: whether
          // it is wrapped in TTSRequestTimeoutError or reported through the
          // failure kind, the line records it and the run fails with it once
          // every candidate has hung.
          if (error instanceof TTSRequestTimeoutError || audioFailureKind(error) === 'timeout') {
            timeoutError ??= error;
          }
          if (error instanceof ModelAuthorizationError) authorizationError = error;
          lastError = error;
        }
      }
      if (!served) {
        // Every candidate failed. A hung provider must fail the tool call with
        // the retryable timeout error instead of degrading into a per-action
        // failure: the remaining actions would hit the same hung upstream and
        // the session would wedge. With failover this is only reached when all
        // of them hang. An unauthorized model is the operator's to fix, so it
        // keeps its own error rather than being reported as a provider failure.
        if (timeoutError !== undefined) throw timeoutError;
        if (authorizationError) throw authorizationError;
        failed.push({
          id: action.id,
          reason: runFailureCode(lastError).errorCode,
          // A saved voice the provider no longer accepts is the only failure a
          // re-upload can fix, so say so instead of leaving the code alone.
          ...(audioFailureKind(lastError) === 'voice-incompatible'
            ? { recovery: 'reclone' as const }
            : {}),
        });
      }
    }
    return {
      available: true,
      changed: generated > 0,
      generated,
      skipped,
      failed,
      // Report the candidate that actually voiced the lines: after a failover
      // the slot's own provider is no longer the one that produced the audio.
      voice: voiceReport(
        input.roster,
        candidates[preferredIdx].providerId,
        candidates[preferredIdx].voice,
      ),
    };
  } finally {
    for (const gate of held) releaseProviderGate(gate);
  }
}
