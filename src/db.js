import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Durable state in one SQLite file:
 * - outbox:    every message Echo means to send, with its delivery status;
 *              survives restarts, retried with backoff, never sent twice for
 *              the same event (dedupe_key)
 * - inbound:   WhatsApp message ids already handled (webhooks are retried)
 * - windows:   when each person last wrote to us (24-hour service window)
 * - sessions:  "I asked you to type a note, the next message is the note"
 * - decisions: one decision per person per message, so a double tap acts once
 */
export function openDatabase(dataDir) {
    let file = ':memory:';
    if (dataDir !== ':memory:') {
        mkdirSync(dataDir, { recursive: true });
        file = join(dataDir, 'echo.db');
    }
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS outbox (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            project         TEXT NOT NULL,
            item_id         TEXT,
            kind            TEXT NOT NULL,
            recipient       TEXT NOT NULL,
            message_json    TEXT NOT NULL,
            template_json   TEXT,
            fingerprint     TEXT,
            dedupe_key      TEXT UNIQUE,
            status          TEXT NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            wa_message_id   TEXT UNIQUE,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_attempt_at);

        CREATE TABLE IF NOT EXISTS inbound (
            wa_message_id TEXT PRIMARY KEY,
            received_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS windows (
            phone           TEXT PRIMARY KEY,
            last_inbound_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            phone       TEXT PRIMARY KEY,
            outbox_id   INTEGER NOT NULL,
            mode        TEXT NOT NULL,
            expires_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS decisions (
            outbox_id  INTEGER NOT NULL,
            phone      TEXT NOT NULL,
            action     TEXT NOT NULL,
            decided_at INTEGER NOT NULL,
            PRIMARY KEY (outbox_id, phone)
        );
    `);
    return db;
}

export function createStore(db, now = () => Date.now()) {
    const q = (sql) => db.prepare(sql);

    const statements = {
        insertOutbox: q(`INSERT OR IGNORE INTO outbox
            (project, item_id, kind, recipient, message_json, template_json, fingerprint, dedupe_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        due: q(`SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`),
        claim: q(`UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`),
        outboxById: q(`SELECT * FROM outbox WHERE id = ?`),
        outboxByWaId: q(`SELECT * FROM outbox WHERE wa_message_id = ?`),
        markSent: q(`UPDATE outbox SET status = 'sent', wa_message_id = ?, last_error = NULL, updated_at = ? WHERE id = ?`),
        reschedule: q(`UPDATE outbox SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`),
        fail: q(`UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`),
        skip: q(`UPDATE outbox SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?`),
        setStatus: q(`UPDATE outbox SET status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE wa_message_id = ?`),
        recoverStuck: q(`UPDATE outbox SET status = 'pending', updated_at = ? WHERE status = 'sending' AND updated_at < ?`),
        markInbound: q(`INSERT OR IGNORE INTO inbound (wa_message_id, received_at) VALUES (?, ?)`),
        touchWindow: q(`INSERT INTO windows (phone, last_inbound_at) VALUES (?, ?)
            ON CONFLICT(phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at`),
        window: q(`SELECT last_inbound_at FROM windows WHERE phone = ?`),
        setSession: q(`INSERT INTO sessions (phone, outbox_id, mode, expires_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET outbox_id = excluded.outbox_id, mode = excluded.mode, expires_at = excluded.expires_at`),
        session: q(`SELECT * FROM sessions WHERE phone = ? AND expires_at > ?`),
        clearSession: q(`DELETE FROM sessions WHERE phone = ?`),
        decide: q(`INSERT OR IGNORE INTO decisions (outbox_id, phone, action, decided_at) VALUES (?, ?, ?, ?)`),
        undecide: q(`DELETE FROM decisions WHERE outbox_id = ? AND phone = ?`),
        stats: q(`SELECT status, COUNT(*) AS count FROM outbox GROUP BY status`),
    };

    const parse = (row) =>
        row && {
            ...row,
            message: JSON.parse(row.message_json),
            template: row.template_json ? JSON.parse(row.template_json) : null,
        };

    return {
        /** @returns {number|null} the new id, or null when dedupe_key was already used */
        enqueue({ project, itemId = null, kind, recipient, message, template = null, fingerprint = null, dedupeKey = null }) {
            const t = now();
            const result = statements.insertOutbox.run(
                project, itemId, kind, recipient, JSON.stringify(message),
                template ? JSON.stringify(template) : null, fingerprint, dedupeKey, t, t,
            );
            return result.changes ? Number(result.lastInsertRowid) : null;
        },
        due: (limit = 20) => statements.due.all(now(), limit).map(parse),
        claim: (id) => statements.claim.run(now(), id).changes === 1,
        outbox: (id) => parse(statements.outboxById.get(id)),
        outboxByWaId: (waId) => parse(statements.outboxByWaId.get(waId)),
        markSent: (id, waId) => statements.markSent.run(waId, now(), id),
        reschedule: (id, delayMs, error) => statements.reschedule.run(now() + delayMs, error, now(), id),
        fail: (id, error) => statements.fail.run(error, now(), id),
        skip: (id, reason) => statements.skip.run(reason, now(), id),
        setStatusByWaId: (waId, status, error = null) => statements.setStatus.run(status, error, now(), waId).changes,
        recoverStuck: (olderThanMs) => statements.recoverStuck.run(now(), now() - olderThanMs).changes,
        /** @returns {boolean} true the first time this WhatsApp message id is seen */
        markInbound: (waId) => statements.markInbound.run(waId, now()).changes === 1,
        touchWindow: (phone) => statements.touchWindow.run(phone, now()),
        windowOpen(phone, marginMs = 10 * 60 * 1000) {
            const row = statements.window.get(phone);
            return Boolean(row) && now() - row.last_inbound_at < 24 * 60 * 60 * 1000 - marginMs;
        },
        setSession: (phone, outboxId, mode, ttlMs = 30 * 60 * 1000) => statements.setSession.run(phone, outboxId, mode, now() + ttlMs),
        session: (phone) => statements.session.get(phone, now()) ?? null,
        clearSession: (phone) => statements.clearSession.run(phone),
        /** @returns {boolean} true when this is the person's first decision on this message */
        decide: (outboxId, phone, action) => statements.decide.run(outboxId, phone, action, now()).changes === 1,
        undecide: (outboxId, phone) => statements.undecide.run(outboxId, phone),
        stats: () => Object.fromEntries(statements.stats.all().map((row) => [row.status, row.count])),
    };
}
