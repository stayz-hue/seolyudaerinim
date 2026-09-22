const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../id-ocr.js'), 'utf8');
const parser = require('../id-ocr.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };
const identity = name => `주민등록증\n성명: ${name}\n880305-1******\n서울특별시 강남구 테스트로 10\n2026. 1. 1.\n서울특별시 강남구청장`;

function mockRuntime(outputs, overrides = {}) {
  const state = {calls:[], parameters:[], terminated:0, closed:0, canvases:[], timers:[], createCount:0};
  const worker = {
    setParameters:async value => {state.parameters.push(value.tessedit_pageseg_mode);},
    recognize:async input => {
      state.calls.push(input);
      const output = outputs[state.calls.length - 1];
      if (output instanceof Error) throw output;
      return typeof output === 'function' ? output() : {data:{text:output || ''}};
    },
    terminate:async () => {state.terminated++;}
  };
  const sandbox = {
    module:{exports:{}},
    setTimeout:callback => {state.timers.push(callback); return state.timers.length;},
    clearTimeout:() => {},
    Tesseract:{createWorker:async (lang, mode, options) => {state.createCount++; state.logger = options.logger; return worker;}},
    createImageBitmap:async () => ({width:100,height:60,close:() => {state.closed++;}}),
    document:{createElement:tag => {
      if (tag !== 'canvas') throw new Error('unexpected document element');
      const canvas = {width:0,height:0,getContext:() => ({translate(){},rotate(){},drawImage(){}})};
      state.canvases.push(canvas);
      return canvas;
    }},
    ...overrides
  };
  vm.runInNewContext(source, sandbox);
  return {api:sandbox.module.exports, state, worker, sandbox};
}

test('label parsing stays on one line and never appends an address or issuer', () => {
  assert.equal(parser.parse('성명 홍길동\n서울특별시').name, '홍길동');
  assert.equal(parser.parse('성 명 : 홍 길 동\n경찰청장').name, '홍길동');
  assert.equal(parser.parse('성명:\n홍 길 동\n주소 서울특별시 12').name, '홍길동');
  assert.equal(parser.parse('성명 홍길동 주소 서울특별시 12').name, '');
});

test('ID title parsing accepts spaced Korean names and a Hanja suffix', () => {
  const parsed = parser.parse('주 민 등 록 증\n홍 길 동 (洪吉童)\n880305-1******\n서울특별시 강남구 테스트로 10');
  assert.equal(parsed.name, '홍길동');
  assert.equal(parsed.birth, '19880305');
  assert.equal(parsed.address, '서울특별시 강남구 테스트로 10');
  assert.equal(parsed.reviewRequired, true);
});

test('regions, issuers, placeholders, and license categories are never name candidates', () => {
  for (const value of ['서울특별시','부산광역시장','경기도경찰청장','대한민국','주민등록증','신청인 이름','보통','제주특별자치도','주소','적성검사','발급일']) {
    assert.equal(parser.parse(`성명: ${value}`).name, '', value);
    assert.equal(parser.parse(`운전면허증\n${value}`).name, '', value);
  }
  assert.equal(parser.parse('홍길동\n아무 문서').name, '', 'bare text without an ID title/label is not an identity');
});

test('multiple different name candidates clear identity suggestions', () => {
  const result = parser.parse('주민등록증\n홍길동\n김철수\n880305-1******\n서울특별시 강남구 테스트로 10');
  assert.equal(result.nameStatus, 'conflict');
  assert.equal(result.name, '');
  assert.equal(result.birth, '');
  assert.equal(result.address, '');
  assert.deepEqual(result.candidates, ['홍길동','김철수']);
  assert.equal(parser.parse('주민등록증\n홍길동\n성명: 김철수').nameStatus, 'conflict');
});

test('repeated identical labels are evidence for one candidate, not a conflict', () => {
  const result = parser.parse('성명: 홍길동\n성 명: 홍 길 동');
  assert.equal(result.name, '홍길동');
  assert.equal(result.nameStatus, 'single');
});

test('birth extraction never guesses a century and rejects impossible/conflicting dates', () => {
  assert.equal(parser.parse('성명: 홍길동\n880305').birth, '');
  assert.equal(parser.parse('성명: 홍길동\n880305-*******').birth, '');
  assert.equal(parser.parse('성명: 홍길동\n000229-3******').birth, '20000229');
  assert.equal(parser.parse('성명: 홍길동\n990229-1******').birth, '');
  assert.equal(parser.parse('생년월일: 1988. 3. 5.').birth, '19880305');
  assert.equal(parser.parse('880305-1******\n생년월일: 1989. 3. 5.').birth, '');
  assert.equal(parser.parse('생년월일: 1988. 3. 5.\n생년월일: 1989. 3. 5.').birth, '');
});

test('address excludes issue date and issuing authority', () => {
  const result = parser.parse(identity('홍길동'));
  assert.equal(result.address, '서울특별시 강남구 테스트로 10');
  assert.equal(parser.parse('서울특별시 강남구청장').address, '');
});

test('manual Korean name normalization rejects placeholders and non-name syntax', () => {
  assert.equal(parser.normalizeName(' 홍 길 동 '), '홍길동');
  for (const name of ['홍길동','남궁민수','박 하 늘']) assert.equal(parser.isValidName(name), true, name);
  for (const name of ['신청인 이름','성명확인필요','',null,'홍','홍길동123','<img>']) assert.equal(parser.isValidName(name), false, String(name));
});

test('two matching reads of the same orientation produce review-required agreement', async () => {
  const {api, state} = mockRuntime([identity('홍길동'),identity('홍 길 동')]);
  const job = api.recognize({type:'image/png'});
  const result = await job.promise;
  assert.equal(result.name, '홍길동');
  assert.equal(result.nameStatus, 'agreement');
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(state.parameters, ['11','6']);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[0].angle, 0);
  assert.equal(state.canvases.length, 0);
  assert.equal(state.terminated, 1);
  job.cancel();
  assert.equal(state.terminated, 1);
});

