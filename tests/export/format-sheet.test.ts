/**
 * The format sheet is the document a reviewer checks the video against, so its
 * numbers have to come from the file, and it must never name a file the bundle
 * does not carry — a checklist pointing at `片头页.png` in a pack that has no
 * such file costs a support round-trip on submission day.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFormatSheet,
  buildRecordingSheet,
  type FormatSheetInput,
  type RecordingSheetInput,
} from '@/lib/export/format-sheet';

const base: FormatSheetInput = {
  title: '二次函数图像四步判断',
  filename: '05_二次函数图像四步判断.mp4',
  bytes: 47_969_288,
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 1042.267,
  quality: 'standard',
  cues: 412,
  hasIntro: true,
};

describe('buildFormatSheet', () => {
  it('quotes the measured video parameters', () => {
    const sheet = buildFormatSheet(base);
    expect(sheet).toContain('# 报送格式说明 · 二次函数图像四步判断');
    expect(sheet).toContain('| 时长 | 0:17:22 | 1042 秒 |');
    expect(sheet).toContain('| 分辨率 | 1920 × 1080 | 1080p |');
    expect(sheet).toContain('| 帧率 | 30 fps |');
    expect(sheet).toContain('| 总帧数 | 31268 |');
    // 47.97 MB over 1042 s.
    expect(sheet).toContain('| 总码率 | 368 kbps |');
  });

  it('names the opening frame only when the pack carries one', () => {
    expect(buildFormatSheet(base)).toContain('格式件/片头页.png');
    expect(buildFormatSheet({ ...base, hasIntro: false })).not.toContain('格式件/片头页.png');
  });

  // A browser that could not read the duration must not produce a sheet with a
  // divide-by-zero bitrate or a "0 秒" length that a reviewer reads as a defect.
  it('omits the figures that need a duration when it could not be measured', () => {
    const sheet = buildFormatSheet({ ...base, durationSec: 0 });
    expect(sheet).toContain('| 时长 | 未测出 | 浏览器未能读取时长 |');
    expect(sheet).not.toContain('总码率');
    expect(sheet).not.toContain('总帧数');
    expect(sheet).toContain('| 码率不低于 N Mbps | 未知 |');
  });

  it('lists the subtitle count so a reviewer can match it against the track', () => {
    expect(buildFormatSheet(base)).toContain('（412 条，UTF-8');
  });
});

/**
 * The submission tier ships no video — contest rules put the teacher on camera —
 * so its sheet must not pretend to have measured one. What it can honestly say
 * is how to record and export, plus the narration length from the subtitles.
 */
describe('buildRecordingSheet', () => {
  const brief: RecordingSheetInput = {
    title: '二次函数图像四步判断',
    width: 1920,
    height: 1080,
    fps: 30,
    narrationSec: 1042,
    cues: 412,
    hasIntro: true,
  };

  it('states up front that this tier has no video', () => {
    const sheet = buildRecordingSheet(brief);
    expect(sheet).toContain('# 报送格式说明 · 二次函数图像四步判断');
    expect(sheet).toContain('**不含成片**');
    expect(sheet).toContain('| 成片 | **不含**，由你录制人像后合成 |');
  });

  it('quotes target parameters, never measured ones', () => {
    const sheet = buildRecordingSheet(brief);
    expect(sheet).toContain('| 分辨率 | 1920 × 1080 | 1080p');
    expect(sheet).toContain('| 帧率 | 30 fps |');
    // There is no file, so there is no bitrate, no frame count and no file size.
    expect(sheet).not.toContain('总码率');
    expect(sheet).not.toContain('总帧数');
    expect(sheet).not.toContain('MB');
  });

  it('labels the narration length as a reference, not the video length', () => {
    expect(buildRecordingSheet(brief)).toContain('| 参考时长 | 0:17:22 |');
    expect(buildRecordingSheet(brief)).toContain('加上人像过场会略长');
  });

  it('names the opening frame only when the pack carries one', () => {
    expect(buildRecordingSheet(brief)).toContain('格式件/片头页.png');
    const without = buildRecordingSheet({ ...brief, hasIntro: false });
    expect(without).not.toContain('格式件/片头页.png');
    expect(without).toContain('这一版包里没有片头页');
  });

  // The sheet is what a teacher reads before hitting record, so the two things
  // that actually cause a re-shoot have to be in it.
  it('warns about the frame rate and bitrate floor', () => {
    const sheet = buildRecordingSheet(brief);
    expect(sheet).toContain('帧率必须 25fps');
    expect(sheet).toContain('码率不低于 N Mbps');
  });
});
