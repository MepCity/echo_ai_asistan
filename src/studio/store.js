import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The studio gateway's own SQLite file (studio.db next to Echo's echo.db):
 * - generations: every generation attempt, refused ones too. `day`/`month` are
 *   the Europe/Istanbul calendar day and month it was made in (limits count by
 *   them). `status`: 'refused' (never sent), 'submitting' (sent, no answer yet),
 *   'submitted' (Higgsfield took it, job id known), 'completed', 'failed',
 *   'late' (job id known, still running past the stale limit: no longer blocks
 *   new generations, still counted, polled until it finishes or lateMaxHours),
 *   'unknown' (the answer was lost, a job without a job id stayed pending past
 *   the stale limit, or a late job passed lateMaxHours: it may have run and cost credits, so it counts against the limits
 *   and is never sent again). `requested_by` is the person key the model gave,
 *   or 'bilinmiyor' (shared bucket) when it gave none or an unknown one.
 *   `raw_answer`: a raw copy (~8 KB) of a generate answer no job id could be read from.
 *   `recovered_at`: when an admin attached a job id by hand (studio.sh recover); the stale/late
 *   clocks then run from it instead of created_at.
 * - attachments: generated images uploaded to TryPost (post id, upload sha256).
 */
export function openStudioDatabase(dir) {
    let file = ':memory:';
    if (dir !== ':memory:') {
        try {
            mkdirSync(dir, { recursive: true });
        } catch (err) {
            if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
            const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
            const gid = typeof process.getgid === 'function' ? process.getgid() : '?';
            throw new Error(
                `Studio veri klasoru olusturulamadi: ${dir} (${err.code}, kullanici ${uid}:${gid}). ` +
                `echo-data birimi echo servisinin kullanicisina (uid 1000) ait; studio ise HERMES_UID:HERMES_GID ile calisiyor. ` +
                `VM'de su komutu calistir: bash /opt/echo/app/deploy/oracle/hermes/studio-prepare.sh ` +
                `(ya da bash /opt/echo/app/deploy/oracle/update.sh). Klasoru ${uid}:${gid} kullanicisina verir.`,
                { cause: err },
            );
        }
        file = join(dir, 'studio.db');
    }
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS generations (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            day TEXT NOT NULL,
            month TEXT NOT NULL,
            tool TEXT NOT NULL,
            kind TEXT NOT NULL,
            model TEXT,
            params TEXT,
            estimated_credits REAL,
            actual_credits REAL,
            job_id TEXT,
            status TEXT NOT NULL,
            reason TEXT,
            requested_by TEXT,
            file TEXT,
            mime TEXT,
            bytes INTEGER,
            sha256 TEXT,
            width INTEGER,
            height INTEGER,
            source_url TEXT
        );
        CREATE INDEX IF NOT EXISTS generations_day ON generations (day, status);
        CREATE INDEX IF NOT EXISTS generations_month ON generations (month, status);
        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generation_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            project TEXT NOT NULL,
            post_id TEXT,
            created_post INTEGER NOT NULL DEFAULT 0,
            sha256 TEXT,
            status TEXT NOT NULL,
            reason TEXT
        );
    `);
    // Columns added after the first release: added in place to an existing studio.db.
    const have = new Set(db.prepare('PRAGMA table_info(generations)').all().map((column) => column.name));
    for (const [name, type] of [
        ['raw_answer', 'TEXT'],
        ['recovered_at', 'INTEGER'],
    ]) {
        if (!have.has(name)) db.exec(`ALTER TABLE generations ADD COLUMN ${name} ${type}`);
    }
    return db;
}

// Rows that may have cost credits: everything sent, except jobs Higgsfield reports failed (refunded).
const SPENT = "status IN ('submitting', 'submitted', 'late', 'completed', 'unknown')";

export function createStudioStore(db, now = () => Date.now()) {
    const credits = 'COALESCE(SUM(COALESCE(actual_credits, estimated_credits, 0)), 0)';
    return {
        now,
        insert(row) {
            const time = now();
            db.prepare(
                `INSERT INTO generations (id, created_at, updated_at, day, month, tool, kind, model, params, estimated_credits, status, reason, requested_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(row.id, time, time, row.day, row.month, row.tool, row.kind, row.model ?? null, row.params ? JSON.stringify(row.params) : null, row.estimated ?? null, row.status, row.reason ?? null, row.requestedBy ?? null);
        },
        update(id, fields) {
            const columns = {
                status: 'status',
                reason: 'reason',
                jobId: 'job_id',
                estimated: 'estimated_credits',
                actual: 'actual_credits',
                file: 'file',
                mime: 'mime',
                bytes: 'bytes',
                sha256: 'sha256',
                sourceUrl: 'source_url',
                width: 'width',
                height: 'height',
                model: 'model',
                params: 'params',
                rawAnswer: 'raw_answer',
                recoveredAt: 'recovered_at',
            };
            const sets = [];
            const values = [];
            for (const [key, value] of Object.entries(fields)) {
                if (!columns[key]) continue;
                sets.push(`${columns[key]} = ?`);
                values.push(key === 'params' && value ? JSON.stringify(value) : value ?? null);
            }
            sets.push('updated_at = ?');
            values.push(now(), id);
            db.prepare(`UPDATE generations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        },
        /** The latest attempts, newest last. */
        recent(limit = 50) {
            return db.prepare('SELECT * FROM (SELECT rowid AS seq, * FROM generations ORDER BY rowid DESC LIMIT ?) ORDER BY seq').all(limit);
        },
        get(id) {
            return db.prepare('SELECT * FROM generations WHERE id = ?').get(id) ?? null;
        },
        /** The row (other than `exceptId`) that already has this job id, or null. */
        byJobId(jobId, exceptId = '') {
            return db.prepare('SELECT * FROM generations WHERE lower(job_id) = lower(?) AND id != ?').get(jobId, exceptId) ?? null;
        },
        usage(day, month) {
            const daily = db.prepare(`SELECT kind, COUNT(*) AS count, ${credits} AS credits FROM generations WHERE day = ? AND ${SPENT} GROUP BY kind`).all(day);
            const monthly = db.prepare(`SELECT ${credits} AS credits FROM generations WHERE month = ? AND ${SPENT}`).get(month);
            const counts = { image: 0, speech: 0, music: 0 };
            let dayCredits = 0;
            for (const row of daily) {
                counts[row.kind] = Number(row.count);
                dayCredits += Number(row.credits);
            }
            return { counts, dayCredits, monthCredits: Number(monthly.credits) };
        },
        personCredits(day, person) {
            return Number(db.prepare(`SELECT ${credits} AS credits FROM generations WHERE day = ? AND requested_by = ? AND ${SPENT}`).get(day, person).credits);
        },
        /** Sent jobs not yet finished ('submitting' or 'submitted'), oldest first: while one exists no new generation starts. */
        pending() {
            return db.prepare("SELECT * FROM generations WHERE status IN ('submitting', 'submitted') ORDER BY created_at, rowid").all();
        },
        /** Jobs still running past the stale limit ('late', job id known), oldest first. They do not block new generations. */
        late() {
            return db.prepare("SELECT * FROM generations WHERE status = 'late' AND job_id IS NOT NULL ORDER BY created_at, rowid").all();
        },
        /** Time of the last generation sent to Higgsfield (for the cooldown), or null. */
        lastSentAt() {
            const row = db.prepare("SELECT MAX(created_at) AS at FROM generations WHERE status IN ('submitting', 'submitted', 'late', 'completed', 'unknown', 'failed')").get();
            return row?.at ?? null;
        },
        addAttachment(row) {
            db.prepare('INSERT INTO attachments (generation_id, created_at, project, post_id, created_post, sha256, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
                row.generationId,
                now(),
                row.project,
                row.postId ?? null,
                row.createdPost ? 1 : 0,
                row.sha256 ?? null,
                row.status,
                row.reason ?? null,
            );
        },
        attachments(generationId) {
            return db.prepare('SELECT * FROM attachments WHERE generation_id = ? ORDER BY id').all(generationId);
        },
    };
}
