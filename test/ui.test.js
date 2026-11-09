import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, startApp, openBrowser, newPage } from './ui-helpers.js';
import { scriptedModel } from './helpers.js';
import { stormSteps, dropSteps } from './storm.js';

// Real Chrome against the real page, routes, engine, agent loop and alarm. Only the model, the forecast and place
// services, PayPal's HTTP and the two CDN scripts are stand-ins (see ui-helpers.js). The buyer is played by calling the
// callbacks the app gave PayPal.
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* dev dependency not installed */ }
const skip = !puppeteer || !findChrome() ? 'needs puppeteer-core and a local Chrome (set CHROME_PATH)' : false;

let chrome;
before(async () => { if (!skip) chrome = await openBrowser(puppeteer); });
after(async () => { await chrome?.close(); });

const PROMPT = 'Three friends - Ana, Ben and Cy - 4 days in Lisbon in May. Budget $1,200 total. A flat, a boat tour, Sintra.';

async function withApp(opts, fn, view) {
  const app = await startApp(opts);
  const page = await newPage(chrome.browser, view);
  try {
    await page.goto(app.url);
    await page.waitForSelector('#prompt'); // the page draws itself after it has asked the server for its settings
    await fn(page, app);
  } finally {
    await page.close();
    await app.close();
  }
}

