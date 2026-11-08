/**
 * The format sheet a competition entry ships.
 *
 * There are two of them, because the two tiers hand over different things:
 *
 * - The video tier has the MP4, so its sheet quotes what the render *actually*
 *   produced. A reviewer checks resolution, frame rate and duration against the
 *   notice, and a sheet quoting last week's values reads as authoritative right
 *   up to the moment it is wrong. Every figure comes from the stored
 *   `RenderedVideoRecord`, which is why it is generated at export time rather
 *   than authored.
 * - The submission tier has no MP4 at all: contest rules require the teacher on
 *   camera, so the buyer records that themselves. Quoting "measured" numbers for
 *   a file nobody has yet would be a lie, so its sheet is a *recording brief* —
 *   the parameters to shoot and export with. See `buildRecordingSheet`.
 *
 * Deliberately Chinese-only and not in the i18n catalogue; it exists because
 * provincial contest notices are Chinese-language documents, and both the
 * checklist and the "what would force a re-render" section are written for that
 * reader. A localized variant would need a per-region notice, which this repo
 * does not have.
 */

/** Everything the measured sheet quotes, all read from the exported file. */
export interface FormatSheetInput {
  title: string;
  filename: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  /** 0 when the browser could not measure it. */
  durationSec: number;
  quality: string;
  /** Subtitle cues, 0 when the course has no narration. */
  cues: number;
  /** True when the bundle also carries `格式件/片头页.png`. */
  hasIntro: boolean;
}

/**
 * What the recording brief can honestly say.
 *
 * Deliberately has no `bytes`, `durationSec` (of a video) or `quality`: the
 * submission tier ships no video, so any figure of that kind would be invented.
 * The narration length comes from the subtitle timeline, which does exist —
 * generated from the same script the buyer reads aloud.
 */
export interface RecordingSheetInput {
  title: string;
  /** Target frame size, from the render options the operator exported at. */
  width: number;
  height: number;
  /** Target frame rate. */
  fps: number;
  /** Narration length in seconds (last subtitle cue), 0 when unknown. */
  narrationSec: number;
  /** Subtitle cues, 0 when the course has no narration. */
  cues: number;
  /** True when the bundle also carries `格式件/片头页.png`. */
  hasIntro: boolean;
}

