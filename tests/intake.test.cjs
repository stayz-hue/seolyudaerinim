'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/type=["']application\/ld\+json["']/i.test(match[1]))
  .map(match => match[2]);
const tick = () => new Promise(resolve => setImmediate(resolve));
const successResponse = (request, overrides = {}) => {
  const {orderId} = JSON.parse(request.body);
  return {ok:true, json:()=>Promise.resolve({ok:true,orderId,receiptNo:orderId,baseAmount:25000,state:'waiting_payment',duplicate:false,...overrides})};
};

// A small DOM adapter executes the shipped inline scripts, without contacting any service.
function fixture(options = {}) {
  const elements = new Map(), htmlWrites = [], alerts = [], confirms = [], requests = [];
  const readers = [], images = [], blobs = [], timers = new Map(), prompts = [];
  let timerId = 0, readMode = options.readMode || 'success';
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.value = '';
      this.checked = false; this.disabled = false; this._id = ''; this._text = ''; this._html = '';
      this.classes = new Set();
      this.classList = {
        add: (...items) => items.forEach(item => this.classes.add(item)),
        remove: (...items) => items.forEach(item => this.classes.delete(item)),
        contains: item => this.classes.has(item),
        toggle: (item, value = !this.classes.has(item)) => value ? this.classes.add(item) : this.classes.delete(item)
      };
    }
    set id(value) { this._id = value; if (value) elements.set(value, this); }
    get id() { return this._id; }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    unregister() { if (elements.get(this.id) === this) elements.delete(this.id); this.children.forEach(child => child.unregister()); }
    clear() { this.children.forEach(child => child.unregister()); this.children = []; }
    set innerHTML(value) {
      this.clear(); this._html = value; this._text = ''; htmlWrites.push(value);
      for (const match of value.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const child = new Element(match[1]); child.id = match[3];
        const klass = match[2].match(/\bclass="([^"]*)"/); if (klass) child.className = klass[1];
        this.appendChild(child);
      }
    }
    get innerHTML() { return this._html; }
    set textContent(value) { this.clear(); this._text = String(value); this._html = ''; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    remove() { this.unregister(); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener() {}
    setAttribute(name,value) { this[name]=String(value); }
    getAttribute(name) { return this[name] ?? null; }
    removeAttribute(name) { delete this[name]; }
    closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector) || null; }
    after(node) { if (this.parent) this.parent.appendChild(node); }
    focus() { this.focused = true; }
    scrollIntoView(options) { this.scrollPosition = options.block; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    getBoundingClientRect() { return {width:320, height:200}; }
    getContext() { return {drawImage() {}, fillRect() {}, scale() {}}; }
    toBlob(callback, type) { blobs.push(blob => callback(blob && {type, ...blob})); }
  }
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]); node.id = match[3];
    const klass = match[2].match(/\bclass="([^"]*)"/); if (klass) node.className = klass[1];
    node.checked = /\bchecked\b/.test(match[2]);
    node.required = /\brequired\b/.test(match[2]);
  }
  const buttons = [new Element('button'), new Element('button')];
  const listeners = new Map();
  const document = {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '.btn-next.submit' ? buttons : [],
    addEventListener(name, callback) { listeners.set(name, callback); }, body: new Element('body')
  };
  const context = vm.createContext({
    document, window:{scrollTo() {}, devicePixelRatio:1}, navigator:options.navigator || {},
    crypto:webcrypto, console, URLSearchParams, AbortController,
    alert: message => alerts.push(message),
    confirm: message => { confirms.push(message); return options.confirm !== false; },
    prompt: (...args) => prompts.push(args),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame() {},
    File: class { constructor(parts, name, props) { this.name = name; this.type = props.type; this.size = 100; } },
    FileReader: class {
      constructor() { readers.push(this); }
      readAsDataURL(file) {
        this.file = file;
        if (readMode === 'throw') throw new Error('private file path');
        if (readMode === 'error') { this.onerror(); return; }
        if (readMode === 'abort') { this.onabort(); return; }
        if (readMode === 'success') this.onload({target:{result:'data:image/jpeg;base64,dGVzdA=='}});
      }
    },
    Image: class { constructor() { images.push(this); } },
    SignaturePad: class { constructor() { throw new Error('Existing signature must not be replaced'); } },
    fetch: (url, request) => {
      requests.push({url, request, payload: request?.body ? JSON.parse(request.body) : undefined});
      return options.fetch ? options.fetch(url, request) : Promise.resolve(successResponse(request));
    }
  });
  for (const script of scripts) vm.runInContext(script, context);
  function run(code) { return vm.runInContext(code, context); }
  function set(id, value) { elements.get(id).value = value; }
  function seedForm() {
    run('buildHospitalBlocks()');
    set('patientName', '홍가람'); set('patientBirth', '19900101');
    set('patientPhone', '010-0000-0000'); set('patientAddress', '테스트 주소');
    set('email', 'test@example.com');
    set('hospital_1', '테스트 병원'); set('treatPeriod_1', '2025'); set('reason_1', '보험사 제출'); set('docEtc_1', '진료기록');

    elements.get('screen2').classList.add('active');
    run("idCardFileObj = {name:'test.jpg',type:'image/jpeg',size:100}; signaturePad={isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c2ln'}; hospitalCoords=[{name:'테스트 병원',address:'병원 주소',lat:1,lng:2}]");
  }
  return {context, run, set, elements, htmlWrites, alerts, confirms, requests, readers, images, blobs, timers, buttons, prompts,
    seedForm, setReadMode(value) { readMode = value; },
    type(id, value) { set(id, value); listeners.get('input')({target:elements.get(id)}); },
    file(name = 'test.jpg') { return {name, type:'image/jpeg', size:100}; },
    input(file) { return {files:[file], value:'selected'}; },
    loadImage(width=100,height=100,index=images.length-1) { const img = images[index]; img.naturalWidth=width;img.naturalHeight=height;img.onload(); }
  };
}