test('a different name on the second pass clears fields regardless of field count', async () => {
  const {api} = mockRuntime([identity('홍길동'),'성명: 김철수']);
  const result = await api.recognize({}).promise;
  assert.equal(result.nameStatus, 'conflict');
  assert.equal(result.name, '');
  assert.equal(result.birth, '');
  assert.equal(result.address, '');
});

test('one candidate does not borrow a birthday/address from a pass without its name', async () => {
  const {api} = mockRuntime(['성명: 홍길동','990101-1******\n서울특별시 강남구 다른로 12']);
  const result = await api.recognize({}).promise;
  assert.equal(result.name, '홍길동');
  assert.equal(result.nameStatus, 'single');
  assert.equal(result.birth, '');
  assert.equal(result.address, '');
});

test('a conflict inside one reading is not overwritten by a clear later reading', async () => {
  const {api} = mockRuntime(['성명: 홍길동\n성명: 김철수',identity('홍길동')]);
  assert.equal((await api.recognize({}).promise).nameStatus, 'conflict');
});

test('matching names with conflicting ancillary fields keep those fields empty', async () => {
  const {api} = mockRuntime([identity('홍길동'),identity('홍길동').replace('880305','890305').replace('테스트로 10','테스트로 11')]);
  const result = await api.recognize({}).promise;
  assert.equal(result.nameStatus, 'agreement');
  assert.equal(result.birth, '');
  assert.equal(result.address, '');
});

test('rotates only after both original readings fail and frees canvas/bitmap', async () => {
  const {api, state} = mockRuntime(['','',identity('홍길동'),identity('홍길동')]);
  const result = await api.recognize({}).promise;
  assert.equal(result.name, '홍길동');
  assert.equal(state.calls.length, 4);
  assert.equal(result.evidence[2].angle, 90);
  assert.equal(state.closed, 1);
  assert.equal(state.canvases.length, 1);
  assert.equal(state.canvases[0].width, 0);
  assert.equal(state.canvases[0].height, 0);
  assert.equal(state.terminated, 1);
});

test('all failed orientations leave a missing result without inventing a name', async () => {
  const {api, state} = mockRuntime([]);
  const result = await api.recognize({}).promise;
  assert.equal(result.nameStatus, 'missing');
  assert.equal(state.calls.length, 8);
  assert.equal(state.closed, 1);
  assert.equal(state.canvases.length, 3);
});

test('browsers without createImageBitmap still return a reviewable missing result', async () => {
  const {api, state} = mockRuntime([], {createImageBitmap:undefined});
  assert.equal((await api.recognize({}).promise).nameStatus, 'missing');
  assert.equal(state.calls.length, 2);
});

test('immediate cancellation prevents creation of a worker', async () => {
  const {api, state} = mockRuntime([]);
  const job = api.recognize({});
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  await tick();
  assert.equal(state.createCount, 0);
});

