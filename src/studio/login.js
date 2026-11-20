import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { normalizeStudio } from './config.js';
import { createHiggsfieldClient, parseCompact } from './higgsfield.js';
import { DEFAULT_REDIRECT_URI, authorizeUrl, createHiggsfieldAuth, createTokenFile, discover, exchangeCode, parsePasted, pkcePair, registerClient } from './oauth.js';

/**
 * One-time Higgsfield login for the studio gateway (run inside the studio container):
 *   node src/studio/login.js            # connect (or reconnect)
 *   node src/studio/login.js --status   # connected? (never prints tokens)
 *   node src/studio/login.js --reregister   # register a new OAuth client first
 * Prints an authorize URL; open it, sign in to Higgsfield, allow. The browser then
 * tries http://127.0.0.1:8976/callback?code=... and fails to load: that is expected.
 * Paste that whole address here. Tokens go to <dataDir>/studio/higgsfield-auth.json (0600).
 */
const args = new Set(process.argv.slice(2));
const config = loadConfig();
const settings = normalizeStudio(config.studio, config);
const file = createTokenFile(join(settings.dataDir, 'higgsfield-auth.json'));
const auth = createHiggsfieldAuth({ file });

async function checkBalance() {
    const client = createHiggsfieldClient({ url: settings.mcpUrl, auth });
    try {
        const answer = await client.call('balance', {});
        const { values, tables } = parseCompact(answer.text);
        const credits = values.credits ?? values.balance ?? Object.values(tables)[0]?.[0]?.credits ?? null;
        console.log(credits !== null ? `Higgsfield bağlantısı çalışıyor. Kredi: ${credits}` : 'Higgsfield bağlantısı çalışıyor.');
        return true;
    } catch (error) {
        console.log(`UYARI: Higgsfield'e bağlanılamadı (${error.userMessage ?? error.message}).`);
        return false;
    }
}

if (args.has('--status')) {
    const status = auth.status();
    if (process.env.HIGGSFIELD_API_KEY) console.log('HIGGSFIELD_API_KEY tanımlı; OAuth yerine o kullanılıyor.');
    console.log(status.connected ? `Bağlı. Yenileme anahtarı: ${status.hasRefreshToken ? 'var' : 'yok'}.${status.expiresAt ? ` Erişim süresi: ${new Date(status.expiresAt).toISOString()}` : ''}` : 'Bağlı değil.');
    if (status.connected || process.env.HIGGSFIELD_API_KEY) await checkBalance();
    process.exit(0);
}

const metadata = await discover({ mcpUrl: settings.mcpUrl });
let data = file.read();
if (!data.client?.client_id || args.has('--reregister')) {
    console.log('Higgsfield OAuth istemcisi kaydediliyor...');
    data = { ...data, client: await registerClient({ metadata, redirectUri: DEFAULT_REDIRECT_URI }), metadata };
    file.write(data);
}
const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString('hex');
const url = authorizeUrl({ client: data.client, metadata, challenge, state });

console.log(`
Higgsfield girisi (bir kerelik):
  1. Asagidaki adresi tarayicida ac, Higgsfield hesabinla giris yap ve izin ver.
  2. Tarayici "${data.client.redirect_uri}?code=..." adresine gidip "baglanti kurulamadi"
     diyecek: bu normal.
  3. O sayfanin adres cubugundaki TAM adresi kopyala, buraya yapistir, Enter'a bas.

${url}
`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = parsePasted(await rl.question('Adres: '));
rl.close();
if (pasted.error) {
    console.error(`Higgsfield izni vermedi (${pasted.error}).`);
    process.exit(1);
}
if (!pasted.code) {
    console.error('Adreste "code" bulunamadi.');
    process.exit(1);
}
if (pasted.state && pasted.state !== state) {
    console.error('Adres bu girise ait degil (state farkli). Tekrar calistir.');
    process.exit(1);
}
const tokens = await exchangeCode({ metadata, client: data.client, code: pasted.code, verifier });
file.write({ ...file.read(), metadata, tokens });
console.log(`Giris tamam; anahtarlar ${file.path} dosyasina (0600) kaydedildi.${tokens.refresh_token ? '' : ' UYARI: yenileme anahtari gelmedi; erisim suresi dolunca girisi tekrarlaman gerekecek.'}`);
await checkBalance();