function assertRecovered(f) {
  assert.equal(f.elements.get('loading').classList.contains('show'), false);
  assert.equal(f.elements.get('success').classList.contains('show'), false);
  assert.equal(f.elements.get('screen2').classList.contains('active'), true);
  assert.equal(f.elements.get('patientName').value, '홍가람');
  assert.equal(f.elements.get('email').value, 'test@example.com');
  assert.equal(f.run('signaturePad.toDataURL()'), 'data:image/png;base64,c2ln');
  assert.equal(f.run('submissionBusy'), false);
  assert.ok(f.buttons.every(button => !button.disabled));
}

test('all inline scripts parse; explicit success displays a stable order number and blocks later submissions', async () => {
  scripts.forEach(script => new vm.Script(script));
  const f = fixture(); f.seedForm(); f.run('submitForm(true)'); await tick();
  assert.equal(f.elements.get('success').classList.contains('show'), true);
  assert.equal(f.elements.get('receiptNum').textContent, f.requests[0].payload.orderId);
  f.run('submitForm(true)'); assert.equal(f.requests.length,1);
});

for (const [label, fetch] of [
  ['server rejection', () => Promise.resolve({ok:true,json:()=>Promise.resolve({ok:false,error:'secret server details'})})],
  ['missing explicit success', () => Promise.resolve({ok:true,json:()=>Promise.resolve({receiptNo:'unexpected'})})],
  ['old server response missing delivery contract', () => Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true})})],
  ['HTTP failure', () => Promise.resolve({ok:false,json:()=>Promise.resolve({ok:true})})],
  ['invalid JSON', () => Promise.resolve({ok:true,json:()=>Promise.reject(new Error('private response'))})],
  ['network loss', () => Promise.reject(new Error('private response'))],
  ['synchronous fetch exception', () => { throw new Error('private response'); }]
]) {
  test(label + ' preserves input and signature, shows uncertainty and does not automatically retry', async () => {
    const f=fixture({fetch}); f.seedForm(); f.run('submitForm(true)'); await tick(); assertRecovered(f);
    assert.equal(f.requests.length,1); assert.equal(f.run('submissionUncertain'),true);
    assert.ok(f.alerts.at(-1).includes(f.requests[0].payload.orderId));
    assert.ok(!f.alerts.join('').includes('private') && !f.alerts.join('').includes('secret'));
    assert.equal(f.timers.size,0);
  });
}

test('request timeout recovers as uncertain without another request', async () => {
  const f=fixture({fetch:(url,request)=>new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('timeout'))))});
  f.seedForm();f.run('submitForm(true)');
  [...f.timers.values()].find(timer=>timer.delay===45000).callback();await tick();assertRecovered(f);
  assert.equal(f.requests.length,1);assert.equal(f.run('submissionUncertain'),true);
});

test('double click while waiting emits only one request', async () => {
  let resolve;
  const f=fixture({fetch:()=>new Promise(done=>{resolve=done})}); f.seedForm();f.run('submitForm(true);submitForm(true)');
  assert.equal(f.requests.length,1);assert.ok(f.buttons.every(button=>button.disabled));
  resolve(successResponse(f.requests[0].request,{receiptNo:'SERVER-RECEIPT'}));await tick();
  assert.equal(f.elements.get('receiptNum').textContent,f.requests[0].payload.orderId);
  assert.equal(f.elements.get('receiptMeta').textContent,'접수번호: SERVER-RECEIPT');
});

test('manual retry warns about duplicates and keeps the original order number', async () => {
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm(true)');await tick();
  f.run('submitForm(true)');await tick();
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].payload.orderId,f.requests[1].payload.orderId);
  assert.equal(f.confirms.length,1);
});

