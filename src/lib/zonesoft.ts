/**
 * Client for the Zonesoft ZSBMS backoffice (zsbmsv2.zonesoft.org).
 *
 * Protocol (reverse-engineered from the ZSBMS app + a captured payload,
 * July 2026):
 *  1. POST {AUTH}/token  → Container[0] = { tk_key, tk }  (anonymous session pair)
 *  2. POST {AUTH}/login  with Container[0] = { nif, username, passwd }
 *     Every request wraps its payload as:
 *       { Container: [payload], Metadata: { _key: '', filter: {}, pagination: {}, [tk_key]: tk } }
 *     The PHPSESSID cookie from the token response must be sent on subsequent
 *     requests, and the server returns an EMPTY body unless the request
 *     carries X-Requested-With: XMLHttpRequest and a browser User-Agent.
 *  3. POST {APP}/Report/getReport/ with rptID "vprod" (Volume de Vendas por
 *     Produto) and dates as DD-MM-YYYY. The response contains ReportData with
 *     download links; the "excel" link is an HTML table (windows-1252) hosted
 *     on static.zonesoft.org, which we download and parse.
 *
 * If anything drifts, run `npm run zonesoft:probe -- <date>` locally to
 * capture raw responses and adjust here.
 */

const AUTH_URL = () => process.env.ZONESOFT_AUTH_URL ?? 'https://auth.zonesoft.org';
const APP_URL = () => process.env.ZONESOFT_APP_URL ?? 'https://client.zonesoft.org';

export interface ZsSession {
  key: string;
  token: string;
  cookies: string[];
}

interface ZsResponse {
  status: number;
  data: { Container?: unknown[]; Metadata?: Record<string, unknown> } | null;
  setCookies: string[];
}

const BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  // Required — the auth server returns an empty body without these two.
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Origin: 'https://zsbmsv2.zonesoft.org',
  Referer: 'https://zsbmsv2.zonesoft.org/',
};

function metadata(session?: ZsSession): Record<string, unknown> {
  const meta: Record<string, unknown> = { _key: '', filter: {}, pagination: {} };
  if (session) meta[session.key] = session.token;
  return meta;
}

async function zsPost(url: string, container: unknown, session?: ZsSession): Promise<ZsResponse> {
  const body = {
    Container: Array.isArray(container) ? container : [container ?? {}],
    Metadata: metadata(session),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...BROWSER_HEADERS,
      ...(session && session.cookies.length ? { Cookie: session.cookies.join('; ') } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookies = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter(Boolean);
  let data: ZsResponse['data'] = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { Container: [text] };
  }
  return { status: res.status, data, setCookies };
}

export async function zonesoftLogin(): Promise<ZsSession> {
  const nif = process.env.ZONESOFT_NIF;
  const username = process.env.ZONESOFT_USERNAME;
  const passwd = process.env.ZONESOFT_PASSWORD;
  if (!nif || !username || !passwd) {
    throw new Error('ZONESOFT_NIF, ZONESOFT_USERNAME and ZONESOFT_PASSWORD must be set');
  }

  const tokenRes = await zsPost(`${AUTH_URL()}/token`, {});
  const tokenRow = tokenRes.data?.Container?.[0] as { tk_key?: string; tk?: string } | undefined;
  if (tokenRes.status !== 200 || !tokenRow?.tk_key || !tokenRow?.tk) {
    throw new Error(`Zonesoft token request failed (HTTP ${tokenRes.status})`);
  }
  const session: ZsSession = { key: tokenRow.tk_key, token: tokenRow.tk, cookies: tokenRes.setCookies };

  const loginRes = await zsPost(`${AUTH_URL()}/login`, { nif, username, passwd }, session);
  if (loginRes.status !== 200) {
    throw new Error(
      `Zonesoft login failed (HTTP ${loginRes.status}) — check ZONESOFT_NIF/USERNAME/PASSWORD`
    );
  }
  session.cookies = [...session.cookies, ...loginRes.setCookies];

  // Login may rotate the session pair; keep whatever the server returned last.
  const loginRow = loginRes.data?.Container?.[0] as { tk_key?: string; tk?: string } | undefined;
  if (loginRow?.tk_key && loginRow?.tk) {
    session.key = loginRow.tk_key;
    session.token = loginRow.tk;
  }
  return session;
}

export interface ZsSaleItem {
  code: string;
  name: string;
  qty: number;
  gross: number; // "Total" column, VAT included
  net: number; // "Total Sem IVA"
}

export interface ZsDailySales {
  date: string;
  items: ZsSaleItem[];
  grossTotal: number;
  raw: unknown; // report HTML + link, persisted for reprocessing
}

/** ISO YYYY-MM-DD → DD-MM-YYYY (the format the vprod report expects). */
function toPtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * Payload captured from the backoffice "Volume de Vendas por Produto" screen.
 * The product/client ranges are wide enough to include everything; store 1 is
 * the bar. Override or extend any field via ZONESOFT_REPORT_DATA (JSON).
 */
function reportData(fromIso: string, toIso: string): Record<string, unknown> {
  const extra = process.env.ZONESOFT_REPORT_DATA;
  return {
    dataInicio: toPtDate(fromIso),
    dataFim: toPtDate(toIso),
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
    ...(extra ? (JSON.parse(extra) as Record<string, unknown>) : {}),
  };
}

interface ReportLinks {
  excel?: { link?: string };
  portrait?: { link?: string };
}

async function fetchReportExcel(session: ZsSession, fromIso: string, toIso: string): Promise<{ html: string; link: string }> {
  const res = await zsPost(
    `${APP_URL()}/Report/getReport/`,
    {
      Data: reportData(fromIso, toIso),
      Settings: { lang: 'PT', mobile: false },
      rptID: 'vprod',
    },
    session
  );
  if (res.status !== 200) {
    throw new Error(`Zonesoft report "vprod" failed (HTTP ${res.status})`);
  }
  const container = res.data?.Container?.[0] as { ReportData?: ReportLinks } | undefined;
  const link = container?.ReportData?.excel?.link;
  if (!link) {
    throw new Error(
      `Zonesoft report response had no excel link: ${JSON.stringify(res.data).slice(0, 300)}`
    );
  }
  const fileRes = await fetch(link);
  if (!fileRes.ok) throw new Error(`Zonesoft report download failed (HTTP ${fileRes.status})`);
  // The export is HTML in windows-1252, not a real XLS.
  const html = new TextDecoder('windows-1252').decode(await fileRes.arrayBuffer());
  return { html, link };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => {
      if (ENTITIES[name]) return ENTITIES[name];
      // Latin accents: &iacute; &ccedil; &atilde; &eacute; …
      const accents: Record<string, string> = {
        aacute: 'á', agrave: 'à', atilde: 'ã', acirc: 'â', eacute: 'é', ecirc: 'ê',
        iacute: 'í', oacute: 'ó', otilde: 'õ', ocirc: 'ô', uacute: 'ú', ccedil: 'ç',
        Aacute: 'Á', Atilde: 'Ã', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
        Ccedil: 'Ç', deg: '°', ordm: 'º', ordf: 'ª',
      };
      return accents[name] ?? m;
    });
}

