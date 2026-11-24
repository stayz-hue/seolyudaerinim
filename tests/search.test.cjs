const assert = require('node:assert/strict');
const test = require('node:test');
const searchModule = require.resolve('../netlify/functions/search.js');
let handler;
test.beforeEach(() => {
  // Each case owns a warm-function cache and provider stub.
  delete require.cache[searchModule];
  ({ handler } = require(searchModule));
});

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

test('hospital names and addresses remain selectable even without valid coordinates', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => hira([
    { yadmNm: '주소만 있는 병원', addr: '서울시', XPos: '', YPos: '' },
    { yadmNm: '외국 좌표 병원', addr: '서울시', XPos: 50, YPos: 51 },
    { yadmNm: '정상 병원', addr: '서울시', XPos: 127, YPos: 37 }
  ]) });
  const places = JSON.parse((await run('병원')).body).places;
  assert.deepEqual(places.map(x => x.name), ['주소만 있는 병원', '외국 좌표 병원', '정상 병원']);
  assert.deepEqual(places.map(x => [x.lat, x.lng]), [[null, null], [null, null], ['37', '127']]);
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

test('common short names resolve without calling an AI service', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => hira({
      yadmNm: '서울대학교병원', addr: '서울특별시 종로구', XPos: 127, YPos: 37
    }) };
  };
  assert.equal(JSON.parse((await run('서울대병원')).body).places[0].name, '서울대학교병원');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(encodeURIComponent('서울대학교병원')));
  delete process.env.ANTHROPIC_API_KEY;
});

test('malformed entries do not hide valid hospital records in the same provider result', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  global.fetch = async () => ({ ok: true, json: async () => hira([
    null, 'unreadable', {}, {yadmNm:{},addr:'서울특별시 중구'}, {yadmNm:'불완전병원',addr:[]},
    {yadmNm:'검증병원',addr:'서울특별시 중구',XPos:127,YPos:37}
  ]) });
  const res = await run('검증병원');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).places.map(place => place.name), ['검증병원']);
});

test('a spaced Bundang hospital alias goes directly to the intended campus', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  const names = [];
  global.fetch = async url => {
    const name = new URL(url).searchParams.get('yadmNm');
    names.push(name);
    return { ok: true, json: async () => hira(name === '분당서울대학교병원' ? { yadmNm: name, addr: '경기도 성남시' } : []) };
  };
  const result = JSON.parse((await run('분당 서울대 병원')).body);
  assert.deepEqual(names, ['분당서울대학교병원']);
  assert.equal(result.places[0].name, '분당서울대학교병원');
});

test('an alias with no result makes one lookup rather than retrying raw input', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  const names = [];
  global.fetch = async url => {
    names.push(new URL(url).searchParams.get('yadmNm'));
    return { ok: true, json: async () => hira([]) };
  };
  const res = await run('서울대병원');
  assert.deepEqual(names, ['서울대학교병원']);
  assert.deepEqual(JSON.parse(res.body), {ok:true,places:[]});
  assert.match(res.headers['Netlify-CDN-Cache-Control'], /s-maxage=30$/);
});

test('aliases and concurrent callers share the same lookup and warm cache', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  let calls = 0;
  let complete;
  const waiting = new Promise(resolve => { complete = resolve; });
  global.fetch = async () => {
    calls++;
    await waiting;
    return { ok:true,json:async()=>hira({yadmNm:'서울대학교병원',addr:'서울특별시 종로구'}) };
  };
  const first = run('서울대병원');
  const second = run('서울대학교병원');
  complete();
  const [a,b] = await Promise.all([first, second]);
  const c = await run('서울대 병원');
  assert.equal(calls,1);
  assert.equal(a.body,b.body);
  assert.equal(a.body,c.body);
  assert.equal(c.headers['Netlify-Vary'],'query=q');
  assert.equal(c.headers['Cache-Control'],'public, max-age=300');
  assert.match(c.headers['Netlify-CDN-Cache-Control'], /s-maxage=21600$/);
});

test('empty cache expires quickly and never becomes a permanent negative result', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  let calls = 0;
  const now = Date.now;
  let simulated = now();
  Date.now = () => simulated;
  try {
    global.fetch = async () => ({ok:true,json:async()=>hira(++calls === 1 ? [] : {yadmNm:'새병원',addr:'서울특별시'})});
    assert.deepEqual(JSON.parse((await run('새병원')).body).places,[]);
    simulated += 29000;
    assert.deepEqual(JSON.parse((await run('새병원')).body).places,[]);
    assert.equal(calls,1);
    simulated += 1001;
    assert.equal(JSON.parse((await run('새병원')).body).places[0].name,'새병원');
    assert.equal(calls,2);
  } finally {
    Date.now = now;
  }
});

test('provider failure uses a 3.5-second deadline, remains uncached, and permits a retry', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  const timeout = AbortSignal.timeout;
  const durations = [];
  let calls = 0;
  AbortSignal.timeout = milliseconds => {
    durations.push(milliseconds);
    return timeout(milliseconds);
  };
  try {
    global.fetch = async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (++calls === 1) throw new Error('simulated provider timeout');
      return {ok:true,json:async()=>hira({yadmNm:'재시도병원',addr:'서울특별시'})};
    };
    const failed = await run('재시도병원');
    assert.equal(failed.statusCode,503);
    assert.equal(failed.headers['Cache-Control'],'no-store');
    assert.equal(failed.headers['Netlify-CDN-Cache-Control'],undefined);
    assert.equal(JSON.parse((await run('재시도병원')).body).places[0].name,'재시도병원');
    assert.equal(calls,2);
    assert.deepEqual(durations,[3500,3500]);
  } finally {
    AbortSignal.timeout = timeout;
  }
});

test('warm cache stays bounded and does not evict recently used entries first', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  const calls = [];
  global.fetch = async url => {
    const name = new URL(url).searchParams.get('yadmNm');
    calls.push(name);
    return {ok:true,json:async()=>hira({yadmNm:name,addr:'테스트 주소'})};
  };
  for (let i=0;i<256;i++) await run('테스트병원'+i);
  await run('테스트병원0');
  assert.equal(calls.length,256);
  await run('테스트병원256');
  await run('테스트병원0');
  assert.equal(calls.length,257);
  await run('테스트병원1');
  assert.equal(calls.length,258);
});

test('malformed provider bodies and unusable nonempty results are failures, not cached empty results', async () => {
  process.env.HIRA_API_KEY = 'test-key';
  for (const data of [{response:{header:{resultCode:'00'}}}, {response:{header:{resultCode:'00'},body:{totalCount:2,items:''}}}, hira([null,{}])]) {
    global.fetch = async () => ({ok:true, json:async () => data});
    const res = await run('검증병원');
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).ok, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('unexpected query type takes the normal invalid-input path without a provider call', async () => {
  global.fetch = async () => {throw new Error('unexpected provider call');};
  const res = await run(['검증병원']);
  assert.deepEqual(JSON.parse(res.body), {ok:false,error:'검색어 2자 이상'});
});
