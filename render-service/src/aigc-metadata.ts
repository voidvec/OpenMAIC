/**
 * Implicit AIGC label for rendered MP4s — GB 45438-2025 §6.1, 《人工智能生成合成
 * 内容标识办法》article 4.
 *
 * The visible half of the label is burned into the opening frames by the
 * emitter (see `lib/video-export/aigc-label.ts`), which covers playback where
 * the picture is the only thing a person sees. §6.1 asks for the other half as
 * well: the generated-content flag, the provider and the content number have to
 * travel *inside* the file, so a distributor or a platform can read them
 * without looking at a frame.
 *
 * `@hyperframes/producer` writes the container itself and takes no metadata
 * options, so the finished file is remuxed once with a stream copy
 * (`-c copy`: no re-encode, no quality change). That costs a few seconds on a
 * multi-gigabyte export — measurable, but far below the per-frame capture that
 * produced it.
 *
 * The stamp is best-effort by design: a file that cannot be remuxed still
 * carries the visible label, so a failure here must never fail the render. The
 * caller logs the miss and ships the export.
 */
import { execFile } from 'node:child_process';
import { rename, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Identity a compliant deployment must be able to state about its output. */
export interface AigcMetadata {
  /** 生成合成服务提供者名称或编码. */
  provider: string;
  /** 生成合成服务提供者对内容的唯一编号. */
  contentId: string;
}

export interface StampAigcMetadataOptions {
  /** The rendered file, rewritten in place on success. */
  filePath: string;
  metadata: AigcMetadata;
  /** Resolved ffmpeg binary; defaults to the one the producer uses. */
  ffmpegPath?: string;
  /** Remux budget. A stream copy of a long export is minutes at most. */
  timeoutMs?: number;
}

/** The statement written into the container, in the standard's terms. */
export function aigcMetadataStatement(metadata: AigcMetadata): string {
  return `AI-generated content | provider=${metadata.provider} | content-id=${metadata.contentId}`;
}

function metadataArgs(metadata: AigcMetadata): string[] {
  const statement = aigcMetadataStatement(metadata);
  // `comment` and `description` are the two MP4 tags ffprobe and every desktop
  // player surface; writing both means the label survives whichever one a
  // downstream tool reads.
  return ['-metadata', `comment=${statement}`, '-metadata', `description=${statement}`];
}

function resolveFfmpegPath(): string {
  return process.env.HYPERFRAMES_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Suffix of the in-progress remux; same directory, so the rename is atomic. */
const TEMP_SUFFIX = '.aigc.tmp.mp4';

/**
 * Remux `filePath` in place so its container carries the implicit label.
 *
 * @returns true when the file now carries the metadata, false when the remux
 *   did not happen (ffmpeg missing, non-zero exit, empty output). The original
 *   file is left untouched on every failure path.
 */
export async function stampAigcMetadata(options: StampAigcMetadataOptions): Promise<boolean> {
  const { filePath, metadata } = options;
  const ffmpegPath = options.ffmpegPath ?? resolveFfmpegPath();
  const tempPath = `${filePath}${TEMP_SUFFIX}`;
  try {
    await run(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-map',
        '0',
        '-c',
        'copy',
        ...metadataArgs(metadata),
        '-f',
        'mp4',
        tempPath,
      ],
      { timeout: options.timeoutMs ?? 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    );
    // An exit code of 0 with a zero-byte file would destroy the export on the
    // rename below; check the result before taking the original's place.
    const { size } = await stat(tempPath);
    if (size === 0) {
      await rm(tempPath, { force: true }).catch(() => {});
      return false;
    }
    await rename(tempPath, filePath);
    return true;
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    return false;
  }
}
