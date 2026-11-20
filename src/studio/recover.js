import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Admin tools for generations whose result could not be matched (run inside the studio container):
 *   node src/studio/recover.js <generation_id> <job_id>   # attach a known Higgsfield job id
 *   node src/studio/recover.js --raw <generation_id>      # print the stored raw answer
 * `recover` only changes the database: the row (status 'unknown' or 'late') gets the job id and
 * status 'submitted'; the running studio's background check (every minute) or a get_generation
 * then polls jobs_wait and stores the result the normal way. Nothing is sent to Higgsfield again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attaches `jobId` to an 'unknown' or 'late' row; returns { ok, message }. */
export function recoverGeneration(store, generationId, jobId) {
    const id = String(generationId ?? '').trim();
    const job = String(jobId ?? '').trim();
    if (!id || !job) return { ok: false, message: 'Kullanim: recover <generation_id> <job_id>' };
    if (!UUID.test(job)) return { ok: false, message: `Gecersiz job id: ${job} (Higgsfield job id'leri UUID bicimindedir).` };
    const row = store.get(id);
    if (!row) return { ok: false, message: `Uretim bulunamadi: ${id}` };
    if (!['unknown', 'late'].includes(row.status)) return { ok: false, message: `Uretim ${id} durumu '${row.status}'; yalnizca 'unknown' ya da 'late' olanlar kurtarilabilir.` };
    const other = store.byJobId(job, id);
    if (other) return { ok: false, message: `Bu job id zaten ${other.id} uretimine bagli (durum '${other.status}').` };
    const was = `${row.status}${row.job_id ? ` job ${row.job_id}` : ''}${row.reason ? `: ${row.reason}` : ''}`;
    store.update(id, { status: 'submitted', jobId: job, recoveredAt: store.now(), reason: `recovered by admin (was ${was})`.slice(0, 300) });
    return {
        ok: true,
        message: `Uretim ${id} -> job ${job}, durum 'submitted'. Studio en gec bir dakika icinde sonucu Higgsfield'den alip saklar (ya da get_generation ile hemen). Bu sirada yeni uretim baslamaz.`,
    };
}

/** The stored raw answer of a row; returns { ok, message }. */
export function rawAnswerOf(store, generationId) {
    const id = String(generationId ?? '').trim();
    if (!id) return { ok: false, message: 'Kullanim: raw <generation_id>' };
    const row = store.get(id);
    if (!row) return { ok: false, message: `Uretim bulunamadi: ${id}` };
    const head = `${row.id} | ${row.status} | job ${row.job_id ?? '-'} | ${row.reason ?? ''}`;
    return { ok: true, message: row.raw_answer ? `${head}\n${row.raw_answer}` : `${head}\n(Bu uretim icin saklanmis ham cevap yok.)` };
}

async function main(argv) {
    const { loadConfig } = await import('../config.js');
    const { normalizeStudio } = await import('./config.js');
    const { createStudioStore, openStudioDatabase } = await import('./store.js');
    const config = loadConfig();
    const settings = normalizeStudio(config.studio, config);
    const store = createStudioStore(openStudioDatabase(settings.dataDir));
    const result = argv[0] === '--raw' ? rawAnswerOf(store, argv[1]) : recoverGeneration(store, argv[0], argv[1]);
    (result.ok ? console.log : console.error)(result.message);
    return result.ok ? 0 : 1;
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
    invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
    invoked = '';
}
if (invoked === self) process.exitCode = await main(process.argv.slice(2));