test('declining uncertain retry leaves the original request untouched', async () => {
  const f=fixture({confirm:false,fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm(true)');await tick();
  f.run('submitForm(true)');assert.equal(f.requests.length,1);
});

for(const readMode of ['error','abort','throw']) {
  test('file read '+readMode+' restores the form without sending',()=>{
    const f=fixture({readMode});f.seedForm();f.run('submitForm(true)');assertRecovered(f);
    assert.equal(f.requests.length,0);assert.equal(f.run('submissionUncertain'),false);
    assert.ok(f.alerts.at(-1).includes('전송하지 않았어요'));
  });
}

test('a read failure on uncertain retry does not erase uncertainty about the previous request',async()=>{
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm(true)');await tick();
  f.setReadMode('error');f.run('submitForm(true)');assert.equal(f.run('submissionUncertain'),true);assert.equal(f.requests.length,1);
});

test('returning to the signature step preserves the existing pad',()=>{
  const f=fixture();f.seedForm();const before=f.run('signaturePad');f.run('initSig()');assert.equal(f.run('signaturePad'),before);
});

test('leaving before delayed signature setup does not create a zero-size pad',()=>{
  const f=fixture();
  const canvas=f.elements.get('signaturePad1');
  let visible=true,created=0;
  canvas.getBoundingClientRect=()=>visible?{width:320,height:116}:{width:0,height:0};
  f.context.SignaturePad=class { constructor() { created++; } };
  f.run('goToStep(2)');
  const firstSetup=[...f.timers.values()].find(timer=>timer.delay===200);
  visible=false;f.run('goToStep(4)');firstSetup.callback();
  assert.equal(created,0);assert.equal(f.run('signaturePad'),null);
  visible=true;f.run('goToStep(2)');
  const nextSetup=[...f.timers.values()].filter(timer=>timer.delay===200).at(-1);
  nextSetup.callback();
  assert.equal(created,1);assert.equal(canvas.width,320);assert.equal(canvas.height,116);
});

test('a broken replacement image clears acceptance and cannot pass validation',()=>{
  const f=fixture({readMode:'manual'});f.seedForm();const input=f.input(f.file());f.context.uploadInput=input;
  f.run('handleUpload(uploadInput)');assert.equal(f.run('idCardFileObj'),null);assert.equal(f.run('validatePhoto()'),false);
  f.readers[0].onload({target:{result:'data:image/jpeg;base64,broken'}});f.images[0].onerror();
  const error=f.elements.get('field-error'),area=f.elements.get('uploadArea');
  assert.match(error.textContent,/사진을 읽지 못했어요/);
  assert.equal(area.getAttribute('aria-invalid'),'true');
  assert.equal(area.focused,true);assert.equal(area.getAttribute('aria-describedby'),error.id);
  assert.equal(f.elements.get('uploadSub').textContent,'');assert.equal(f.alerts.length,0);
  assert.equal(f.run('validatePhoto()'),false);assert.equal(f.run('idCardLoading'),false);assert.equal(input.value,'');
  f.run('handleUpload(uploadInput)');
  assert.equal(f.elements.has('field-error'),false);assert.equal(area.getAttribute('aria-invalid'),null);
});

test('late resize for old selection cannot replace the latest uploaded file',()=>{
  const f=fixture({readMode:'manual'});f.context.first=f.input(f.file('first.jpg'));f.context.second=f.input(f.file('second.jpg'));
  f.run('handleUpload(first)');f.readers[0].onload({target:{result:'first'}});f.loadImage(2400,1800);
  assert.equal(f.run('idCardLoading'),true);
  f.run('handleUpload(second)');f.readers[1].onload({target:{result:'data:image/jpeg;base64,/9j/fixture'}});f.loadImage();
  f.blobs[0]({size:80});assert.equal(f.run('idCardFileObj.name'),'second.jpg');assert.equal(f.run('validatePhoto()'),true);
});

test('late decode failure for old selection cannot clear a newer valid image',()=>{
  const f=fixture({readMode:'manual'});f.context.first=f.input(f.file('first.jpg'));f.context.second=f.input(f.file('second.jpg'));
  f.run('handleUpload(first)');f.readers[0].onload({target:{result:'first'}});
  f.run('handleUpload(second)');f.readers[1].onload({target:{result:'data:image/jpeg;base64,/9j/fixture'}});f.loadImage();f.images[0].onerror();
  assert.equal(f.run('idCardFileObj.name'),'second.jpg');assert.equal(f.alerts.length,0);
});

test('resize failure leaves no accepted file',()=>{
  const f=fixture();f.context.input=f.input(f.file());f.run('handleUpload(input)');f.loadImage(2400,1800);f.blobs[0](null);
  assert.equal(f.run('idCardFileObj'),null);assert.equal(f.run('validatePhoto()'),false);
});

test('removing a middle hospital preserves later fields and coordinates; one hospital remains minimum',()=>{
  const f=fixture();f.seedForm();f.run('addHospital();addHospital()');
  for(let i=1;i<=3;i++)for(const prefix of ['hospital_','treatPeriod_','reason_','docEtc_','hospAddr_'])f.set(prefix+i,prefix+i);
  f.run("hospitalCoords=[{name:'one'},{name:'two'},{name:'three',manual:true}]");
  f.elements.get('hospBadge_3').textContent='세번째 주소';f.elements.get('hospManualAddr_3').style.display='block';
  assert.ok(f.run('hospitalBlockHTML(2)').includes('removeHospital(2)'));
  f.run('removeHospital(2)');
  assert.equal(f.run('hospitalCount'),2);
  for(const prefix of ['hospital_','treatPeriod_','reason_','docEtc_','hospAddr_'])assert.equal(f.elements.get(prefix+'2').value,prefix+'3');
  assert.equal(f.run('hospitalCoords[1].name'),'three');
  assert.equal(f.elements.get('hospBadge_2').textContent,'세번째 주소');assert.equal(f.elements.get('hospManualAddr_2').style.display,'block');
  f.run('removeHospital(2);removeHospital(1)');assert.equal(f.run('hospitalCount'),1);assert.equal(f.elements.get('hospital_1').value,'hospital_1');
});

test('manual hospital address is retained without a map lookup and survives removing another hospital',()=>{
  const f=fixture();f.seedForm();f.run('addHospital();addHospital()');
  f.set('hospital_3','수기 병원');f.run('manualInput(3)');f.set('hospAddr_3','서울특별시 테스트로 3');
  f.run('updateManualHospitalAddress(3);removeHospital(2)');
  assert.equal(f.run('hospitalCoords[1].address'),'서울특별시 테스트로 3');
  assert.equal(f.elements.get('hospAddr_2').value,'서울특별시 테스트로 3');
  assert.equal(f.requests.length,0);
});

test('hospital search service failures show retryable failure and are not cached as missing hospitals',async()=>{
  for(const response of [
    {ok:false,json:async()=>({ok:true,places:[]})},
    {ok:true,json:async()=>({ok:false,error:'service unavailable'})},
    {ok:true,json:async()=>({ok:true,places:null})}
  ]) {
    let failed=true;
    const f=fixture({fetch:async()=>failed?response:{ok:true,json:async()=>({ok:true,places:[]})}});
    f.seedForm();f.run("searchHospital('테스트 병원',1)");await tick();
    const drop=f.elements.get('hospDrop_1');
    assert.match(drop.textContent,/검색 실패/);assert.ok(!drop.textContent.includes('검색 결과 없음'));
    assert.equal(drop.children.at(-1).tagName,'BUTTON');
    failed=false;f.run("searchHospital('테스트 병원',1)");await tick();
    assert.match(drop.textContent,/검색 결과 없음/);assert.equal(f.requests.length,2);
    f.run("searchHospital('테스트 병원',1)");await tick();assert.equal(f.requests.length,2);
  }
});

test('hung hospital lookup stops after 20 seconds and supports direct input or a fresh retry',async()=>{
  let hung=true;
  const f=fixture({fetch:(_url,request)=>hung
    ?new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('timeout'))))
    :Promise.resolve({ok:true,json:async()=>({ok:true,places:[]})})});
  f.seedForm();f.run("searchHospital('테스트 병원',1)");await tick();
  [...f.timers.values()].find(timer=>timer.delay===20000).callback();await tick();
  assert.match(f.elements.get('hospDrop_1').textContent,/검색 실패/);
  assert.match(f.elements.get('hospDrop_1').children.at(-1).textContent,/직접 입력/);
  assert.equal(f.run('hospitalSearchPending.size'),0);assert.equal(f.timers.size,0);
  hung=false;f.run("searchHospital('테스트 병원',1)");await tick();
  assert.equal(f.requests.length,2);assert.match(f.elements.get('hospDrop_1').textContent,/검색 결과 없음/);
});