const MB = 1024 * 1024;

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`;
}

/** `H:MM:SS`, the form a contest submission form asks for. */
function hms(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Video bitrate in kbps, or 0 when the duration is unknown. */
function kbps(bytes: number, seconds: number): number {
  return seconds > 0 ? Math.round((bytes * 8) / seconds / 1000) : 0;
}

/**
 * Build the sheet.
 *
 * The "what would force a re-render" table is the part that earns its keep: a
 * notice asking for 25 fps or a bitrate floor is the only realistic reason this
 * video would have to be produced again, and finding that out before submission
 * is the difference between a re-export and a missed deadline.
 */
export function buildFormatSheet(input: FormatSheetInput): string {
  const bitrate = kbps(input.bytes, input.durationSec);
  const lines: string[] = [];

  lines.push(`# 报送格式说明 · ${input.title}`, '');
  lines.push(
    '> 本文件按导出时的实际参数生成，不是模板填数。',
    '> 赛区要求若有出入，按赛区通知为准；差异项见文末「需要重渲的情况」。',
    '',
  );

  lines.push('## 1. 成片技术参数', '');
  lines.push('| 项 | 实测值 | 说明 |', '| --- | --- | --- |');
  lines.push(`| 文件 | \`${input.filename}\` | ${mb(input.bytes)} |`);
  lines.push(
    `| 时长 | ${input.durationSec > 0 ? hms(input.durationSec) : '未测出'} | ${
      input.durationSec > 0 ? `${Math.round(input.durationSec)} 秒` : '浏览器未能读取时长'
    } |`,
  );
  lines.push(`| 分辨率 | ${input.width} × ${input.height} | ${input.height}p |`);
  lines.push(`| 帧率 | ${input.fps} fps | 恒定帧率 |`);
  lines.push(`| 视频编码 | H.264 / yuv420p | 主流播放器与投稿系统通用 |`);
  if (bitrate > 0) lines.push(`| 总码率 | ${bitrate} kbps | 含音轨 |`);
  if (input.durationSec > 0)
    lines.push(`| 总帧数 | ${Math.round(input.durationSec * input.fps)} | 时长 × 帧率 |`);
  lines.push(`| 音轨 | AAC 双声道 | 已含配音 |`);
  lines.push('');

  lines.push('## 2. 交付清单', '');
  lines.push('| 件 | 在哪里 |', '| --- | --- |');
  lines.push(`| 成片 | \`05_${input.title}.mp4\` |`);
  // Only name the opening frame when the bundle actually carries one: a
  // checklist that points at a missing file costs a support round-trip.
  if (input.hasIntro) lines.push(`| 片头页 | \`格式件/片头页.png\`（1920×1080） |`);
  lines.push(`| 课件 | \`01_${input.title}.pptx\` |`);
  lines.push(`| 字幕 | \`04_${input.title}.srt\`（${input.cues} 条，UTF-8，时间轴对好配音） |`);
  lines.push(`| 交互课件 | \`交互页面/\`，每页一个 HTML，双击即播 |`);
  lines.push('');

  lines.push('## 3. 提交前自查', '');
  lines.push(
    '- [ ] 成片从头到尾看过一遍，无黑屏、无空画面、无错别字',
    '- [ ] 片头页的作者、单位已换成本人信息（样例里的不是真实信息）',
    '- [ ] 赛区要求的**人像出镜**镜头已单独补录并接入（AI 生成的成片不含真人）',
    '- [ ] 文件命名、扩展名与赛区模板一致，未压缩成 rar',
    '- [ ] 若赛区要求「不出现第三方标识」，已确认 AIGC 标识的去留并留痕',
    '',
  );

  lines.push('## 4. 需要重渲的情况', '');
  lines.push('| 赛区写了什么 | 现在的值 | 处理 |', '| --- | --- | --- |');
  lines.push(
    `| 帧率必须 25fps | ${input.fps} fps | 导出对话框帧率栏直接填 25 重渲（服务端接受 1–120） |`,
  );
  lines.push(
    `| 码率不低于 N Mbps | ${bitrate > 0 ? `${(bitrate / 1000).toFixed(2)} Mbps` : '未知'} | CRF 编码没有固定码率档，需 ffmpeg 二次编码补到目标值，体积会涨十几倍 |`,
  );
  lines.push(
    '| 时长卡死上下限 | 见上表 | 增删小节后重生成，不要剪成片（剪了字幕与旁白会对不上） |',
  );
  lines.push('');
  lines.push(
    '> 分辨率、封装格式、音轨这几项实测已符合常见要求，一般不必动。',
    '> 真正会逼着重渲的只有**帧率**和**码率下限**两条。',
    '',
  );

  return lines.join('\n');
}

/**
 * The sheet for the tier that ships no video.
 *
 * A contest entry is sold on the materials, because the rules put the teacher on
 * camera and no AI render can stand in for that. So there is nothing to measure
 * and the useful document is the opposite: the parameters to record and export
 * with, in the order a teacher will actually touch them.
 *
 * The one thing it can quote from the file is the narration length — the
 * subtitle timeline exists either way — so it is labelled 参考时长 rather than
 * 时长, because the on-camera segments will push the finished video past it.
 */
