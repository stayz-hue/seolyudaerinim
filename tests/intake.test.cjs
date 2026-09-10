'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
const tick = () => new Promise(resolve => setImmediate(resolve));

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
    focus() { this.focused = true; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    getBoundingClientRect() { return {width:320, height:200}; }
    getContext() { return {drawImage() {}, scale() {}}; }
    toBlob(callback) { blobs.push(callback); }
  }
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]); node.id = match[3];
    const klass = match[2].match(/\bclass="([^"]*)"/); if (klass) node.className = klass[1];
  }
  const buttons = [new Element('button'), new Element('button')];
  const document = {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelectorAll: selector => selector === '.btn-next.submit' ? buttons : [],
    addEventListener() {}, body: new Element('body')
  };
  const context = vm.createContext({
    document, window:{scrollTo() {}, devicePixelRatio:1}, navigator:options.navigator || {},
    console, URLSearchParams, AbortController,
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
    Image: class { constructor() { images.push(this); } set src(value) { this.source = value; } },
    SignaturePad: class { constructor() { throw new Error('Existing signature must not be replaced'); } },
    fetch: (url, request) => {
      requests.push({url, request, payload: request?.body ? JSON.parse(request.body) : undefined});
      return options.fetch ? options.fetch(url, request) : Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true})});
    }
  });
  for (const script of scripts) vm.runInContext(script, context);
  function run(code) { return vm.runInContext(code, context); }
  function set(id, value) { elements.get(id).value = value; }
  function seedForm() {
    run('buildHospitalBlocks()');
    set('patientName', '테스트 신청인'); set('patientBirth', '19900101');
    set('patientPhone', '010-0000-0000'); set('patientAddress', '테스트 주소');
    set('hospital_1', '테스트 병원'); set('treatPeriod_1', '2025'); set('reason_1', '보험사 제출'); set('docEtc_1', '진료기록');
    set('depositorName', '');
    elements.get('sameDepositor').checked = true;
    elements.get('screen6').classList.add('active');
    run("idCardFileObj = {name:'test.jpg',type:'image/jpeg',size:100}; signaturePad={isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c2ln'}; currentStep=6; hospitalCoords=[{name:'테스트 병원',address:'병원 주소',lat:1,lng:2}]");
  }
  return {context, run, set, elements, htmlWrites, alerts, confirms, requests, readers, images, blobs, timers, buttons, prompts,
    seedForm, setReadMode(value) { readMode = value; },
    file(name = 'test.jpg') { return {name, type:'image/jpeg', size:100}; },
    input(file) { return {files:[file], value:'selected'}; },
    loadImage(width=100,height=100,index=images.length-1) { const img = images[index]; img.naturalWidth=width;img.naturalHeight=height;img.onload(); }
  };
}

function assertRecovered(f) {
  assert.equal(f.elements.get('loading').classList.contains('show'), false);
  assert.equal(f.elements.get('success').classList.contains('show'), false);
  assert.equal(f.elements.get('screen6').classList.contains('active'), true);
  assert.equal(f.elements.get('patientName').value, '테스트 신청인');
  assert.equal(f.run('signaturePad.toDataURL()'), 'data:image/png;base64,c2ln');
  assert.equal(f.run('submissionBusy'), false);
  assert.ok(f.buttons.every(button => !button.disabled));
}

test('all inline scripts parse; explicit success displays a stable order number and blocks later submissions', async () => {
  scripts.forEach(script => new vm.Script(script));
  const f = fixture(); f.seedForm(); f.run('submitForm()'); await tick();
  assert.equal(f.elements.get('success').classList.contains('show'), true);
  assert.equal(f.elements.get('receiptNum').textContent, f.requests[0].payload.orderId);
  f.run('submitForm()'); assert.equal(f.requests.length,1);
});

