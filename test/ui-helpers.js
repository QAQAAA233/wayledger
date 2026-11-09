import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleRequest } from '../src/api.js';
import { createPayPal } from '../src/paypal.js';
import { fakeEnv, fakePayPalFetch, SAMPLE_PLAN } from './helpers.js';

const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Where a real Chrome / Edge usually lives. CHROME_PATH wins.
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

// The whole app on a local port: the real static files, the real routes, engine and ledger, with the model
// and PayPal replaced at the edge (the PayPal fake answers in the shape of recorded sandbox responses).
export async function startApp({ ttlMs = 60_000, change = null, vars = {} } = {}) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const ai = {
    planTrip: async (_p, validate) => validate(SAMPLE_PLAN),
    changeTrip: async (_plan, _t, validate) => validate(change ?? { summary: 'Done.', operations: [{ op: 'reprice', itemId: 'i2', amount: 150 }] }),
  };
  const { env } = fakeEnv({ ai, paypal, ttlMs, vars });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const r = await handleRequest(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const body = await readFile(new URL(file, PUBLIC));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, fake, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Third-party scripts are replaced by tiny stand-ins so the browser test needs no network. The PayPal one
// exposes the options the app passed to Buttons(), so a test can act as the buyer.
const PAYPAL_SDK = `window.paypal = { Buttons(opts) { window.__pp = opts; return { render(sel) { document.querySelector(sel).innerHTML = '<button type="button" id="stub-paypal">PayPal</button>'; } }; } };`;
const AG_GRID = `window.agGrid = { createGrid(el, opts) { el.dataset.cols = opts.columnDefs.map((c) => c.headerName ?? c.field).join('|'); el.dataset.rows = String(opts.rowData.length); el.dataset.minWidth = String(opts.columnDefs.reduce((s, c) => s + (c.minWidth ?? c.width ?? 0), 0)); return { destroy() {} }; } };`;

export async function openBrowser(puppeteer) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'wayledger-chrome-'));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, userDataDir, args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'] });
  return { browser, close: async () => { await browser.close(); rmSync(userDataDir, { recursive: true, force: true }); } };
}

export async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('paypal.com/sdk/js')) return req.respond({ status: 200, contentType: 'text/javascript', body: PAYPAL_SDK });
    if (u.includes('ag-grid-community') && u.endsWith('.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: AG_GRID });
    if (u.includes('ag-grid-community') && u.endsWith('.css')) return req.respond({ status: 200, contentType: 'text/css', body: '' });
    return req.continue();
  });
  return page;
}