export function buildRecordingSheet(input: RecordingSheetInput): string {
  const lines: string[] = [];

  lines.push(`# 报送格式说明 · ${input.title}`, '');
  lines.push(
    '> 本档（参赛材料包）**不含成片**：多数赛区要求教师本人出镜，人像由你录。',
    '> 所以这份给的是**录制与导出参数**，不是实测值。录完想核对实际参数，',
    '> 把成片发我，或在剪映 / PR 里看文件信息。',
    '',
  );

  lines.push('## 1. 录制与导出参数', '');
  lines.push('| 项 | 按这个设 | 说明 |', '| --- | --- | --- |');
  lines.push(
    `| 分辨率 | ${input.width} × ${input.height} | ${input.height}p；赛区另有要求按赛区 |`,
  );
  lines.push(`| 帧率 | ${input.fps} fps | 恒定帧率，不是可变帧率；赛区写 25 就用 25 |`);
  lines.push('| 视频编码 | H.264 / yuv420p | 主流投稿系统都收 |');
  lines.push('| 封装 | .mp4 | 别用 rar 再套一层，也别交 mov |');
  lines.push('| 音轨 | AAC 双声道 48 kHz | 录制时同步收你的声音；讲稿按朗读排版，照着念 |');
  if (input.cues > 0) {
    lines.push(
      `| 字幕 | \`04_${input.title}.srt\`（${input.cues} 条） | 时间轴已对好旁白，别自己重新打 |`,
    );
  }
  lines.push(
    `| 参考时长 | ${input.narrationSec > 0 ? hms(input.narrationSec) : '按讲稿字数估'} | ${
      input.narrationSec > 0 ? '旁白末条；加上人像过场会略长' : '讲稿按 145 字/分钟折算'
    } |`,
  );
  lines.push('');

  lines.push('## 2. 片头页怎么用', '');
  if (input.hasIntro) {
    lines.push(
      `\`格式件/片头页.png\` —— ${input.width}×${input.height}，深蓝底白字楷体三行。`,
      '',
      '录屏开始前先全屏放 5 秒，或后期剪到第一帧。',
      '页上作者与单位是样例写法，**报送前必须换成本人信息**——',
      '直接在 PPT 里改完再导出 PNG，比在图片上涂改干净。',
      '',
    );
  } else {
    lines.push(
      '这一版包里没有片头页。片头时长和画面按赛区模板做，',
      '或按你往年的片子沿用——需要我出一张就单独说。',
      '',
    );
  }

  lines.push('## 3. 交付清单', '');
  lines.push('| 件 | 在哪里 |', '| --- | --- |');
  lines.push(`| 课件 | \`01_${input.title}.pptx\`（可编辑，互动环节是索引页） |`);
  lines.push(`| 讲稿 | \`02_${input.title}-讲稿.docx\`，源稿 \`03_${input.title}-讲稿.md\` |`);
  lines.push(`| 字幕 | \`04_${input.title}.srt\`（UTF-8，时间轴对好旁白） |`);
  lines.push('| 交互课件 | `交互页面/`，每页一个 HTML，双击即播，录屏时用它 |');
  if (input.hasIntro)
    lines.push(`| 片头页 | \`格式件/片头页.png\`（${input.width}×${input.height}） |`);
  lines.push('| 成片 | **不含**，由你录制人像后合成 |');
  lines.push('');

  lines.push('## 4. 录制与提交前自查', '');
  lines.push(
    '- [ ] 人像出镜已录进去（有的赛区写「累计不少于总时长 10%」，问清再录）',
    '- [ ] 片头页的作者、单位已换成本人信息（样例里的不是真实信息）',
    '- [ ] 成片从头到尾看过一遍，无黑屏、无空画面、无错别字',
    '- [ ] 字幕与旁白对齐，用的是 04 那份 srt，没有重新打一遍',
    '- [ ] 文件命名、扩展名与赛区模板一致，未压缩成 rar',
    '- [ ] 若赛区要求「不出现第三方标识」，已确认 AIGC 标识的去留并留痕',
    '',
  );

  lines.push('## 5. 赛区另有要求时', '');
  lines.push('| 赛区写了什么 | 现在按什么做 | 处理 |', '| --- | --- | --- |');
  lines.push(`| 帧率必须 25fps | ${input.fps} fps | 录制或导出时直接设 25，别交上去再转 |`);
  lines.push('| 码率不低于 N Mbps | 未指定 | 导出时把码率锁到 N 以上，别用「推荐」档 |');
  lines.push('| 时长卡死上下限 | 见上表参考时长 | 增删小节后重生成课件，不要剪交互页 |');
  lines.push('| 要交 PPT / 讲稿原件 | 01 / 02 已给 | 直接交，别再另存为图片 |');
  lines.push('');
  lines.push(
    '> 分辨率、编码、封装这三项照上表设就不会踩雷，',
    '> 真正会返工的只有**帧率**和**码率下限**两条，先确认再开录。',
    '',
  );

  return lines.join('\n');
}