test('multiple hospitals cost 25000 each with one optional postal fee; all urgency flags stay off',async()=>{
  const f=fixture();f.seedForm();f.run('addHospital()');
  f.set('hospital_2','두 번째 병원');f.set('treatPeriod_2','2026');f.set('docEtc_2','진료기록');
  f.run("hospitalCoords[1]={name:'두 번째 병원',address:'서울특별시 테스트로 2',lat:37,lng:127}");
  assert.equal(f.run('calcFee().total'),50000);
  f.run("setDelivery('post')");
  assert.equal(f.run('calcFee().total'),70000);
  assert.equal(f.elements.get('feeTotal').textContent,'70,000원');
  f.set('postAddress','등기 주소');f.run('nextStep(4);nextStep(2)');await tick();
  assert.deepEqual(f.requests[0].payload.urgentFlags,[false,false]);
});

test('official search result without coordinates and direct-entry address remain valid in submission',async()=>{
  const f=fixture();f.seedForm();
  f.run("selectHospital(1,{place_name:'주소만 있는 병원',y:null,x:null,address_name:'서울특별시 테스트로 1'})");
  assert.equal(f.run('hospitalCoords[0].lat'),null);
  assert.equal(f.run('hospitalCoords[0].address'),'서울특별시 테스트로 1');
  assert.equal(f.run('validateHospitals()'),true);
  f.set('hospital_1','수기 병원');f.run('manualInput(1)');f.set('hospAddr_1','경기도 테스트로 2');
  f.run('updateManualHospitalAddress(1)');
  assert.equal(f.run('validateHospitals()'),true);
  assert.equal(f.run('hospitalCoords[0].address'),'경기도 테스트로 2');
  f.run('submitForm(true)');await tick();
  assert.equal(f.requests[0].payload.hospitalCoords[0].address,'경기도 테스트로 2');
  assert.equal(Object.hasOwn(f.requests[0].payload,'bundleResult'),false);
});

test('hospital result labels and addresses render external text literally',async()=>{
  const label='<b>테스트 병원</b>';
  const f=fixture({fetch:async()=>({ok:true,json:async()=>({ok:true,places:[{name:label,address:label}]})})});
  f.seedForm();f.run("searchHospital('테스트 병원',1)");await tick();
  const [name,address]=f.elements.get('hospDrop_1').children[0].children;
  assert.equal(name.textContent,label);assert.equal(address.textContent,label);
  assert.ok(!f.htmlWrites.some(value=>value.includes(label)));
});

test('account copy offers a manual fallback when clipboard is unavailable',()=>{
  const f=fixture();f.elements.get('successAccount').textContent='123-456';f.run('copyIntakeAccount()');
  assert.equal(f.prompts[0][1],'123456');
});

test('invalid fields get one adjacent message and focus, and editing restores their existing hint',()=>{
  const f=fixture();f.seedForm();
  const field=f.elements.get('docEtc_1');
  const group=f.context.document.createElement('div');group.className='field';
  f.elements.get('screen4').appendChild(group);group.appendChild(field);
  field.setAttribute('aria-describedby','document-example');
  f.type('docEtc_1','');
  assert.equal(f.elements.has('field-error'),false);
  f.run('submitForm()');
  assert.equal(f.elements.get('screen4').classList.contains('active'),true);
  assert.equal(f.elements.get('screen2').classList.contains('active'),false);
  const error=f.elements.get('field-error');
  assert.equal(error.parent,group);assert.match(error.textContent,/서류/);
  assert.equal(field.focused,true);assert.equal(field.getAttribute('aria-invalid'),'true');
  assert.equal(field.getAttribute('aria-describedby'),'document-example field-error');
  f.run('nextStep(4)');
  assert.equal(group.children.filter(node=>node.id==='field-error').length,1);
  f.type('docEtc_1','진료기록');
  assert.equal(f.elements.has('field-error'),false);
  assert.equal(field.getAttribute('aria-invalid'),null);
  assert.equal(field.getAttribute('aria-describedby'),'document-example');
  assert.equal(f.requests.length,0);assert.equal(f.alerts.length,0);
});

test('independent applications started in the same millisecond receive different compatible order IDs',async()=>{
  const ids=[];
  for(let i=0;i<2;i++){
    const f=fixture();f.seedForm();f.run('Date.now=()=>1740000000000;submitForm()');
    await tick();
    const id=f.requests[0].payload.orderId;
    assert.match(id,/^SRY[A-Za-z0-9_-]{6,76}$/);
    ids.push(id);
  }
  assert.notEqual(ids[0],ids[1]);
});

test('email delivery is the default; contact phone reuses current patient phone without replacing patient data',async()=>{
  const f=fixture();f.seedForm();
  assert.equal(f.run('deliveryMethod'),'email');
  assert.equal(f.elements.has('sameContact'),false);
  f.set('patientPhone','010-1234-5678');f.set('email','  reply@example.com  ');
  f.run('submitForm(true)');await tick();
  const payload=f.requests[0].payload;
  assert.equal(payload.schemaVersion,3);assert.equal(payload.deliveryMethod,'email');
  assert.equal(payload.patientPhone,'010-1234-5678');assert.equal(payload.contactPhone,'01012345678');
  assert.equal(payload.email,'reply@example.com');assert.equal(payload.postAddress,'');
  assert.ok(f.elements.get('successDelivery').textContent.includes('reply@example.com'));
});

test('one telephone field populates both legacy backend fields',async()=>{
 const f=fixture();f.seedForm();f.set('patientPhone','010 2222 3333');
 f.run('submitForm(true)');await tick();
 assert.equal(f.requests[0].payload.patientPhone.replace(/\D/g,''),'01022223333');
 assert.equal(f.requests[0].payload.contactPhone,'01022223333');
 assert.equal(f.elements.has('contactPhone'),false);
});

