#!/usr/bin/env node
/**
 * Zonesoft probe — fetches one day of sales without touching the database.
 *
 *   npm run zonesoft:probe            # yesterday
 *   npm run zonesoft:probe 2026-07-20 # a specific date
 *
 * Logs in with ZONESOFT_* credentials from .env.local, requests the "vprod"
 * (Volume de Vendas por Produto) report, downloads the excel export and
 * prints the parsed items. Raw responses land in zonesoft-raw*.json for
 * debugging.
 */
import { readFileSync, writeFileSync } from 'node:fs';

function loadDotEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (match && !(match[1] in process.env)) {
          process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      // file not present — fine
    }
  }
}

loadDotEnv();

const AUTH = process.env.ZONESOFT_AUTH_URL ?? 'https://auth.zonesoft.org';
const APP = process.env.ZONESOFT_APP_URL ?? 'https://client.zonesoft.org';
const { ZONESOFT_NIF: nif, ZONESOFT_USERNAME: username, ZONESOFT_PASSWORD: passwd } = process.env;

if (!nif || !username || !passwd) {
  console.error('Set ZONESOFT_NIF, ZONESOFT_USERNAME and ZONESOFT_PASSWORD in .env.local');
  process.exit(1);
}

const date =
  process.argv[2] ??
  new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
const [y, m, d] = date.split('-');
const ptDate = `${d}-${m}-${y}`;

let cookies = [];

async function zsPost(url, container, session) {
  const meta = { _key: '', filter: {}, pagination: {} };
  if (session) meta[session.key] = session.token;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      // Required — the server returns an empty body without these two.
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Origin: 'https://zsbmsv2.zonesoft.org',
      Referer: 'https://zsbmsv2.zonesoft.org/',
      ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
    },
    body: JSON.stringify({ Container: [container ?? {}], Metadata: meta }),
  });
  cookies = [...cookies, ...res.headers.getSetCookie().map((c) => c.split(';')[0])];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { Container: [text] };
  }
  return { status: res.status, data };
}

console.log(`1. POST ${AUTH}/token`);
const tokenRes = await zsPost(`${AUTH}/token`, {});
console.log(`   → HTTP ${tokenRes.status}`);
const tokenRow = tokenRes.data?.Container?.[0];
if (!tokenRow?.tk_key || !tokenRow?.tk) {
  console.error('   Token request failed. Raw response:', JSON.stringify(tokenRes.data).slice(0, 500));
  process.exit(1);
}
const session = { key: tokenRow.tk_key, token: tokenRow.tk };

console.log(`2. POST ${AUTH}/login (nif=${nif}, username=${username})`);
const loginRes = await zsPost(`${AUTH}/login`, { nif, username, passwd }, session);
console.log(`   → HTTP ${loginRes.status}`);
if (loginRes.status !== 200) {
  console.error('   Login failed. Raw response:', JSON.stringify(loginRes.data).slice(0, 800));
  process.exit(1);
}
const loginRow = loginRes.data?.Container?.[0];
if (loginRow?.tk_key && loginRow?.tk) {
  session.key = loginRow.tk_key;
  session.token = loginRow.tk;
}

console.log(`3. POST ${APP}/Report/getReport/ (rptID=vprod, ${ptDate})`);
const extra = process.env.ZONESOFT_REPORT_DATA
  ? JSON.parse(process.env.ZONESOFT_REPORT_DATA)
  : {};
const reportRes = await zsPost(
  `${APP}/Report/getReport/`,
  {
    Data: {
      dataInicio: ptDate,
      dataFim: ptDate,
      f_lojas: [1],
      f_prodinit: 1,
      f_prodfim: 99999999,
      clienteAllHeader: true,
      f_cliente_ini: '0',
      f_cliente_fim: '99999999',
      f_todos: true,
      f_opcoes: '-',
      f_familias: ['todas'],
      f_familias_descricao: ['todas'],
      f_subfamilias: ['todas'],
      f_subfamilias_descricao: ['todas'],
      f_servico: 0,
      zsrest_stores: true,
      opOrd: 'codigo',
      opOrdAsc: 'ASC',
      APPVERSION: '2026.7.1',
      ...extra,
    },
    Settings: { lang: 'PT', mobile: false },
    rptID: 'vprod',
  },
  session
);
console.log(`   → HTTP ${reportRes.status}`);
writeFileSync('zonesoft-raw.json', JSON.stringify(reportRes.data, null, 2));

const link = reportRes.data?.Container?.[0]?.ReportData?.excel?.link;
if (!link) {
  console.error('   No excel link in response — see zonesoft-raw.json');
  process.exit(1);
}
console.log(`4. GET ${link}`);
const fileRes = await fetch(link);
const html = new TextDecoder('windows-1252').decode(await fileRes.arrayBuffer());
writeFileSync('zonesoft-raw-report.html', html);

// Same row shape the app parser expects: numeric code, name, qty, %, net, total.
const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
let count = 0;
let total = 0;
console.log(`\n   ${'Código'.padEnd(8)} ${'Produto'.padEnd(34)} ${'Qtd'.padStart(9)} ${'Total'.padStart(10)}`);
for (const row of rows) {
  const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
    c[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
  );
  if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
  const qty = Number(cells[2].replace(/\./g, '').replace(',', '.'));
  const gross = Number(cells[cells.length - 1].replace(/[€\s]|&euro;/g, '').replace(/\./g, '').replace(',', '.'));
  count++;
  total += gross;
  if (count <= 15) {
    console.log(
      `   ${cells[0].padEnd(8)} ${cells[1].slice(0, 34).padEnd(34)} ${cells[2].padStart(9)} ${cells[cells.length - 1].padStart(10)}`
    );
  }
}
console.log(`   … ${count} products, gross total ≈ ${total.toFixed(2)}€`);
console.log('\nDone. Raw files: zonesoft-raw.json, zonesoft-raw-report.html');