/** Portuguese number: "1.234,567" → 1234.567, "444,000" → 444.0 */
function parseNumber(cell: string): number {
  const cleaned = cell.replace(/[€%\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parses the vprod excel export. Data rows look like:
 *   [código, descrição, QTD, % de venda, total sem IVA, total]
 * and are identified by a purely numeric first cell.
 */
export function parseSaleItems(html: string): ZsSaleItem[] {
  const items: ZsSaleItem[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html))) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(decodeEntities(cellMatch[1].replace(/<[^>]*>/g, '')).trim());
    }
    if (cells.length < 4) continue;
    if (!/^\d+$/.test(cells[0])) continue; // header / filter / total rows

    const qty = parseNumber(cells[2]);
    const gross = parseNumber(cells[cells.length - 1]);
    const net = cells.length >= 5 ? parseNumber(cells[cells.length - 2]) : NaN;
    if (!Number.isFinite(qty)) continue;
    items.push({
      code: cells[0],
      name: cells[1],
      qty,
      gross: Number.isFinite(gross) ? gross : 0,
      net: Number.isFinite(net) ? net : 0,
    });
  }
  return items;
}

/** Fetch one day of sales reusing an existing session (for range syncs). */
export async function fetchDailySalesWithSession(
  session: ZsSession,
  date: string
): Promise<ZsDailySales> {
  const { html, link } = await fetchReportExcel(session, date, date);
  const items = parseSaleItems(html);
  const grossTotal = items.reduce((sum, i) => sum + i.gross, 0);
  return { date, items, grossTotal, raw: { link, html } };
}

export async function fetchDailySales(date: string): Promise<ZsDailySales> {
  const session = await zonesoftLogin();
  return fetchDailySalesWithSession(session, date);
}

export interface ZsCatalogProduct {
  code: string;
  name: string;
  familiaCode: number | null;
  familiaName: string | null;
}

/**
 * Product catalog with family (categoria) mapping, from the same entity
 * endpoints the backoffice product screens use. Familia 0 means "none"
 * (internal ingredients) and is stored as null.
 */
export async function fetchCatalog(session: ZsSession): Promise<ZsCatalogProduct[]> {
  const famRes = await zsPost(`${APP_URL()}/familias/getInstances/`, {}, session);
  if (famRes.status !== 200) {
    throw new Error(`Zonesoft familias request failed (HTTP ${famRes.status})`);
  }
  const familias = new Map<number, string>();
  for (const row of (famRes.data?.Container ?? []) as Array<Record<string, unknown>>) {
    if (typeof row?.codigo === 'number' && typeof row?.descricao === 'string') {
      familias.set(row.codigo, row.descricao);
    }
  }

  const prodRes = await zsPost(`${APP_URL()}/produtos/getInstances/`, {}, session);
  if (prodRes.status !== 200) {
    throw new Error(`Zonesoft produtos request failed (HTTP ${prodRes.status})`);
  }
  const products: ZsCatalogProduct[] = [];
  for (const row of (prodRes.data?.Container ?? []) as Array<Record<string, unknown>>) {
    const p = row?.Produto as Record<string, unknown> | undefined;
    if (!p || p.codigo == null || typeof p.descricao !== 'string') continue;
    const familia = typeof p.familia === 'number' && p.familia > 0 ? p.familia : null;
    products.push({
      code: String(p.codigo),
      name: p.descricao.trim(),
      familiaCode: familia,
      familiaName: familia !== null ? (familias.get(familia) ?? null) : null,
    });
  }
  return products;
}
