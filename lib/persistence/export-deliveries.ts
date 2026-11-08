/**
 * The delivery ledger: one row per exported artifact that must reach the
 * Aliyun Drive folder the customer will be sent.
 *
 * This is deliberately a *table* rather than an in-memory queue, because the
 * work it holds outlives the request that starts it. An MP4 render takes an
 * hour and the upload of it another few minutes; a browser that closes its tab
 * mid-way must not lose the delivery, and a container restart must not leave a
 * half-shared folder with nobody to finish it. Every step below is resumable
 * from the row alone: what has been uploaded is recorded, so a retry after a
 * share failure does not re-upload 116 MB.
 *
 * The two producers write different halves of a row:
 *
 * - MP4 (`render_job_id` set, `local_path` null) — the render proxy records the
 *   job at submit time, and the worker fetches the bytes from the render
 *   service itself. Nothing is required of the browser after the click, which
 *   is the point: the render outlives the page.
 * - Everything else (`local_path` set) — PPTX and the standalone-HTML ZIP only
 *   ever exist in the browser's memory, so `/api/deliver/upload` already wrote
 *   the bytes next to this row before inserting it.
 *
 * `status` is coarse on purpose. Only `pending` rows are claimed; `done` and
 * `failed` are final. What remains to be done for a pending row is derived from
 * which columns are filled, never from a separate stage field — one less thing
 * that can disagree with the filesystem.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS export_deliveries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  course_title TEXT,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  render_job_id TEXT,
  local_path TEXT,
  remote_path TEXT,
  share_url TEXT,
  share_pwd TEXT,
  bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * The claim query scans exactly this predicate, and the table is small (one row
 * per export on a single-user deployment), so one partial index is enough.
 */
const INDEX = `
CREATE INDEX IF NOT EXISTS export_deliveries_pending
  ON export_deliveries (next_attempt_at, created_at)
  WHERE status = 'pending'`;

export const EXPORT_DELIVERY_MIGRATIONS: SchemaMigrationSet = {
  store: 'export-deliveries',
  migrations: [
    { version: 1, name: 'baseline', up: `${SCHEMA};${INDEX}`, transaction: false },
    {
      // Versioned per revision rather than per file: a course that comes back
      // for changes is the normal case, and the customer has to be able to tell
      // v2 from the v1 they already downloaded.
      version: 2,
      name: 'revision',
      up: `ALTER TABLE export_deliveries ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1`,
      transaction: false,
    },
  ],
};

export async function ensureExportDeliverySchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, EXPORT_DELIVERY_MIGRATIONS);
}

export type ExportDeliveryStatus = 'pending' | 'done' | 'failed';

/** Artifact kinds. `video` may be fetched by the worker; the rest arrive by upload. */
export type ExportDeliveryFormat = 'mp4' | 'pptx' | 'html' | 'zip';

export interface ExportDelivery {
  id: string;
  ownerId: string;
  courseTitle: string | null;
  format: ExportDeliveryFormat;
  filename: string;
  renderJobId: string | null;
  localPath: string | null;
  remotePath: string | null;
  shareUrl: string | null;
  sharePwd: string | null;
  bytes: number | null;
  status: ExportDeliveryStatus;
  detail: string | null;
  attempts: number;
  /**
   * Which round of the course this artifact belongs to. One course folder holds
   * `v1/`, `v2/`, … so a customer who comes back for changes gets a new folder
   * instead of overwriting what they already downloaded.
   */
  revision: number;
  /** Submit time, used for the "how long did the whole thing take" figure. */
  createdAtMs: number;
}

/** The `Record` side satisfies the query helper's row constraint. */
interface Row extends Record<string, unknown> {
  id: string;
  owner_id: string;
  course_title: string | null;
  format: string;
  filename: string;
  render_job_id: string | null;
  local_path: string | null;
  remote_path: string | null;
  share_url: string | null;
  share_pwd: string | null;
  bytes: string | number | null;
  status: string;
  detail: string | null;
  attempts: number;
  revision: number | null;
  created_at: string | Date;
}