test('invalid or absent email blocks both step validation and direct submission without losing entered data',()=>{
  for(const email of ['', 'missing-at.example.com','name@host','a@example.com,b@example.com','a@example.com; b@example.com','a@example.com\r\nBcc:x@example.com']) {
    const f=fixture();f.seedForm();f.set('email',email);
    assert.equal(f.run('validateApplicant()'),false,email);f.run('submitForm(true)');
    assert.equal(f.requests.length,0,email);assert.equal(f.run('submissionBusy'),false,email);
    assert.equal(f.elements.get('email').value,email);assert.equal(f.run('signaturePad.toDataURL()'),'data:image/png;base64,c2ln');
  }
});

test('SMS contact validation rejects empty, landline, short and letter-containing numbers',()=>{
  for(const phone of ['', '02-123-4567','010-1234','abc01012345678']) {
    const f=fixture();f.seedForm();f.set('patientPhone',phone);
    assert.equal(f.run('validateApplicant()'),false,phone);f.run('submitForm(true)');assert.equal(f.requests.length,0,phone);
    assert.equal(f.elements.get('patientPhone').value,phone);
  }
});

for (const email of ['a..b@example.com', 'a@-host.com', 'a@b..com']) {
  test('email validation matches delivery rejection for ' + email,()=>{
    const f=fixture();f.seedForm();f.set('email',email);
    assert.equal(f.run('validateApplicant()'),false);
    f.run('submitForm(true)');assert.equal(f.requests.length,0);
    assert.equal(f.elements.get('email').value,email);
    assert.equal(f.run('signaturePad.toDataURL()'),'data:image/png;base64,c2ln');
  });
}

test('physical originals and CDs retain postal delivery, address and 20000 surcharge without requiring email',async()=>{
  const f=fixture({fetch:(_url,request)=>Promise.resolve(successResponse(request,{baseAmount:45000}))});f.seedForm();
  f.set('email','');f.run("setDelivery('post')");
  assert.equal(f.elements.get('email').required,false);
  assert.equal(f.run('validateApplicant()'),true);assert.equal(f.run('validateHospitals()'),false);
  f.run('submitForm(true)');assert.equal(f.requests.length,0);
  f.set('postAddress','테스트시 테스트로 1, 원본 수령인');f.set('docEtc_1','영상CD, 진료기록 원본');
  assert.equal(f.run('validateHospitals()'),true);assert.equal(f.run('calcFee().addPost'),20000);
  assert.equal(f.run('calcFee().total'),45000);
  f.run('submitForm(true)');await tick();
  const payload=f.requests[0].payload;
  assert.equal(payload.deliveryMethod,'post');assert.equal(payload.email,'');
  assert.equal(payload.postAddress,'테스트시 테스트로 1, 원본 수령인');
  assert.ok(f.elements.get('successDelivery').textContent.includes('등기'));
  assert.equal(f.elements.get('successFee').textContent,'45,000원');
});

test('switching back from post to email restores required email and does not discard postal address',()=>{
  const f=fixture();f.seedForm();f.set('postAddress','보존할 등기 주소');f.set('email','');
  f.run("setDelivery('post');setDelivery('email')");
  assert.equal(f.elements.get('email').required,true);assert.equal(f.run('validateApplicant()'),false);
  assert.equal(f.run('calcFee().addPost'),0);assert.equal(f.elements.get('postAddress').value,'보존할 등기 주소');
});

test('the two active screens retain application details when moving back and forth',()=>{
  const f=fixture();f.seedForm();
  f.run('goToStep(0);toggleLegalInformation()');
  assert.equal(f.elements.get('legalSection').scrollPosition,'start');
  assert.equal(f.elements.get('homeLegalToggle').getAttribute('aria-expanded'),'true');
  const screens=[...f.elements.values()].filter(el=>el.classList.contains('form-screen'));
  assert.deepEqual(screens.map(el=>el.id).sort(),['screen2','screen4']);
  f.run('goToStep(4);nextStep(4)');
  assert.equal(f.elements.get('screen2').classList.contains('active'),true);
  assert.equal(f.elements.get('screen4').classList.contains('active'),false);
  f.run('goToStep(4)');
  assert.equal(f.elements.get('screen4').classList.contains('active'),true);
  assert.equal(f.elements.get('patientPhone').value,'010-0000-0000');
  assert.equal(f.elements.get('email').value,'test@example.com');
});

test('success uses the server order and fee, and duplicate already-paid states never show deposit instructions',async()=>{
  for(const state of ['waiting_payment','paid','delivered','cancelled']) {
    const f=fixture({fetch:(_url,request)=>Promise.resolve(successResponse(request,{baseAmount:50000,state,duplicate:true}))});
    f.seedForm();f.run('submitForm(true)');await tick();
    assert.equal(f.elements.get('success').classList.contains('show'),true,state);
    assert.equal(f.elements.get('successFee').textContent,'50,000원',state);
    assert.equal(f.elements.get('receiptNum').textContent,f.requests[0].payload.orderId,state);
    assert.equal(f.elements.get('successBank').style.display,state==='waiting_payment'?'':'none',state);
    if(state!=='waiting_payment')assert.ok(!f.elements.get('successIntro').textContent.includes('아래 계좌로'),state);
  }
});

test('mismatched receipt, invalid fee and unsupported state retain the form without showing success',async()=>{
  for(const overrides of [{orderId:'ANOTHER-ORDER'},{receiptNo:''},{baseAmount:'25000'},{baseAmount:0},{state:'unknown'}]) {
    const f=fixture({fetch:(_url,request)=>Promise.resolve(successResponse(request,overrides))});
    f.seedForm();f.run('submitForm(true)');await tick();assertRecovered(f);
    assert.equal(f.run('submissionUncertain'),true);
  }
});

test('default depositor uses applicant when no different payer is selected',async()=>{
  const f=fixture();f.seedForm();
  assert.equal(f.elements.get('diffDepositor').checked,false);
  f.run('submitForm(true)');await tick();
  assert.equal(f.requests[0].payload.depositorName,'홍가람');
  assert.equal(f.alerts.length,0);
  assert.equal(f.elements.get('successDepositor').textContent,'홍가람');
});