for (const [label, fetch] of [
  ['server rejection', () => Promise.resolve({ok:true,json:()=>Promise.resolve({ok:false,error:'secret server details'})})],
  ['missing explicit success', () => Promise.resolve({ok:true,json:()=>Promise.resolve({receiptNo:'unexpected'})})],
  ['HTTP failure', () => Promise.resolve({ok:false,json:()=>Promise.resolve({ok:true})})],
  ['invalid JSON', () => Promise.resolve({ok:true,json:()=>Promise.reject(new Error('private response'))})],
  ['network loss', () => Promise.reject(new Error('private response'))],
  ['synchronous fetch exception', () => { throw new Error('private response'); }]
]) {
  test(label + ' preserves input and signature, shows uncertainty and does not automatically retry', async () => {
    const f=fixture({fetch}); f.seedForm(); f.run('submitForm()'); await tick(); assertRecovered(f);
    assert.equal(f.requests.length,1); assert.equal(f.run('submissionUncertain'),true);
    assert.ok(f.alerts[0].includes(f.requests[0].payload.orderId));
    assert.ok(!f.alerts.join('').includes('private') && !f.alerts.join('').includes('secret'));
    assert.equal(f.timers.size,0);
  });
}

test('request timeout recovers as uncertain without another request', async () => {
  const f=fixture({fetch:(url,request)=>new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('timeout'))))});
  f.seedForm();f.run('submitForm()');
  [...f.timers.values()].find(timer=>timer.delay===45000).callback();await tick();assertRecovered(f);
  assert.equal(f.requests.length,1);assert.equal(f.run('submissionUncertain'),true);
});

test('double click while waiting emits only one request', async () => {
  let resolve;
  const f=fixture({fetch:()=>new Promise(done=>{resolve=done})}); f.seedForm();f.run('submitForm();submitForm()');
  assert.equal(f.requests.length,1);assert.ok(f.buttons.every(button=>button.disabled));
  resolve({ok:true,json:()=>Promise.resolve({ok:true,receiptNo:'SERVER-RECEIPT'})});await tick();
  assert.equal(f.elements.get('receiptNum').textContent,'SERVER-RECEIPT');
});

test('manual retry warns about duplicates and keeps the original order number', async () => {
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm()');await tick();
  f.run('submitForm()');await tick();
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].payload.orderId,f.requests[1].payload.orderId);
  assert.equal(f.confirms.length,1);
});

