'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'payment.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function page(query, clipboard) {
  const elements = Object.fromEntries([
    'payScreen', 'errorScreen', 'dispName', 'dispOrderId', 'dispAmount',
    'dispAmount2', 'accountNum', '.copy-btn'
  ].map(id => [id, { textContent: '', style: {} }]));
  elements.accountNum.textContent = '000-000000-00-000';
  const prompts = [];
  const context = vm.createContext({
    window: { location: { search: query } }, URLSearchParams,
    navigator: clipboard === undefined ? {} : { clipboard },
    document: {
      getElementById: id => elements[id],
      querySelector: selector => elements[selector]
    },
    prompt: (...args) => prompts.push(args),
    setTimeout: () => 0
  });
  vm.runInContext(source, context, { filename: 'payment.html' });
  return { elements, prompts, context };
}

test('a valid legacy order link keeps name, order number and amount', () => {
  const p = page('?order_id=SEOLYUDAERI_20260713_수동&amount=24500&name=시험고객');
  assert.equal(p.elements.dispName.textContent, '시험고객');
  assert.equal(p.elements.dispOrderId.textContent, 'SEOLYUDAERI_20260713_수동');
  assert.equal(p.elements.dispAmount.textContent, '24,500원');
  assert.equal(p.elements.dispAmount2.textContent, '24,500원');
  assert.notEqual(p.elements.payScreen.style.display, 'none');
});

test('malformed, fractional, missing and unsafe amounts show no payment instructions', () => {
  for (const amount of ['100garbage', '100.5', '1e3', '-100', '', 'NaN', 'Infinity', '9007199254740992', '99', '0']) {
    const p = page('?order_id=synthetic-order&amount=' + encodeURIComponent(amount));
    assert.equal(p.elements.payScreen.style.display, 'none', amount);
    assert.equal(p.elements.errorScreen.style.display, 'block', amount);
    assert.equal(p.elements.dispAmount.textContent, '', amount);
  }
});

test('missing or whitespace-only order numbers are rejected', () => {
  for (const query of ['?amount=25000', '?order_id=%20%20&amount=25000']) {
    const p = page(query);
    assert.equal(p.elements.payScreen.style.display, 'none');
    assert.equal(p.elements.errorScreen.style.display, 'block');
  }
});

test('account copying works with a supported clipboard', async () => {
  const copied = [];
  const p = page('?order_id=synthetic-order&amount=25000', {
    writeText: text => { copied.push(text); return Promise.resolve(); }
  });
  vm.runInContext('copyAccount()', p.context);
  await new Promise(setImmediate);
  assert.deepEqual(copied, ['00000000000000']);
  assert.equal(p.elements['.copy-btn'].textContent, '복사 완료 ✓');
  assert.equal(p.prompts.length, 0);
});

test('an unavailable clipboard offers manual copying', () => {
  const p = page('?order_id=synthetic-order&amount=25000');
  assert.doesNotThrow(() => vm.runInContext('copyAccount()', p.context));
  assert.equal(p.prompts.length, 1);
  assert.equal(p.prompts[0][1], '00000000000000');
});

test('both clipboard permission rejection and synchronous failure offer manual copying', async () => {
  for (const writeText of [
    () => Promise.reject(new Error('synthetic permission failure')),
    () => { throw new Error('synthetic clipboard failure'); }
  ]) {
    const p = page('?order_id=synthetic-order&amount=25000', { writeText });
    vm.runInContext('copyAccount()', p.context);
    await new Promise(setImmediate);
    assert.equal(p.prompts.length, 1);
    assert.notEqual(p.elements['.copy-btn'].textContent, '복사 완료 ✓');
  }
});