test('network failure retains single contact, email, physical-delivery address and signature',async()=>{
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();
  f.set('patientPhone','010-2222-3333');
  f.set('postAddress','보존할 등기 주소');f.run("setDelivery('post');submitForm(true)");await tick();
  assertRecovered(f);assert.equal(f.elements.get('patientPhone').value,'010-2222-3333');
  assert.equal(f.elements.has('sameContact'),false);assert.equal(f.elements.get('postAddress').value,'보존할 등기 주소');
  assert.equal(f.run('deliveryMethod'),'post');
});

test('different payer is sent and receipt validates each echoed name independently',async()=>{
 const f=fixture({fetch:(_url,request)=>Promise.resolve(successResponse(request,{patientName:'홍가람',depositorName:'김입금'}))});f.seedForm();
 f.elements.get('diffDepositor').checked=true;f.set('depositorName','김입금');
 f.run('submitForm()');await tick();
 assert.equal(f.requests[0].payload.patientName,'홍가람');assert.equal(f.requests[0].payload.depositorName,'김입금');
 assert.equal(f.elements.get('successDepositor').textContent,'김입금');assert.equal(f.run('submissionComplete'),true);
});

test('payer edits survive identity updates and unchecked payer uses latest applicant',async()=>{
 const f=fixture();f.seedForm();f.elements.get('diffDepositor').checked=true;f.set('depositorName','김입금');
 f.run("depositorEdited=true;syncIdentityDisplay()");assert.equal(f.elements.get('depositorName').value,'김입금');
 f.elements.get('diffDepositor').checked=false;f.run('toggleDepositor();submitForm()');await tick();
 assert.equal(f.requests[0].payload.depositorName,'홍가람');assert.equal(f.elements.get('depositorName').value,'김입금');
});

test('whole period is default and switching restores a custom period draft',()=>{
 const f=fixture();f.run('buildHospitalBlocks()');
 f.elements.get('periodToggle_1').checked=true;f.run('togglePeriod(1)');f.set('treatPeriod_1','2025.01 ~ 2026.03');
 f.elements.get('periodToggle_1').checked=false;f.run('togglePeriod(1)');assert.equal(f.elements.get('treatPeriod_1').value,'전체 기간');
 f.elements.get('periodToggle_1').checked=true;f.run('togglePeriod(1)');assert.equal(f.elements.get('treatPeriod_1').value,'2025.01 ~ 2026.03');
});

test('confirmed pre-save validation rejection explains correction and preserves photo and signature without requiring inquiry',async()=>{
  const error='생년월일을 실제 날짜로 입력해 주세요.';
  const f=fixture({fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve({ok:false,code:'validation',error})})});
  f.seedForm();f.set('patientBirth','19900231');const photo=f.run('idCardFileObj');
  f.run('submitForm(true)');await tick();assertRecovered(f);
  assert.equal(f.run('idCardFileObj'),photo);assert.equal(f.elements.get('patientBirth').value,'19900231');
  assert.equal(f.run('submissionUncertain'),false);assert.equal(f.run('submissionComplete'),false);
  assert.equal(f.alerts.at(-1),error);assert.ok(!f.alerts.at(-1).includes('문의'));
  assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
});

test('validation failure after an uncertain earlier request retains its order and inquiry warning',async()=>{
  let attempt=0;const error='생년월일을 실제 날짜로 입력해 주세요.';
  const f=fixture({fetch:()=>++attempt===1?Promise.reject(new Error('offline')):Promise.resolve({ok:true,json:()=>Promise.resolve({ok:false,code:'validation',error})})});
  f.seedForm();f.run('submitForm(true)');await tick();
  f.set('patientBirth','19900231');f.run('submitForm(true)');await tick();assertRecovered(f);
  assert.equal(f.run('submissionUncertain'),true);assert.equal(f.requests.length,2);
  assert.equal(f.requests[0].payload.orderId,f.requests[1].payload.orderId);
  assert.ok(f.alerts.at(-1).includes(error));assert.ok(f.alerts.at(-1).includes('문의'));
  assert.ok(f.alerts.at(-1).includes(f.requests[0].payload.orderId));
});

test('two-step flow fixes insurance purpose even if hidden fields change',async()=>{
 const f=fixture();f.seedForm();f.set('reason_1','tampered');f.run('submitForm(true)');await tick();
 assert.equal(f.requests[0].payload.reason,'보험사 제출용');
 assert.equal(f.requests[0].payload.hospitals[0].reason,'보험사 제출용');
 assert.ok(!html.includes('id="screen6"'));
 assert.ok(!html.includes('병원 서류 발급 비용은 별도로 문자 안내'));
});
test('missing identity blocks intake before network submission',async()=>{
 const f=fixture();f.seedForm();['patientName','patientBirth','patientAddress'].forEach(id=>f.set(id,''));
 f.run('submitForm(true)');await tick();assert.equal(f.requests.length,0);assert.match(f.elements.get('field-error').textContent,/신분증/);
});
test('OCR fills fields but preserves typing during recognition',async()=>{
 const f=fixture();f.seedForm();let resolve;
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:new Promise(r=>resolve=r),cancel(){}})};
 f.set('patientName','');f.set('patientBirth','');f.set('patientAddress','');
 f.run('extractIdInfo(()=>{})');f.set('patientName','직접수정');
 resolve({name:'홍길동',birth:'19900101',address:'서울 테스트로 1'});await tick();
 assert.equal(f.elements.get('patientName').value,'직접수정');
 assert.equal(f.elements.get('patientBirth').value,'19900101');
 assert.equal(f.elements.get('patientAddress').value,'서울 테스트로 1');
 assert.equal(f.elements.get('identityNameField').hidden,true);
 assert.equal(f.elements.get('identityResult').hidden,false);

 assert.equal(f.run('idRecognitionBusy'),false);assert.equal(f.requests.length,0);
});
test('cancelled recognition cannot overwrite manual input',async()=>{
 const f=fixture();f.seedForm();let resolve,cancelled=false;
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:new Promise(r=>resolve=r),cancel(){cancelled=true;}})};
 f.run('extractIdInfo(()=>{});cancelIdRecognition()');
 resolve({name:'오래된값',birth:'20000101',address:'오래된주소'});await tick();
 assert.equal(cancelled,true);assert.equal(f.elements.get('patientName').value,'홍가람');
 assert.equal(f.run('idRecognitionBusy'),false);
});

