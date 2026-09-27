const assert = require('node:assert/strict');
const test = require('node:test');
const { handler } = require('../netlify/functions/search.js');

function hira(items, code = '00') {
  return { response: { header: { resultCode: code }, body: { items: { item: items } } } };
}
function run(q) { return handler({ httpMethod: 'GET', queryStringParameters: { q } }); }

test('real HIRA JSON shape preserves hospital coordinates and never calls Naver', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_API_KEY;
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => hira({
      yadmNm: '재단법인아산사회복지재단 서울아산병원',
      addr: '서울특별시 송파구 올림픽로43길 88',
      YPos: 37.5265762, XPos: '127.1079350', clCdNm: '상급종합', telno: '1688-7575'
    }) };
  };
  const res = await run('서울아산병원');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).places, [{
    name: '재단법인아산사회복지재단 서울아산병원',
    address: '서울특별시 송파구 올림픽로43길 88',
    lat: '37.5265762', lng: '127.107935', tel: '1688-7575',
    category: '상급종합', source: 'hira'
  }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/apis\.data\.go\.kr\//);
  assert.ok(!calls[0].includes('naver.com'));
});

test('missing and invalid coordinates are excluded so UI offers direct input', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => hira([
    { yadmNm: '주소만 있는 병원', addr: '서울시', XPos: '', YPos: '' },
    { yadmNm: '외국 좌표 병원', addr: '서울시', XPos: 50, YPos: 51 },
    { yadmNm: '정상 병원', addr: '서울시', XPos: 127, YPos: 37 }
  ]) });
  const places = JSON.parse((await run('병원')).body).places;
  assert.deepEqual(places.map(x => x.name), ['정상 병원']);
});

test('missing credentials and provider failure fail safely', async () => {
  delete process.env.HIRA_API_KEY;
  assert.equal((await run('병원')).statusCode, 503);
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: false, status: 503 });
  assert.equal((await run('병원')).statusCode, 503);
});

test('empty results preserve direct-entry path', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => hira(undefined) });
  assert.deepEqual(JSON.parse((await run('없는병원')).body), { ok: true, places: [] });
});

test('exact hospital name comes before a containing branch name', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => hira([
    { yadmNm: '분당서울대학교병원', addr: '경기도 성남시', XPos: 127, YPos: 37 },
    { yadmNm: '서울대학교병원', addr: '서울특별시 종로구', XPos: 127, YPos: 37 }
  ]) });
  const places = JSON.parse((await run('서울대학교병원')).body).places;
  assert.equal(places[0].name, '서울대학교병원');
});
