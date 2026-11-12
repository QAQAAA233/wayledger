import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { world, startRun } from './agent-world.js';
import { scriptedModel } from './helpers.js';
import { stormSteps, BY_TRAVELER, REQUEST_QUOTE, SINTRA_QUOTE } from './storm.js';

async function read(wd, suffix = '', token = null) {
  const response = await handleRequest(new Request(`https://wayledger.test/api/trips/${wd.id}${suffix}`, {
    headers: token ? { 'x-owner-token': token } : {},
  }), wd.w.env);
  assert.equal(response.status, 200);
  return response.json();
}

test('shared proposals and run decisions hide traveler quotes without changing the owner view', async () => {
  const wd = await world({ run: scriptedModel(stormSteps({ authority: BY_TRAVELER })), terms: { enabled: false } });
  const run = await startRun(wd);
  assert.equal(run.final.outcome, 'proposed');
  for (const token of [null, 'wrong-owner-token']) {
    const view = await read(wd, '', token);
    const trail = await read(wd, `/runs/${run.id}`, token);
    assert.equal(view.owner, false);
    assert.equal(view.proposal.digest, null);
    assert.equal(JSON.stringify(view).includes(REQUEST_QUOTE), false, 'no nested quote or rendered basis in the shared proposal');
    assert.equal(JSON.stringify(trail).includes(REQUEST_QUOTE), false, 'no nested quote or rendered basis in the shared trail');
    assert.equal(view.proposal.authority.source, 'traveler');
    assert.ok(trail.events.some((e) => e.kind === 'compare'), 'the comparison is still shareable');
    assert.ok(trail.events.some((e) => e.kind === 'decision'), 'the decision is still shareable');
  }
  const ownerView = await read(wd, '', wd.token);
  const ownerRun = await read(wd, `/runs/${run.id}`, wd.token);
  assert.equal(ownerView.owner, true);
  assert.equal(ownerView.proposal.authority.quote, REQUEST_QUOTE);
  assert.ok(ownerView.proposal.basisText.includes(REQUEST_QUOTE));
  assert.equal(ownerRun.events.find((e) => e.kind === 'decision').authority.quote, REQUEST_QUOTE);
  assert.ok(ownerRun.events.find((e) => e.kind === 'decision').basis.includes(REQUEST_QUOTE));
});

test('shared original and refreshed loss proposals hide document quotes but retain amounts and owner evidence', async () => {
  const wd = await world({ terms: { enabled: false } });
  const sintra = wd.state().plan.items.find((i) => /Sintra/.test(i.title));
  const facade = wd.w.objects.get(wd.id).runner.facade;
  await facade.mutate('recordPolicy', [{ docId: 'd1', itemId: sintra.id, quote: SINTRA_QUOTE, nonRefundable: true }]);
  const edit = await facade.mutate('submitEdit', [{ ops: [{ op: 'remove', itemId: sintra.id }], authority: { source: 'traveler', quote: 'Cancel the Sintra day trip.' } }]);
  assert.equal(edit.outcome, 'proposed');
  for (const refreshed of [false, true]) {
    if (refreshed) {
      const current = await wd.view();
      wd.clock.t += 16 * 60_000;
      assert.equal((await wd.call('refreshProposal', [current.proposal.id])).ok, true);
    }
    for (const token of [null, 'wrong-owner-token']) {
      const shared = await read(wd, '', token);
      assert.equal(shared.owner, false);
      assert.equal(shared.documents[0].text, undefined);
      assert.equal(shared.policies[0].quote, null);
      assert.equal(JSON.stringify(shared).includes(SINTRA_QUOTE), false, 'operatorLoss must not bypass document privacy');
      assert.equal(shared.proposal.operatorLoss[0].lossCents, sintra.amountCents);
      assert.equal(shared.proposal.operatorLoss[0].title, sintra.title);
    }
    const owner = await read(wd, '', wd.token);
    assert.equal(owner.proposal.operatorLoss[0].quote, SINTRA_QUOTE);
    assert.ok(owner.documents[0].text.includes(SINTRA_QUOTE));
    assert.equal(owner.policies[0].quote, SINTRA_QUOTE);
  }
});