test('manual name entry can cancel slow OCR without bypassing photo, name or signature validation',async()=>{
 const f=fixture();f.seedForm();let resolve,cancelled=0;
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:new Promise(r=>resolve=r),cancel(){cancelled++;}})};
 f.set('patientName','');f.set('patientBirth','');f.set('patientAddress','');
 const photo=f.run('idCardFileObj'),signature=f.run('signaturePad');
 f.run('extractIdInfo(()=>{})');
 assert.equal(f.elements.get('manualIdentityEntry').hidden,false);
 assert.equal(f.elements.get('patientName').disabled,true);
 f.run('enterIdentityNameManually()');
 assert.equal(cancelled,1);assert.equal(f.run('idRecognitionBusy'),false);
 assert.equal(f.elements.get('patientName').disabled,false);
 assert.equal(f.elements.get('identityNameField').hidden,false);
 assert.equal(f.elements.get('patientName').focused,true);
 assert.equal(f.elements.get('manualIdentityEntry').hidden,true);
 assert.equal(f.run('validateApplicant()'),false);
 f.set('patientName','직접입력');
 resolve({name:'늦은인식',birth:'19990101',address:'늦은주소',nameStatus:'agreement'});await tick();
 assert.equal(f.elements.get('patientName').value,'직접입력');
 assert.equal(f.elements.get('patientBirth').value,'');assert.equal(f.elements.get('patientAddress').value,'');
 assert.equal(f.run('idCardFileObj'),photo);assert.equal(f.run('signaturePad'),signature);
 f.run('signaturePad={isEmpty:()=>true}');assert.equal(f.run('validateApplicant()'),false);
 f.context.savedSignature=signature;f.run('signaturePad=savedSignature;idCardFileObj=null');assert.equal(f.run('validateApplicant()'),false);
 f.context.savedPhoto=photo;f.run('idCardFileObj=savedPhoto;submitForm()');await tick();
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].payload.identityReview.source,'manual_reviewed');
 assert.equal(f.requests[0].payload.patientName,'직접입력');
});
test('failed recognition falls back to manual without network submission',async()=>{
 const f=fixture();f.seedForm();
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:Promise.reject(new Error('offline')),cancel(){}})};
 f.run('extractIdInfo(()=>{})');await tick();
 assert.match(f.elements.get('ocrStatus').textContent,/이름을 읽지 못했어요/);assert.equal(f.requests.length,0);assert.equal(f.run('idRecognitionBusy'),false);
});
test('new photo clears old identity, review and signature',()=>{
 const f=fixture();f.seedForm();f.run('signaturePad.clear=()=>{window.cleared=true}');
 f.run('handleUpload({files:[{name:"new.jpg",type:"image/jpeg",size:100}]})');
 assert.equal(f.elements.get('patientName').value,'');assert.equal(f.elements.get('patientBirth').value,'');assert.equal(f.elements.get('patientAddress').value,'');
assert.equal(f.context.window.cleared,true);
});

test('valid signed application submits directly without another confirmation',async()=>{
 const f=fixture();f.seedForm();f.run('submitForm()');
 await tick();assert.equal(f.requests.length,1);assert.equal(f.alerts.length,0);
});
test('a pending photo read retains one snapshot of hospitals, notes, addresses and identity review',async()=>{
  const f=fixture({readMode:'manual'});f.seedForm();f.run('addHospital()');
  f.set('hospital_2','두 번째 병원');f.set('treatPeriod_2','2024');f.set('docEtc_2','영상 CD');
  f.run("hospitalCoords[1]={name:'두 번째 병원',address:'테스트길 2',lat:null,lng:null};identityOcrName='홍가람';identityOcrStatus='agreement';submitForm()");
  f.set('hospital_2','바뀐 병원');f.set('docEtc_2','바뀐 서류');
  f.run("hospitalCoords[1].address='바뀐 주소';identityOcrName='';identityOcrStatus='missing'");
  f.readers.at(-1).onload({target:{result:'data:image/jpeg;base64,dGVzdA=='}});
  await tick();
  const payload=f.requests[0].payload;
  assert.equal(payload.hospitals[1].name,'두 번째 병원');
  assert.equal(payload.hospitalCoords[1].address,'테스트길 2');
  assert.equal(payload.extraNote,'[추가 병원 정보]\n2번째: 두 번째 병원 / 2024 / 영상 CD');
  assert.equal(payload.identityReview.source,'ocr_reviewed');
  assert.equal(payload.identityReview.ocrStatus,'agreement');
});

test('ten hospitals keep all requested documents when the legacy summary exceeds 3000 characters',async()=>{
  const f=fixture();f.seedForm();
  const documents='서류'.repeat(250);
  for(let i=2;i<=10;i++){
    f.run('addHospital()');
    f.set('hospital_'+i,'테스트 병원 '+i);f.set('treatPeriod_'+i,'전체 기간');f.set('docEtc_'+i,documents);
    f.run('hospitalCoords['+(i-1)+']={name:"테스트 병원",address:"테스트 주소",lat:null,lng:null}');
  }
  f.run('submitForm()');await tick();
  const {hospitals,extraNote}=f.requests[0].payload;
  assert.equal(hospitals.length,10);
  assert.ok(hospitals.slice(1).every(hospital=>hospital.documents[0]===documents));
  assert.ok(extraNote.length<=3000);assert.match(extraNote,/9곳/);
});
test('manual hospital entry is available during lookup and survives a late provider response',async()=>{
  let resolveLookup;
  const f=fixture({fetch:()=>new Promise(resolve=>{resolveLookup=resolve})});
  f.seedForm();f.run("searchHospital('테스트 병원',1)");await tick();
  const drop=f.elements.get('hospDrop_1'),manual=drop.children.at(-1);
  assert.equal(manual.tagName,'BUTTON');assert.match(manual.textContent,/직접 입력/);
  manual.onclick();f.set('hospAddr_1','직접 입력한 주소');f.run('updateManualHospitalAddress(1)');
  resolveLookup({ok:true,json:async()=>({ok:true,places:[{name:'기타 병원',address:'다른 주소'}]})});
  await tick();
  assert.equal(drop.classList.contains('show'),false);
  assert.ok(!drop.textContent.includes('기타 병원'));
  assert.equal(f.run('hospitalCoords[0].address'),'직접 입력한 주소');
});

