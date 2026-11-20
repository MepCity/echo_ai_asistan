import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The studio gateway's own SQLite file (studio.db next to Echo's echo.db):
 * - generations: every generation attempt, refused ones too. `day`/`month` are
 *   the Europe/Istanbul calendar day and month it was made in (limits count by
 *   them). `status`: 'refused' (never sent), 'submitting' (sent, no answer yet),
 *   'submitted' (Higgsfield took it, job id known), 'completed', 'failed',
 *   'unknown' (the answer was lost: it may have run and cost credits, so it
 *   counts against the limits and is never sent again).
 * - attachments: generated images uploaded to TryPost (post id, upload sha256).
 */
export function openStudioDatabase(dir) {
    let file = ':memory:';
    if (dir !== ':memory:') {
        mkdirSync(dir, { recursive: true });
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
    return db;
}

// Rows that may have cost credits: everything sent, except jobs Higgsfield reports failed (refunded).
const SPENT = "status IN ('submitting', 'submitted', 'completed', 'unknown')";

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
        /** Time of the last generation sent to Higgsfield (for the cooldown), or null. */
        lastSentAt() {
            const row = db.prepare("SELECT MAX(created_at) AS at FROM generations WHERE status IN ('submitting', 'submitted', 'completed', 'unknown', 'failed')").get();
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