const SELECT = `SELECT id, owner_id, course_title, format, filename, render_job_id,
       local_path, remote_path, share_url, share_pwd, bytes, status, detail, attempts,
       revision, created_at
  FROM export_deliveries`;

function toDelivery(row: Row): ExportDelivery {
  return {
    id: row.id,
    ownerId: row.owner_id,
    courseTitle: row.course_title,
    format: row.format as ExportDeliveryFormat,
    filename: row.filename,
    renderJobId: row.render_job_id,
    localPath: row.local_path,
    remotePath: row.remote_path,
    shareUrl: row.share_url,
    sharePwd: row.share_pwd,
    // pg returns BIGINT as a string to avoid the precision loss `number` would
    // impose; delivery sizes are far below 2^53, so the conversion is exact.
    bytes: row.bytes === null ? null : Number(row.bytes),
    status: row.status as ExportDeliveryStatus,
    detail: row.detail,
    attempts: row.attempts,
    // Rows written before the column existed read as NULL from an old snapshot;
    // they are all v1 by definition.
    revision: row.revision ?? 1,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

export interface NewExportDelivery {
  id: string;
  ownerId: string;
  courseTitle: string | null;
  format: ExportDeliveryFormat;
  filename: string;
  renderJobId?: string | null;
  localPath?: string | null;
  bytes?: number | null;
  /** Defaults to 1; the client sends the round it is delivering. */
  revision?: number;
}

export async function insertExportDelivery(
  queryable: Queryable,
  record: NewExportDelivery,
): Promise<void> {
  await queryable.query(
    `INSERT INTO export_deliveries
       (id, owner_id, course_title, format, filename, render_job_id, local_path, bytes, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      record.id,
      record.ownerId,
      record.courseTitle,
      record.format,
      record.filename,
      record.renderJobId ?? null,
      record.localPath ?? null,
      record.bytes ?? null,
      record.revision ?? 1,
    ],
  );
}

/**
 * Whether this render already has a delivery row. The submit route is the only
 * writer, but a client retrying a request whose response it never saw would
 * otherwise queue the same job twice and upload the same MP4 twice.
 */
export async function findDeliveryByRenderJob(
  queryable: Queryable,
  renderJobId: string,
): Promise<ExportDelivery | null> {
  const result = await queryable.query<Row>(`${SELECT} WHERE render_job_id = $1 LIMIT 1`, [
    renderJobId,
  ]);
  return result.rows[0] ? toDelivery(result.rows[0]) : null;
}

/**
 * A share link that already covers this course.
 *
 * Every artifact of one course lands in the same cloud folder, so the second
 * export of that course — the MP4 after the PPTX, say — must reuse the first
 * link instead of minting another: the customer is meant to receive one link
 * per course, and Aliyun Drive would otherwise accumulate near-identical
 * shares of the same folder.
 *
 * Matched on the course title as it was written to the ledger, which is the
 * raw title the two producers sent; `excludeId` keeps a row from reusing a
 * value it is about to write itself.
 */
export async function findReusableShare(
  queryable: Queryable,
  ownerId: string,
  courseTitle: string | null,
  excludeId: string,
): Promise<{ url: string; pwd: string | null } | null> {
  const result = await queryable.query<{ share_url: string; share_pwd: string | null }>(
    `SELECT share_url, share_pwd FROM export_deliveries
      WHERE owner_id = $1
        AND status = 'done'
        AND share_url IS NOT NULL
        AND coalesce(course_title, '') = coalesce($2, '')
        AND id <> $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [ownerId, courseTitle, excludeId],
  );
  const row = result.rows[0];
  if (!row?.share_url) return null;
  return { url: row.share_url, pwd: row.share_pwd };
}

/**
 * Take the oldest due pending row, if any.
 *
 * `FOR UPDATE SKIP LOCKED` inside the CTE means two workers on the same
 * database take different rows rather than fighting over one; the UPDATE then
 * touches only the row this caller won. The row is not marked "in progress":
 * a worker that dies mid-pass leaves it pending, and the retry resumes from
 * whichever columns are already filled.
 */
export async function claimNextExportDelivery(
  queryable: Queryable,
): Promise<ExportDelivery | null> {
  const result = await queryable.query<Row>(
    `WITH picked AS (
       SELECT id FROM export_deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE export_deliveries d SET updated_at = now()
       FROM picked WHERE d.id = picked.id
     RETURNING d.id, d.owner_id, d.course_title, d.format, d.filename, d.render_job_id,
               d.local_path, d.remote_path, d.share_url, d.share_pwd, d.bytes,
               d.status, d.detail, d.attempts, d.revision, d.created_at`,
  );
  return result.rows[0] ? toDelivery(result.rows[0]) : null;
}

/** Record the bytes and where they now live, so a retry can skip the upload. */
export async function markExportDeliveryCollected(
  queryable: Queryable,
  id: string,
  collected: { localPath: string; bytes: number },
): Promise<void> {
  await queryable.query(
    `UPDATE export_deliveries
        SET local_path = $2, bytes = $3, updated_at = now()
      WHERE id = $1`,
    [id, collected.localPath, collected.bytes],
  );
}

/** The upload landed; the cloud path is known but no share exists yet. */
export async function markExportDeliveryUploaded(
  queryable: Queryable,
  id: string,
  remotePath: string,
): Promise<void> {
  await queryable.query(
    `UPDATE export_deliveries SET remote_path = $2, updated_at = now() WHERE id = $1`,
    [id, remotePath],
  );
}

export async function completeExportDelivery(
  queryable: Queryable,
  id: string,
  share: { remotePath: string; shareUrl: string; sharePwd: string | null },
): Promise<void> {
  await queryable.query(
    `UPDATE export_deliveries
        SET status = 'done', remote_path = $2, share_url = $3, share_pwd = $4,
            detail = NULL, updated_at = now()
      WHERE id = $1`,
    [id, share.remotePath, share.shareUrl, share.sharePwd],
  );
}

/**
 * Push a pending row back with a delay, without spending an attempt: the render
 * job was simply not finished yet. Attempts are for things that went wrong.
 */
export async function deferExportDelivery(
  queryable: Queryable,
  id: string,
  delayMs: number,
): Promise<void> {
  await queryable.query(
    `UPDATE export_deliveries
        SET next_attempt_at = now() + make_interval(secs => $2::double precision / 1000),
            updated_at = now()
      WHERE id = $1`,
    [id, delayMs],
  );
}

/**
 * Count a real failure. The attempt that reaches `maxAttempts` settles the row
 * as `failed` in the same statement, so a crash cannot leave a row sitting at
 * the limit and still pending. Answers the new attempt count and status.
 */
export async function recordExportDeliveryFailure(
  queryable: Queryable,
  id: string,
  message: string,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<{ attempts: number; status: ExportDeliveryStatus }> {
  const result = await queryable.query<{ attempts: number; status: string }>(
    `UPDATE export_deliveries
        SET attempts = attempts + 1,
            detail = $2,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = now() + make_interval(secs => $4::double precision / 1000),
            updated_at = now()
      WHERE id = $1
      RETURNING attempts, status`,
    [id, message.slice(0, 2000), maxAttempts, retryDelayMs],
  );
  const row = result.rows[0];
  return {
    attempts: row?.attempts ?? maxAttempts,
    status: (row?.status ?? 'failed') as ExportDeliveryStatus,
  };
}

/** Settle a row as failed without spending an attempt (a definitive rejection). */
export async function failExportDelivery(
  queryable: Queryable,
  id: string,
  message: string,
): Promise<void> {
  await queryable.query(
    `UPDATE export_deliveries SET status = 'failed', detail = $2, updated_at = now()
      WHERE id = $1`,
    [id, message.slice(0, 2000)],
  );
}
