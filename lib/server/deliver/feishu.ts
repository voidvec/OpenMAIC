/**
 * Feishu group-bot notifications for finished (and failed) deliveries.
 *
 * A custom bot webhook is the least infrastructure that still reaches a phone:
 * one HTTPS POST, no tenant application, no OAuth, no polling. The message is an
 * interactive card rather than plain text because the link and the extraction
 * code have to be readable at a glance while copy-pasting into a chat window.
 *
 * Notifications are best-effort. A delivery is already on the cloud by the time
 * one is sent, so a Feishu outage must not roll the row back into a retry loop —
 * it is logged and dropped.
 */
import { createHmac } from 'node:crypto';

import { createLogger } from '@/lib/logger';

import type { DeliverConfig } from './config';

const log = createLogger('ExportDeliveryFeishu');

/**
 * Feishu signs by using `timestamp + "\n" + secret` as the HMAC **key** and
 * signing the empty string, then Base64. Signing the timestamp itself is the
 * usual mistake and answers `19021` forever.
 */
function sign(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '未知';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

interface CardField {
  label: string;
  value: string;
}

async function postCard(
  config: DeliverConfig,
  card: { template: string; title: string; fields: CardField[]; body?: string },
): Promise<void> {
  const url = config.feishuWebhookUrl;
  if (!url) return;

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = {
    msg_type: 'interactive',
    ...(config.feishuWebhookSecret
      ? { timestamp, sign: sign(timestamp, config.feishuWebhookSecret) }
      : {}),
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: card.template,
        title: { tag: 'plain_text', content: card.title },
      },
      elements: [
        {
          tag: 'div',
          fields: card.fields.map((field) => ({
            is_short: true,
            text: { tag: 'lark_md', content: `**${field.label}**\n${field.value}` },
          })),
        },
        ...(card.body
          ? [{ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: card.body } }]
          : []),
      ],
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (!response.ok || answer.code !== 0) {
      log.warn(`Feishu rejected the notification: HTTP ${response.status} ${answer.msg ?? ''}`);
    }
  } catch (error) {
    log.warn('Feishu notification failed; the delivery itself is unaffected.', error);
  }
}

export interface DeliveredNotice {
  courseTitle: string;
  formatLabel: string;
  bytes: number | null;
  /** Wall time from submit to a usable share link. */
  elapsedMs: number;
  shareUrl: string;
  sharePwd: string | null;
  cloudDir: string;
}

export async function notifyDelivered(
  config: DeliverConfig,
  notice: DeliveredNotice,
): Promise<void> {
  const body = [
    `**阿里云盘**\n${notice.shareUrl}`,
    notice.sharePwd ? `提取码：\`${notice.sharePwd}\`` : '公开链接（无提取码）',
    `云端目录：\`${notice.cloudDir}\``,
    '',
    '> 发闲鱼时先给链接，对方确认收到后再给提取码。',
  ].join('\n');

  await postCard(config, {
    template: 'green',
    title: `✅《${notice.courseTitle}》已上云`,
    fields: [
      { label: '格式', value: notice.formatLabel },
      { label: '大小', value: formatBytes(notice.bytes) },
      { label: '耗时', value: formatDuration(notice.elapsedMs) },
      { label: '状态', value: '可发给客户' },
    ],
    body,
  });
}

export async function notifyDeliveryFailed(
  config: DeliverConfig,
  failed: { courseTitle: string; formatLabel: string; filename: string; detail: string },
): Promise<void> {
  await postCard(config, {
    template: 'red',
    title: `❌《${failed.courseTitle}》上云失败`,
    fields: [
      { label: '格式', value: failed.formatLabel },
      { label: '文件', value: failed.filename },
      { label: '状态', value: '已停止重试' },
    ],
    body: `**原因**\n${failed.detail.slice(0, 600)}`,
  });
}
