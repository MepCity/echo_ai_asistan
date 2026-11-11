import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Durable state in one SQLite file:
 * - outbox:    every message Echo means to send, with its delivery status;
 *              survives restarts, retried with backoff, never sent twice for
 *              the same event (dedupe_key)
 * - inbox:     every WhatsApp message we received, processed in order per
 *              person by the worker; kept pending (with backoff) while the
 *              project is unreachable, so a reply is never lost. The WhatsApp
 *              message id is the key, so a retried Meta webhook acts once.
 * - windows:   when each person last wrote to us (24-hour service window)
 * - sessions:  "I asked you to type a note, the next message is the note"
 * - decisions: one decision per person per message, so a double tap acts once;
 *              'started' (owned by the inbound message that started it) until
 *              the project confirmed it, then 'applied'. A retry of the same
 *              message after a crash finds its own 'started' decision and
 *              finishes it instead of refusing.
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
            failure_reported INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_attempt_at);

        CREATE TABLE IF NOT EXISTS inbox (
            wa_message_id   TEXT PRIMARY KEY,
            phone           TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            route_json      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            notified        INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS inbox_due ON inbox (status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS inbox_phone ON inbox (phone, status);

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
            state      TEXT NOT NULL DEFAULT 'applied',
            wa_message_id TEXT,
            PRIMARY KEY (outbox_id, phone)
        );
    `);
    migrate(db);
    return db;
}

/** Adds columns that databases created by older versions lack. */
function migrate(db) {
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (!columns('decisions').includes('state')) {
        // Decisions recorded before states existed were applied (they were recorded and acted on together).
        db.exec(`
            ALTER TABLE decisions ADD COLUMN state TEXT NOT NULL DEFAULT 'applied';
            ALTER TABLE decisions ADD COLUMN wa_message_id TEXT;
        `);
    }
    if (!columns('outbox').includes('failure_reported')) {
        // Failures from before the upgrade were already reported at the time.
        db.exec(`
            ALTER TABLE outbox ADD COLUMN failure_reported INTEGER NOT NULL DEFAULT 0;
            UPDATE outbox SET failure_reported = 1 WHERE status = 'failed';
        `);
    }
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
        receive: q(`INSERT OR IGNORE INTO inbox (wa_message_id, phone, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`),
        // The oldest due message of each person whose earlier messages are all finished.
        inboxNext: q(`SELECT i.rowid AS seq, i.* FROM inbox i
            WHERE i.status = 'pending' AND i.next_attempt_at <= ?
              AND NOT EXISTS (SELECT 1 FROM inbox e WHERE e.phone = i.phone AND e.rowid < i.rowid AND e.status IN ('pending', 'processing'))
            ORDER BY i.rowid LIMIT 1`),
        inboxById: q(`SELECT rowid AS seq, * FROM inbox WHERE wa_message_id = ?`),
        claimInbox: q(`UPDATE inbox SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE wa_message_id = ? AND status = 'pending'`),
        setRoute: q(`UPDATE inbox SET route_json = ?, updated_at = ? WHERE wa_message_id = ?`),
        inboxDone: q(`UPDATE inbox SET status = 'done', last_error = NULL, updated_at = ? WHERE wa_message_id = ?`),
        inboxRetry: q(`UPDATE inbox SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE wa_message_id = ?`),
        inboxFail: q(`UPDATE inbox SET status = 'failed', last_error = ?, updated_at = ? WHERE wa_message_id = ?`),
        inboxNotified: q(`UPDATE inbox SET notified = 1 WHERE wa_message_id = ? AND notified = 0`),
        recoverInbox: q(`UPDATE inbox SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at < ?`),
        inboxStats: q(`SELECT status, COUNT(*) AS count FROM inbox GROUP BY status`),
        touchWindow: q(`INSERT INTO windows (phone, last_inbound_at) VALUES (?, ?)
            ON CONFLICT(phone) DO UPDATE SET last_inbound_at = excluded.last_inbound_at`),
        window: q(`SELECT last_inbound_at FROM windows WHERE phone = ?`),
        setSession: q(`INSERT INTO sessions (phone, outbox_id, mode, expires_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET outbox_id = excluded.outbox_id, mode = excluded.mode, expires_at = excluded.expires_at`),
        session: q(`SELECT * FROM sessions WHERE phone = ? AND expires_at > ?`),
        clearSession: q(`DELETE FROM sessions WHERE phone = ?`),
        // Failed requests whose failure the project was not told about yet.
        unreported: q(`SELECT * FROM outbox WHERE status = 'failed' AND failure_reported = 0 AND next_attempt_at <= ? ORDER BY id LIMIT ?`),
        markReported: q(`UPDATE outbox SET failure_reported = 1 WHERE id = ?`),
        delayReport: q(`UPDATE outbox SET next_attempt_at = ? WHERE id = ?`),
        decision: q(`SELECT * FROM decisions WHERE outbox_id = ? AND phone = ?`),
        startDecision: q(`INSERT OR IGNORE INTO decisions (outbox_id, phone, action, decided_at, state, wa_message_id) VALUES (?, ?, ?, ?, 'started', ?)`),
        applyDecision: q(`UPDATE decisions SET state = 'applied' WHERE outbox_id = ? AND phone = ?`),
        adoptDecision: q(`UPDATE decisions SET wa_message_id = ? WHERE outbox_id = ? AND phone = ? AND state = 'started'`),
        undecide: q(`DELETE FROM decisions WHERE outbox_id = ? AND phone = ? AND state = 'started' AND wa_message_id = ?`),
        stats: q(`SELECT status, COUNT(*) AS count FROM outbox GROUP BY status`),
    };

    const parseInbox = (row) =>
        row && { ...row, message: JSON.parse(row.payload_json), route: row.route_json ? JSON.parse(row.route_json) : null };

    const parse = (row) =>
        row && {
            ...row,
            message: JSON.parse(row.message_json),
            template: row.template_json ? JSON.parse(row.template_json) : null,
        };

    return {
        /** Runs fn (synchronous) in one transaction: all of its writes are stored, or none. */
        now,
        transaction(fn) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const result = fn();
                db.exec('COMMIT');
                return result;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
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
        /** Stores an inbound WhatsApp message. @returns {boolean} true the first time this id is seen */
        receive: (message, phone) => statements.receive.run(message.id, phone, JSON.stringify(message), now(), now()).changes === 1,
        inboxNext: () => parseInbox(statements.inboxNext.get(now())) ?? null,
        inbox: (waId) => parseInbox(statements.inboxById.get(waId)) ?? null,
        claimInbox: (waId) => statements.claimInbox.run(now(), waId).changes === 1,
        /** Remembers where a message goes (and how far it got), so a retry ends up in the same place. */
        setRoute: (waId, route) => statements.setRoute.run(JSON.stringify(route), now(), waId),
        inboxDone: (waId) => statements.inboxDone.run(now(), waId),
        inboxRetry: (waId, delayMs, error) => statements.inboxRetry.run(now() + delayMs, error, now(), waId),
        inboxFail: (waId, error) => statements.inboxFail.run(error, now(), waId),
        /** @returns {boolean} true the first time: one "I'll try again later" message per inbound message */
        inboxNotified: (waId) => statements.inboxNotified.run(waId).changes === 1,
        recoverInbox: (olderThanMs) => statements.recoverInbox.run(now(), now() - olderThanMs).changes,
        inboxStats: () => Object.fromEntries(statements.inboxStats.all().map((row) => [row.status, row.count])),
        touchWindow: (phone) => statements.touchWindow.run(phone, now()),
        windowOpen(phone, marginMs = 10 * 60 * 1000) {
            const row = statements.window.get(phone);
            return Boolean(row) && now() - row.last_inbound_at < 24 * 60 * 60 * 1000 - marginMs;
        },
        setSession: (phone, outboxId, mode, ttlMs = 30 * 60 * 1000) => statements.setSession.run(phone, outboxId, mode, now() + ttlMs),
        session: (phone) => statements.session.get(phone, now()) ?? null,
        clearSession: (phone) => statements.clearSession.run(phone),
        unreportedFailures: (limit = 50) => statements.unreported.all(now(), limit).map(parse),
        markReported: (id) => statements.markReported.run(id),
        delayReport: (id, delayMs) => statements.delayReport.run(now() + delayMs, id),
        decision: (outboxId, phone) => statements.decision.get(outboxId, phone) ?? null,
        /** Records a decision as started by an inbound message. @returns {boolean} false when the person already has one */
        startDecision: (outboxId, phone, action, waMessageId) =>
            statements.startDecision.run(outboxId, phone, action, now(), waMessageId).changes === 1,
        /** The project confirmed it. */
        applyDecision: (outboxId, phone) => statements.applyDecision.run(outboxId, phone),
        /** Hands a started decision left behind by a message that will never finish to another message. */
        adoptDecision: (outboxId, phone, waMessageId) => statements.adoptDecision.run(waMessageId, outboxId, phone).changes === 1,
        /** Removes a decision that was started by this message and could not be applied. Applied decisions stay. */
        undecide: (outboxId, phone, waMessageId) => statements.undecide.run(outboxId, phone, waMessageId),
        stats: () => Object.fromEntries(statements.stats.all().map((row) => [row.status, row.count])),
    };
}
