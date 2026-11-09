import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, startApp, openBrowser, newPage } from './ui-helpers.js';

// Real Chrome against the real page, routes and engine. Only the model, PayPal and the two CDN scripts
// are stand-ins (see ui-helpers.js). The buyer is played by calling the callbacks the app gave PayPal.
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* dev dependency not installed */ }
const skip = !puppeteer || !findChrome() ? 'needs puppeteer-core and a local Chrome (set CHROME_PATH)' : false;

let chrome;
before(async () => { if (!skip) chrome = await openBrowser(puppeteer); });
after(async () => { await chrome?.close(); });

const PROMPT = 'Three friends - Ana, Ben and Cy - 4 days in Lisbon in May. Budget $1,200 total. A flat, a boat tour, Sintra.';

async function withApp(opts, fn) {
  const app = await startApp(opts);
  const page = await newPage(chrome.browser);
  try {
    await page.goto(app.url);
    await fn(page, app);
  } finally {
    await page.close();
    await app.close();
  }
}

const plan = async (page) => {
  await page.type('#prompt', PROMPT);
  await page.click('[data-act="plan"]');
};
const buttonReady = (page, timeout = 5000) => page.waitForSelector('#pp #stub-paypal', { timeout });
const payAsBuyer = (page) => page.evaluate(async () => {
  const orderId = await window.__pp.createOrder({ paymentSource: 'paypal' });
  await window.__pp.onApprove({ orderID: orderId });
});
const text = (page, sel) => page.$eval(sel, (el) => el.innerText);

test('after the plan is drawn the PayPal button is on the page within 5 seconds and nothing is left busy', { skip }, async () => {
  await withApp({}, async (page) => {
    const t0 = Date.now();
    await plan(page);
    await buttonReady(page, 5000);
    assert.ok(Date.now() - t0 < 5000);
    const state = await page.evaluate(() => ({ spinning: Boolean(document.querySelector('.spin')), sendDisabled: document.querySelector('[data-act="change"]').disabled }));
    assert.deepEqual(state, { spinning: false, sendDisabled: false });
  });
});

test('after Send and after Close trip the Confirm button is usable again, not stuck grey with a spinner', { skip }, async () => {
  await withApp({}, async (page) => {
    await plan(page);
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');

    await page.click('[data-act="sample-change"][data-i="0"]');
    await page.click('[data-act="change"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 5000 });
    assert.equal(await page.$('.spin'), null);
    await page.click('button[data-act="confirm"]');
    await page.waitForFunction(() => !document.querySelector('.proposal'), { timeout: 5000 });

    await page.click('[data-act="close"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 5000 });
    assert.match(await text(page, 'button[data-act="confirm"]'), /close trip/i);
  });
});

test('the "approval was cancelled" notice goes away as soon as the buyer tries again or succeeds', { skip }, async () => {
  await withApp({}, async (page) => {
    await plan(page);
    await buttonReady(page);
    await page.evaluate(() => window.__pp.onCancel());
    assert.match(await text(page, '#pp-notice'), /cancelled/i);

    await buttonReady(page);
    await page.evaluate(() => window.__pp.createOrder({ paymentSource: 'paypal' }));
    assert.equal(await page.evaluate(() => /cancelled/i.test(document.body.innerText)), false, 'trying again clears it');

    await page.evaluate(() => window.__pp.onCancel());
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');
    assert.equal(await page.evaluate(() => /cancelled/i.test(document.body.innerText)), false, 'a successful approval clears it');
    assert.match(await page.$eval('.stat b', (el) => el.innerText), /\$/);
  });
});

test('an expired proposal swaps the button for a refresh; a late approval is refused next to the button and refreshing gets a working button back', { skip }, async () => {
  await withApp({ ttlMs: 3500 }, async (page, app) => {
    await plan(page);
    await buttonReady(page);
    const orderId = await page.evaluate(() => window.__pp.createOrder({ paymentSource: 'paypal' }));

    await page.waitForSelector('[data-act="refresh"]', { timeout: 8000 });
    assert.equal(await page.$('#pp'), null, 'no PayPal button once the proposal timed out');
    assert.match(await text(page, '.proposal'), /timed out/i);

    // The buyer was still sitting in the PayPal window: the late approval must not place a hold.
    await page.evaluate((id) => window.__pp.onApprove({ orderID: id }), orderId);
    await page.waitForSelector('.proposal .err');
    assert.match(await text(page, '.proposal .err'), /expired/i);
    assert.equal(app.fake.calls.some((c) => /POST .*\/authorize$/.test(c)), false, 'PayPal was never asked to authorize');

    await page.click('[data-act="refresh"]');
    await buttonReady(page, 3000);
    assert.equal(await page.$('.proposal .err'), null);
    assert.doesNotMatch(await text(page, '.proposal'), /timed out/i);
  });
});

test('closing ends the trip: a closed notice shows and there is no way to change or close it again', { skip }, async () => {
  await withApp({}, async (page) => {
    await plan(page);
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');
    await page.click('[data-act="close"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 5000 });
    await page.click('button[data-act="confirm"]');
    await page.waitForSelector('.notice.closed', { timeout: 5000 });
    assert.equal(await page.$('#change'), null);
    assert.equal(await page.$('[data-act="close"]'), null);
    assert.equal(await page.$('[data-act="sample-change"]'), null);
    assert.match(await text(page, '.notice.closed'), /closed/i);
  });
});

test('PayPal activity and item quotas are separate lists, and every column set fits the card', { skip }, async () => {
  await withApp({}, async (page) => {
    await plan(page);
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');

    const grid = async (tab) => {
      await page.click(`[data-tab="${tab}"]`);
      return page.$eval('#grid', (el) => ({ cols: el.dataset.cols, rows: Number(el.dataset.rows), minWidth: Number(el.dataset.minWidth) }));
    };
    const budget = await grid('budget');
    const paypal = await grid('paypal');
    const quota = await grid('quota');

    assert.equal(paypal.rows, 2, 'one authorization and the prepaid lodging charge');
    assert.equal(quota.rows, 3, 'one quota per item');
    assert.match(await text(page, '[data-tab="paypal"]'), /PayPal activity \(2\)/);
    assert.match(await text(page, '[data-tab="quota"]'), /Item quotas \(3\)/);
    assert.doesNotMatch(paypal.cols, /Quota/);
    assert.match(budget.cols, /Held\|Paid\|Refunded/);
    for (const g of [budget, paypal, quota]) assert.ok(g.minWidth <= 640, `columns need ${g.minWidth}px but the card has about 640px at 1440 wide`);
  });
});