test('cancellation during worker startup rejects promptly and terminates late worker once', async () => {
  const late = deferred();
  const {api, state, worker} = mockRuntime([], {Tesseract:{createWorker:() => late.promise}});
  const job = api.recognize({});
  await tick();
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  assert.equal(state.terminated, 0);
  late.resolve(worker);
  await tick();
  assert.equal(state.terminated, 1);
  assert.equal(state.calls.length, 0);
});

test('cancellation ignores late OCR output and stops progress notifications', async () => {
  const late = deferred(), progress = [];
  const {api, state} = mockRuntime([() => late.promise]);
  const job = api.recognize({}, value => progress.push(value));
  await tick();
  state.logger({status:'recognizing text',progress:0.2});
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  state.logger({status:'recognizing text',progress:1});
  late.resolve({data:{text:identity('홍길동')}});
  await tick();
  assert.deepEqual(progress, [0.2]);
  assert.equal(state.terminated, 1);
  assert.equal(state.calls.length, 1);
});

test('cancellation while a rotated bitmap is decoding frees the late bitmap', async () => {
  const late = deferred();
  let closed = 0;
  const {api, state} = mockRuntime(['',''], {createImageBitmap:() => late.promise});
  const job = api.recognize({});
  await tick();
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  late.resolve({width:100,height:60,close:() => closed++});
  await tick();
  assert.equal(closed, 1);
  assert.equal(state.terminated, 1);
});

test('OCR errors release worker, rotated image and canvas', async () => {
  const {api, state} = mockRuntime(['','',new Error('recognize failed')]);
  await assert.rejects(api.recognize({}).promise, /recognize failed/);
  assert.equal(state.terminated, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.canvases[0].width, 0);
});

test('parameter setup failure also terminates the initialized worker', async () => {
  const {api, state, worker} = mockRuntime([]);
  worker.setParameters = async () => {throw new Error('parameter setup failed');};
  await assert.rejects(api.recognize({}).promise, /parameter setup failed/);
  assert.equal(state.terminated, 1);
  assert.equal(state.calls.length, 0);
});

test('cancellation during parameter setup prevents a subsequent recognize call', async () => {
  const late = deferred();
  const {api, state, worker} = mockRuntime([]);
  worker.setParameters = () => late.promise;
  const job = api.recognize({});
  await tick();
  job.cancel();
  await assert.rejects(job.promise, /cancelled/);
  late.resolve();
  await tick();
  assert.equal(state.calls.length, 0);
  assert.equal(state.terminated, 1);
});

test('failed library download rejects cleanly and permits a later retry', async () => {
  const scripts = [];
  const {api, state, worker, sandbox} = mockRuntime([identity('홍길동'),identity('홍길동')], {
    Tesseract:undefined,
    document:{createElement:() => ({remove(){}}),head:{appendChild:script => scripts.push(script)}}
  });
  const failed = api.recognize({});
  scripts[0].onerror();
  await assert.rejects(failed.promise, /ocr_unavailable/);
  const retried = api.recognize({});
  assert.equal(scripts.length, 2);
  sandbox.Tesseract = {createWorker:async () => worker};
  scripts[1].onload();
  assert.equal((await retried.promise).name, '홍길동');
  assert.equal(state.terminated, 1);
});

test('hung library download times out, removes its script, and allows a successful retry', async () => {
  const scripts = [];
  let removed = 0;
  const {api, state, worker, sandbox} = mockRuntime([identity('홍길동'),identity('홍길동')], {
    Tesseract:undefined,
    document:{createElement:() => ({remove(){removed++;}}),head:{appendChild:script => scripts.push(script)}}
  });
  const hung = api.recognize({});
  const staleLoad = scripts[0].onload;
  state.timers[0]();
  await assert.rejects(hung.promise, /ocr_library_timeout/);
  assert.equal(removed, 1);
  assert.equal(scripts[0].onload, null);
  assert.equal(scripts[0].onerror, null);
  const retried = api.recognize({});
  assert.equal(scripts.length, 2);
  staleLoad(); // A queued event from the old script cannot settle/reset the retry.
  sandbox.Tesseract = {createWorker:async () => worker};
  scripts[1].onload();
  assert.equal((await retried.promise).name, '홍길동');
  assert.equal(state.terminated, 1);
  assert.equal(removed, 1);
});

test('timeout rejects a hung OCR task and terminates the worker once', async () => {
  const late = deferred();
  const {api, state} = mockRuntime([() => late.promise]);
  const job = api.recognize({});
  await tick();
  state.timers[0]();
  await assert.rejects(job.promise, /ocr_timeout/);
  job.cancel();
  assert.equal(state.terminated, 1);
  late.resolve({data:{text:identity('홍길동')}});
  await tick();
});