const plan = async (page, prompt = PROMPT) => {
  await page.type('#prompt', prompt);
  await page.click('[data-act="plan"]');
};
const buttonReady = (page, timeout = 5000) => page.waitForSelector('#pp #stub-paypal', { timeout });
const payAsBuyer = (page) => page.evaluate(async () => {
  const orderId = await window.__pp.createOrder({ paymentSource: 'paypal' });
  await window.__pp.onApprove({ orderID: orderId });
});
const text = (page, sel) => page.$eval(sel, (el) => el.innerText);
const setField = (page, sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
const booked = async (page) => { await plan(page); await buttonReady(page); await payAsBuyer(page); await page.waitForSelector('[data-act="close"]'); };
// the words of the product's own internals must never reach a traveler
const JARGON = /free quota|use reserve|confirmed cap|released or returned|\bnet:|\bquota\b|\breserve\b|undefined|\[object|\bnull\b/i;
const noJargon = async (page, where) => assert.doesNotMatch(await page.evaluate(() => document.body.innerText), JARGON, where);

// Pastes the sample terms the page writes from this trip's own dates and teaches the scripted model to quote them.
async function pasteTermsAndTeachModel(page, holder) {
  await page.click('details.terms summary');
  await page.click('[data-act="terms-sample"]');
  const line = (await page.$eval('#terms', (el) => el.value)).split('\n')[0];
  const [, date, hour] = /until (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(line);
  holder.run = scriptedModel(stormSteps({ quote: line.replace(/, after that.*$/, ''), until: `${date}T${hour}` }));
  await page.click('[data-act="terms-save"]');
  await page.waitForSelector('.doc');
  return line;
}

test('after the plan is drawn the PayPal button is on the page within 5 seconds, the limits are offered in plain words, and nothing is left busy', { skip }, async () => {
  await withApp({}, async (page) => {
    const t0 = Date.now();
    await plan(page);
    await buttonReady(page, 5000);
    assert.ok(Date.now() - t0 < 5000);
    const state = await page.evaluate(() => ({ spinning: Boolean(document.querySelector('.spin')), sendDisabled: document.querySelector('[data-act="change"]').disabled, owner: Object.keys(localStorage).some((k) => k.startsWith('wayledger:owner:')) }));
    assert.deepEqual(state, { spinning: false, sendDisabled: false, owner: true });
    assert.match(await text(page, '.budget'), /\$1,200\.00.*from your own words/);
    const limits = await page.$$eval('#mandate-form input[type=number]', (els) => els.map((e) => e.value));
    assert.deepEqual(limits, ['210', '210'], 'a quarter of the plan, offered and editable');
    assert.match(await text(page, '.proposal'), /Most that can move in PayPal/);
    assert.match(await text(page, '#mandate-form'), /buffer for changes/i);
    await noJargon(page, 'the booking card');
  });
});

test('Flow A: the agent wakes, reads the terms, quotes the sentence, finds a real museum, swaps inside the limits, moves the money itself and PayPal matches', { skip }, async () => {
  const holder = {};
  await withApp({ model: (id, input) => holder.run(id, input) }, async (page, app) => {
    await booked(page);
    assert.match(await text(page, '.authority'), /Acting within your limits.*Refunds: \$210\.00 left of \$210\.00/);
    const line = await pasteTermsAndTeachModel(page, holder);
    const quote = line.replace(/, after that.*$/, '');
    const refundsBefore = app.fake.refs.size;

    await page.click('[data-act="demo"]');
    await page.waitForSelector('#trail .ev.paypal_check.good', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('.runhead .spin') && /Electricity Museum/.test(document.getElementById('itinerary-card').innerText), { timeout: 10000 });

    const trail = await text(page, '#trail');
    assert.match(trail, /Woke up \(demo button\)/);
    assert.match(trail, /SIMULATED/, 'the storm is labelled as made up');
    assert.ok(trail.includes(`“${quote}”`), 'the sentence it relied on is on the screen, in quotation marks');
    assert.match(trail, /Searched for museum places/);
    assert.match(trail, /Electricity Museum, National Archaeology Museum/);
    assert.match(trail, /Tried option A/);
    assert.match(trail, /Chose an option/);
    assert.match(trail, /Inside your limits, so it went ahead/);
    assert.match(trail, /\d+ of \d+ PayPal records match/);
    assert.doesNotMatch(trail, JARGON);

    const itinerary = await text(page, '#itinerary-card');
    assert.doesNotMatch(itinerary, /Sunset boat tour/);
    assert.match(itinerary, /Electricity Museum[\s\S]*real place/);
    assert.match(itinerary, /Budget set aside at the price of what it replaces/, 'a price that was not looked up says so');
    assert.equal(app.fake.refs.size, refundsBefore + 1, 'one real PayPal refund');
    assert.match(await text(page, '.authority'), /Refunds: \$30\.00 left of \$210\.00/);
    assert.match(trail, /Agent's note to you: I swapped the boat tour for a museum visit because of the storm./, 'its own words are shown, labelled as its words');

    await page.click('[data-act="verify"]');
    await page.waitForSelector('.verify .ok', { timeout: 5000 });
    assert.match(await text(page, '.verify .ok'), /Ledger matches PayPal/);
    await noJargon(page, 'after the agent acted');
  });
});

test('Flow B: the same request outside the limits stops, moves nothing and shows why; the person confirms and only then does the money move', { skip }, async () => {
  const holder = {};
  await withApp({ model: (id, input) => holder.run(id, input) }, async (page, app) => {
    await plan(page);
    await buttonReady(page);
    await setField(page, 'input[name="refund"]', '100');
    await page.click('[data-act="mandate-save"]');
    await page.waitForFunction(() => document.querySelector('input[name="refund"]')?.value === '100' && document.getElementById('mandate-dirty')?.hidden !== false);
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');
    await pasteTermsAndTeachModel(page, holder);

    await page.click('[data-act="demo"]');
    await page.waitForFunction(() => /Waiting for your OK/.test(document.getElementById('trail')?.innerText ?? '') && document.querySelector('.proposal'), { timeout: 10000 });
    assert.equal(app.fake.refs.size, 0, 'nothing moved');
    const card = await text(page, '.proposal');
    assert.match(card, /A change is waiting for your OK/);
    assert.match(card, /Why the agent did not just do it/);
    assert.match(card, /only \$100\.00 of your \$100\.00 refund limit is left/);
    assert.match(card, /refund \$180\.00/i);
    assert.doesNotMatch(await text(page, '#trail'), /Checked PayPal against the ledger/);
    await noJargon(page, 'the waiting proposal');

    await page.click('button[data-act="confirm"]');
    await page.waitForFunction(() => !document.querySelector('.proposal'), { timeout: 10000 });
    assert.equal(app.fake.refs.size, 1, 'the person said yes, so it moved');
    assert.match(await text(page, '.authority'), /Refunds: \$100\.00 left of \$100\.00/, 'a person\'s yes does not use up the agent\'s limit');
  });
});

test('limits that were typed but not applied cannot be signed by accident, and nothing is sent to PayPal', { skip }, async () => {
  await withApp({}, async (page, app) => {
    await plan(page);
    await buttonReady(page);
    await setField(page, 'input[name="raise"]', '50');
    assert.equal(await page.$eval('#mandate-dirty', (el) => el.hidden), false);
    const outcome = await page.evaluate(async () => { try { await window.__pp.createOrder({ paymentSource: 'paypal' }); return 'created'; } catch { return 'refused'; } });
    assert.equal(outcome, 'refused');
    await page.waitForSelector('.proposal .err');
    assert.match(await text(page, '.proposal .err'), /Update limits/);
    assert.equal(await page.$eval('input[name="raise"]', (el) => el.value), '50', 'what was typed is still there');
    assert.equal(app.fake.calls.some((c) => /POST \/v2\/checkout\/orders$/.test(c)), false);

    await page.click('[data-act="mandate-save"]');
    await buttonReady(page);
    await payAsBuyer(page);
    await page.waitForSelector('[data-act="close"]');
    assert.match(await text(page, '.authority'), /Plan raise: up to \$50\.00/);
  });
});

test('a budget the person did not give must be confirmed before a button that holds money appears', { skip }, async () => {
  const noBudget = { title: 'Lisbon', destination: 'Lisbon', budget: 5000, budgetQuote: 'a lot', travelers: ['Ana', 'Ben'], items: [{ day: 1, title: 'Flat', category: 'lodging', amount: 300, participants: ['Ana', 'Ben'] }] };
  await withApp({ plan: noBudget }, async (page, app) => {
    await plan(page, 'Two of us in Lisbon for a weekend, a flat to stay in.');
    await page.waitForSelector('.budget.warn');
    assert.match(await text(page, '.budget'), /Confirm your budget first/);
    assert.equal(await page.$('#pp #stub-paypal'), null, 'no PayPal button yet');
    await setField(page, '#budget', '100');
    await page.click('[data-act="budget-save"]');
    await page.waitForSelector('.budget .err');
    assert.match(await text(page, '.budget'), /over that budget/i, 'a budget below the plan is refused');
    await setField(page, '#budget', '800');
    await page.click('[data-act="budget-save"]');
    await buttonReady(page);
    assert.match(await text(page, '.budget'), /\$800\.00.*confirmed by you/);
    assert.equal(app.fake.calls.some((c) => /checkout\/orders$/.test(c)), false, 'still no PayPal order before the person presses the button');
  });
});

test('a message the agent turns into a change outside the limits leaves a usable Confirm button, also after Close trip', { skip }, async () => {
  await withApp({ model: dropSteps() }, async (page) => {
    await booked(page);
    await page.type('#change', 'We found a free place to stay, so drop the apartment.');
    await page.click('[data-act="change"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 10000 });
    assert.equal(await page.$('.spin'), null);
    assert.match(await text(page, '.proposal'), /waiting for your OK/i);
    await page.click('button[data-act="confirm"]');
    await page.waitForFunction(() => !document.querySelector('.proposal'), { timeout: 5000 });

    await page.click('[data-act="close"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 5000 });
    assert.match(await text(page, 'button[data-act="confirm"]'), /close the trip/i);
    await noJargon(page, 'the closing proposal');
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

test('when PayPal cannot use the payment method the person is told in plain words and the window offers another one', { skip }, async () => {
  await withApp({ failOn: /POST \/v2\/checkout\/orders\/\w+\/authorize/ }, async (page, app) => {
    await plan(page);
    await buttonReady(page);
    const orderId = await page.evaluate(() => window.__pp.createOrder({ paymentSource: 'paypal' }));
    await page.evaluate((id) => { window.__restarted = false; return window.__pp.onApprove({ orderID: id }, { restart: () => { window.__restarted = true; } }); }, orderId);
    await page.waitForSelector('.proposal .err');
    assert.match(await text(page, '.proposal .err'), /PayPal could not use that payment method\. Choose another one/);
    assert.doesNotMatch(await text(page, '.proposal .err'), /INSTRUMENT_DECLINED|UNPROCESSABLE/);
    assert.equal(await page.evaluate(() => window.__restarted), true);
    assert.equal(app.fake.auths.size, 0, 'nothing is held');
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

test('closing ends the trip: a closed notice shows and there is no way to change, close or wake it again', { skip }, async () => {
  await withApp({}, async (page) => {
    await booked(page);
    await page.click('[data-act="close"]');
    await page.waitForSelector('button[data-act="confirm"]:not([disabled])', { timeout: 5000 });
    await page.click('button[data-act="confirm"]');
    await page.waitForSelector('.notice.closed', { timeout: 5000 });
    assert.equal(await page.$('#change'), null);
    assert.equal(await page.$('[data-act="close"]'), null);
    assert.equal(await page.$('[data-act="sample-change"]'), null);
    assert.equal(await page.$('[data-act="demo"]'), null);
    assert.match(await text(page, '.notice.closed'), /closed/i);
  });
});

test('PayPal activity and money set aside are separate lists, and every column set fits the card', { skip }, async () => {
  await withApp({}, async (page) => {
    await booked(page);
    const ledger = await page.evaluate(async () => {
      const id = location.hash.split('/').pop();
      const r = await fetch(`/api/trips/${id}`, { headers: { 'x-owner-token': localStorage.getItem(`wayledger:owner:${id}`) } });
      return (await r.json()).ledger.map((f) => f.op);
    });
    const paypalOps = ledger.filter((o) => ['authorize', 'capture', 'void', 'refund'].includes(o)).length;
    const setAside = ledger.length - paypalOps;

    const grid = async (tab) => {
      await page.click(`[data-tab="${tab}"]`);
      return page.$eval('#grid', (el) => ({ cols: el.dataset.cols, rows: Number(el.dataset.rows), minWidth: Number(el.dataset.minWidth) }));
    };
    const budget = await grid('budget');
    const paypal = await grid('paypal');
    const aside = await grid('quota');

    assert.equal(paypal.rows, paypalOps);
    assert.equal(aside.rows, setAside);
    assert.ok(paypalOps >= 2 && setAside >= 1);
    assert.match(await text(page, '[data-tab="paypal"]'), new RegExp(`PayPal activity \\(${paypalOps}\\)`));
    assert.match(await text(page, '[data-tab="quota"]'), new RegExp(`Money set aside \\(${setAside}\\)`));
    assert.match(budget.cols, /Held\|Paid\|Refunded/);
    for (const g of [budget, paypal, aside]) assert.ok(g.minWidth <= 640, `columns need ${g.minWidth}px but the card has about 640px at 1440 wide`);
  });
});

test('a shared link is read-only: anyone can look, including at the agent\'s work, but not confirm, pay, close or send', { skip }, async () => {
  const holder = {};
  await withApp({ model: (id, input) => holder.run(id, input) }, async (page) => {
    await booked(page);
    await pasteTermsAndTeachModel(page, holder);
    await page.click('[data-act="demo"]');
    await page.waitForSelector('#trail .ev.paypal_check.good', { timeout: 10000 });

    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('wayledger:owner:')) localStorage.removeItem(k); });
    await page.reload();
    await page.waitForSelector('.viewonly');
    for (const sel of ['#pp', '#change', '[data-act="close"]', '[data-act="demo"]', '[data-act="confirm"]', '[data-act="terms-save"]', '[data-act="mandate-save"]']) assert.equal(await page.$(sel), null, sel);
    assert.match(await text(page, '#trail'), /Inside your limits, so it went ahead/, 'the work trail is visible to anyone with the link');
    assert.match(await text(page, '.viewonly'), /only the person who planned this trip/i);
  });
});

test('on a phone the agent comes before the itinerary, tables become lists and nothing scrolls sideways', { skip }, async () => {
  await withApp({}, async (page) => {
    await plan(page);
    await page.waitForSelector('#agent-card');
    const layout = await page.evaluate(() => {
      const agent = document.getElementById('agent-card');
      const itinerary = document.getElementById('itinerary-card');
      const input = document.getElementById('change');
      return {
        agentFirst: Boolean(agent.compareDocumentPosition(itinerary) & Node.DOCUMENT_POSITION_FOLLOWING),
        inputTop: Math.round(input.getBoundingClientRect().top + window.scrollY),
        sideways: document.documentElement.scrollWidth > window.innerWidth,
        grid: Boolean(document.getElementById('grid')),
        list: Boolean(document.querySelector('.sumlist')),
      };
    });
    assert.equal(layout.agentFirst, true);
    assert.ok(layout.inputTop < 700, `the box to talk to the agent starts ${layout.inputTop}px down the page`);
    assert.equal(layout.sideways, false);
    assert.deepEqual([layout.grid, layout.list], [false, true]);
  }, { width: 390, height: 844 });
});

test('a demo-limit message is shown without a "Try again" button, and a server hiccup keeps it', { skip }, async () => {
  await withApp({ vars: { AI_PER_IP_HOUR: '1' } }, async (page) => {
    await plan(page);
    await buttonReady(page);
    await page.click('[data-act="new"]');
    await page.type('#prompt', PROMPT);
    await page.click('[data-act="plan"]');
    await page.waitForSelector('.err', { timeout: 5000 });
    assert.match(await text(page, '.err'), /allowance|limit/i);
    assert.equal(await page.$('[data-act="retry-error"]'), null, 'retrying right away cannot help, so there is no button for it');
    assert.equal(await page.$eval('[data-act="plan"]', (el) => el.disabled), false, 'the page is usable again');
  });

  await withApp({}, async (page) => {
    await page.waitForSelector('#prompt');
    await page.evaluate(() => { const real = window.fetch; window.fetch = (u, o) => (String(u).endsWith('/api/trips') && o?.method === 'POST' ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'The planning model is busy right now.', code: 'AI_FAILED', retry: true } }), { status: 502 })) : real(u, o)); });
    await page.type('#prompt', PROMPT);
    await page.click('[data-act="plan"]');
    await page.waitForSelector('[data-act="retry-error"]', { timeout: 5000 });
  });
});
