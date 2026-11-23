const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Baemin font faces refer to local WOFF2 assets and have licensed distribution notes', () => {
  const css = read('design.css');
  for (const [family, filename] of [['BM JUA', 'BMJUA.woff2'], ['BM HANNA Air', 'BMHANNAAir.woff2']]) {
    assert.ok(css.includes(`font-family: '${family}'`));
    assert.ok(css.includes(`url('/fonts/${filename}')`));
    const font = fs.readFileSync(path.join(root, 'fonts', filename));
    assert.equal(font.subarray(0, 4).toString('ascii'), 'wOF2');
    assert.equal(font.readUInt32BE(8), font.length, 'WOFF2 length must match the file');
  }
  assert.match(read('fonts/LICENSE.txt'), /Open Font License/i);
  assert.match(css, /--sd-font-body:[^;]*Pretendard[^;]*sans-serif/);
});

test('intake and payment pages use the same versioned typography stylesheet', () => {
  const revision = filename => {
    const href = read(filename).match(/href="(\/design\.css\?v=[a-zA-Z0-9_-]+)"/);
    assert.ok(href, filename + ' is missing its versioned design stylesheet');
    return href[1];
  };
  assert.equal(revision('index.html'), revision('payment.html'));
});