test('declining uncertain retry leaves the original request untouched', async () => {
  const f=fixture({confirm:false,fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm()');await tick();
  f.run('submitForm()');assert.equal(f.requests.length,1);
});

for(const readMode of ['error','abort','throw']) {
  test('file read '+readMode+' restores the form without sending',()=>{
    const f=fixture({readMode});f.seedForm();f.run('submitForm()');assertRecovered(f);
    assert.equal(f.requests.length,0);assert.equal(f.run('submissionUncertain'),false);
    assert.ok(f.alerts[0].includes('전송하지 않았어'));
  });
}

test('a read failure on uncertain retry does not erase uncertainty about the previous request',async()=>{
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm()');await tick();
  f.setReadMode('error');f.run('submitForm()');assert.equal(f.run('submissionUncertain'),true);assert.equal(f.requests.length,1);
});

test('returning to the signature step preserves the existing pad',()=>{
  const f=fixture();f.seedForm();const before=f.run('signaturePad');f.run('initSig()');assert.equal(f.run('signaturePad'),before);
});

test('a broken replacement image clears acceptance and cannot pass validation',()=>{
  const f=fixture({readMode:'manual'});f.seedForm();const input=f.input(f.file());f.context.uploadInput=input;
  f.run('handleUpload(uploadInput)');assert.equal(f.run('idCardFileObj'),null);assert.equal(f.run('validate(5)'),false);
  f.readers[0].onload({target:{result:'data:image/jpeg;base64,broken'}});f.images[0].onerror();
  assert.equal(f.run('validate(5)'),false);assert.equal(f.run('idCardLoading'),false);assert.equal(input.value,'');
});

test('late resize for old selection cannot replace the latest uploaded file',()=>{
  const f=fixture({readMode:'manual'});f.context.first=f.input(f.file('first.jpg'));f.context.second=f.input(f.file('second.jpg'));
  f.run('handleUpload(first)');f.readers[0].onload({target:{result:'first'}});f.loadImage(2400,1800);
  assert.equal(f.run('idCardLoading'),true);
  f.run('handleUpload(second)');f.readers[1].onload({target:{result:'second'}});f.loadImage();
  f.blobs[0]({size:80});assert.equal(f.run('idCardFileObj.name'),'second.jpg');assert.equal(f.run('validate(5)'),true);
});

test('late decode failure for old selection cannot clear a newer valid image',()=>{
  const f=fixture({readMode:'manual'});f.context.first=f.input(f.file('first.jpg'));f.context.second=f.input(f.file('second.jpg'));
  f.run('handleUpload(first)');f.readers[0].onload({target:{result:'first'}});
  f.run('handleUpload(second)');f.readers[1].onload({target:{result:'second'}});f.loadImage();f.images[0].onerror();
  assert.equal(f.run('idCardFileObj.name'),'second.jpg');assert.equal(f.alerts.length,0);
});

test('resize failure leaves no accepted file',()=>{
  const f=fixture();f.context.input=f.input(f.file());f.run('handleUpload(input)');f.loadImage(2400,1800);f.blobs[0](null);
  assert.equal(f.run('idCardFileObj'),null);assert.equal(f.run('validate(5)'),false);
});

test('removing a middle hospital preserves later fields, coordinates and urgency; one hospital remains minimum',()=>{
  const f=fixture();f.seedForm();f.run('addHospital();addHospital()');
  for(let i=1;i<=3;i++)for(const prefix of ['hospital_','treatPeriod_','reason_','docEtc_','hospAddr_'])f.set(prefix+i,prefix+i);
  f.run("hospitalCoords=[{name:'one'},{name:'two'},{name:'three',manual:true}];urgentFlags=[false,true,true]");
  f.elements.get('hospBadge_3').textContent='세번째 주소';f.elements.get('hospManualAddr_3').style.display='block';
  assert.ok(f.run('hospitalBlockHTML(2)').includes('removeHospital(2)'));
  f.run('removeHospital(2)');
  assert.equal(f.run('hospitalCount'),2);
  for(const prefix of ['hospital_','treatPeriod_','reason_','docEtc_','hospAddr_'])assert.equal(f.elements.get(prefix+'2').value,prefix+'3');
  assert.equal(f.run('hospitalCoords[1].name'),'three');assert.equal(f.run('urgentFlags[1]'),true);
  assert.equal(f.elements.get('hospBadge_2').textContent,'세번째 주소');assert.equal(f.elements.get('hospManualAddr_2').style.display,'block');
  f.run('removeHospital(2);removeHospital(1)');assert.equal(f.run('hospitalCount'),1);assert.equal(f.elements.get('hospital_1').value,'hospital_1');
});

test('an address response for a deleted hospital cannot modify the replacement at that index',async()=>{
  let resolve;const f=fixture({fetch:()=>new Promise(done=>{resolve=done})});f.seedForm();f.run('addHospital();addHospital()');
  f.set('hospAddr_2','삭제할 주소');f.run("hospitalCoords=[{name:'one'},{name:'two'},{name:'three',address:'보존할 주소'}];geocodeAddress(2);removeHospital(2)");
  resolve({json:()=>Promise.resolve({ok:true,lat:99,lng:99,address:'늦은 이전 응답'})});await tick();
  assert.equal(f.run('hospitalCoords[1].address'),'보존할 주소');
});

test('confirmation renders customer-entered HTML as plain text',()=>{
  const f=fixture();f.seedForm();const attack='<img src=x onerror="alert(1)">';
  for(const prefix of ['hospital_','treatPeriod_','reason_','docEtc_'])f.set(prefix+'1',attack);
  f.context.attack=attack;f.run('hospitalCoords[0].address=attack;fillConfirm()');
  assert.ok(f.elements.get('cf-hospitals').textContent.includes(attack));
  assert.ok(!f.htmlWrites.some(value=>value.includes(attack)));
});

test('account copy offers a manual fallback when clipboard is unavailable',()=>{
  const f=fixture();f.elements.get('successAccount').textContent='123-456';f.run('copyIntakeAccount()');
  assert.equal(f.prompts[0][1],'123456');
});