test('OCR reads the original upload while the request keeps the smaller copy',async()=>{
 const f=fixture();let seen;
 f.context.window.SeoryuIdOCR={recognize:file=>{seen=file;return {promise:Promise.resolve({name:'홍가람',birth:'19900101',address:'검증 주소',nameStatus:'agreement'}),cancel(){}};}};
 const original=f.file('original-phone-photo.jpg');f.context.uploadInput=f.input(original);
 f.run('handleUpload(uploadInput)');f.loadImage(4000,3000);f.blobs[0]({size:80});await tick();
 assert.equal(seen,original);assert.equal(f.run('idCardOcrFileObj'),original);
 assert.equal(f.run('idCardFileObj.name'),'id_resized.jpg');assert.equal(f.run('idRecognitionBusy'),false);
 assert.equal(f.elements.get('patientName').value,'홍가람');
});

test('uploads keep decodable small JPEG and PNG; unsupported encodings and oversized files convert without upscaling',()=>{
  const jpeg='data:image/jpeg;base64,/9j/fixture';
  const png='data:image/png;base64,iVBORw0KGgofixture';
  for(const [type,size,source,convert] of [
    ['image/jpeg',100,jpeg,false],
    ['image/png',100,png,false],
    ['image/webp',100,'data:image/webp;base64,UklGRg==',true],
    ['image/png',4*1024*1024+1,png,true],
    ['image/jpeg',100,'data:image/jpeg;base64,iVBORw0KGgo',true]
  ]){
    const f=fixture({readMode:'manual'});
    const original={name:'photo',type,size};
    const create=f.context.document.createElement;
    let canvas;
    f.context.document.createElement=tag=>{
      const el=create(tag);if(tag==='canvas')canvas=el;return el;
    };
    f.context.uploadInput=f.input(original);f.run('handleUpload(uploadInput)');
    f.readers[0].onload({target:{result:source}});f.loadImage(800,600);
    if(convert){
      assert.equal(canvas.width,800);assert.equal(canvas.height,600);
      f.blobs[0]({size:200});
      assert.equal(f.run('idCardFileObj.type'),'image/jpeg');
    }else{
      assert.equal(canvas,undefined);assert.equal(f.run('idCardFileObj'),original);
    }
    assert.equal(f.run('idCardOcrFileObj'),original);
  }
});

test('changing a hospital name closes the previous results and invalidates its manual address',()=>{
 const f=fixture();f.seedForm();
 f.run('manualInput(1)');f.set('hospAddr_1','서울특별시 테스트로 7');f.run('updateManualHospitalAddress(1)');
 f.elements.get('hospDrop_1').classList.add('show');
 f.set('hospital_1','두 번째 병원');f.run('onHospInput(1)');
 assert.equal(f.elements.get('hospDrop_1').classList.contains('show'),false);
 assert.equal(f.elements.get('hospManualAddr_1').style.display,'none');
 assert.equal(f.elements.get('hospAddr_1').value,'');
 assert.equal(f.run('hospitalCoords[0]'),null);
});

test('a delayed lookup for an old query cannot replace the current hospital results',async()=>{
 let pending;
 const f=fixture({fetch:()=>new Promise(resolve=>{pending=resolve})});f.seedForm();
 f.run("searchHospital('테스트 병원',1)");await tick();
 f.set('hospital_1','다른 병원');f.run('onHospInput(1)');
 pending({ok:true,json:()=>Promise.resolve({ok:true,places:[{name:'테스트 병원',address:'서울특별시 테스트로 1'}]})});
 await tick();
 assert.equal(f.elements.get('hospDrop_1').classList.contains('show'),false);
 assert.equal(f.run('hospitalCoords[0]'),null);
});

test('a missing signature library is explained without permitting an unsigned submission',()=>{
 const f=fixture();f.seedForm();f.context.SignaturePad=undefined;
 f.run('signaturePad=null;initSig()');
 assert.match(f.elements.get('signatureHint').textContent,/서명 기능을 불러오지 못했어요/);
 assert.equal(f.run('validateApplicant()'),false);
 assert.equal(f.requests.length,0);
});

test('the hospital limit is visible and the add button is restored after removal',()=>{
 const f=fixture();f.seedForm();f.run('for(let i=2;i<=10;i++) addHospital()');
 assert.equal(f.elements.get('addHospitalButton').disabled,true);
 assert.equal(f.elements.get('addHospitalPrice').textContent,'최대 10곳');
 f.run('removeHospital(10)');
 assert.equal(f.elements.get('addHospitalButton').disabled,false);
 assert.equal(f.elements.get('addHospitalPrice').textContent,'+25,000원');
});

test('the account-copy label resets normally even after two successful clicks',async()=>{
 const f=fixture({navigator:{clipboard:{writeText:()=>Promise.resolve()}}});
 const button=f.elements.get('addHospitalButton');button.textContent='계좌번호 복사';f.context.copyButton=button;
 f.run('copyIntakeAccount(copyButton)');await tick();
 f.run('copyIntakeAccount(copyButton)');await tick();
 assert.equal(button.textContent,'복사했어요 ✓');
 const active=[...f.timers.values()].filter(timer=>timer.delay===2000);
 assert.equal(active.length,1);active[0].callback();
 assert.equal(button.textContent,'계좌번호 복사');
});
