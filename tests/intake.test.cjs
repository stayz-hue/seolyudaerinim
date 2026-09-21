'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
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
    focus() { this.focused = true; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    getBoundingClientRect() { return {width:320, height:200}; }
    getContext() { return {drawImage() {}, scale() {}}; }
    toBlob(callback) { blobs.push(callback); }
  }
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]); node.id = match[3];
    const klass = match[2].match(/\bclass="([^"]*)"/); if (klass) node.className = klass[1];
    node.checked = /\bchecked\b/.test(match[2]);
    node.required = /\brequired\b/.test(match[2]);
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
      return options.fetch ? options.fetch(url, request) : Promise.resolve(successResponse(request));
    }
  });
  for (const script of scripts) vm.runInContext(script, context);
  function run(code) { return vm.runInContext(code, context); }
  function set(id, value) { elements.get(id).value = value; }
  function seedForm() {
    run('buildHospitalBlocks()');
    set('patientName', '테스트 신청인'); set('patientBirth', '19900101');
    set('patientPhone', '010-0000-0000'); set('patientAddress', '테스트 주소');
    set('email', 'test@example.com');
    set('hospital_1', '테스트 병원'); set('treatPeriod_1', '2025'); set('reason_1', '보험사 제출'); set('docEtc_1', '진료기록');

    elements.get('screen2').classList.add('active');
    run("idCardFileObj = {name:'test.jpg',type:'image/jpeg',size:100}; signaturePad={isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,c2ln'}; currentStep=2; hospitalCoords=[{name:'테스트 병원',address:'병원 주소',lat:1,lng:2}]");
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
  assert.equal(f.elements.get('screen2').classList.contains('active'), true);
  assert.equal(f.elements.get('patientName').value, '테스트 신청인');
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
    assert.ok(f.alerts.at(-1).includes('전송하지 않았어'));
  });
}

test('a read failure on uncertain retry does not erase uncertainty about the previous request',async()=>{
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();f.run('submitForm(true)');await tick();
  f.setReadMode('error');f.run('submitForm(true)');assert.equal(f.run('submissionUncertain'),true);assert.equal(f.requests.length,1);
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
    assert.equal(f.run('validate(2)'),false,email);f.run('submitForm(true)');
    assert.equal(f.requests.length,0,email);assert.equal(f.run('submissionBusy'),false,email);
    assert.equal(f.elements.get('email').value,email);assert.equal(f.run('signaturePad.toDataURL()'),'data:image/png;base64,c2ln');
  }
});

test('SMS contact validation rejects empty, landline, short and letter-containing numbers',()=>{
  for(const phone of ['', '02-123-4567','010-1234','abc01012345678']) {
    const f=fixture();f.seedForm();f.set('patientPhone',phone);
    assert.equal(f.run('validate(2)'),false,phone);f.run('submitForm(true)');assert.equal(f.requests.length,0,phone);
    assert.equal(f.elements.get('patientPhone').value,phone);
  }
});

for (const email of ['a..b@example.com', 'a@-host.com', 'a@b..com']) {
  test('email validation matches delivery rejection for ' + email,()=>{
    const f=fixture();f.seedForm();f.set('email',email);
    assert.equal(f.run('validate(2)'),false);
    f.run('submitForm(true)');assert.equal(f.requests.length,0);
    assert.equal(f.elements.get('email').value,email);
    assert.equal(f.run('signaturePad.toDataURL()'),'data:image/png;base64,c2ln');
  });
}

test('physical originals and CDs retain postal delivery, address and 20000 surcharge without requiring email',async()=>{
  const f=fixture({fetch:(_url,request)=>Promise.resolve(successResponse(request,{baseAmount:45000}))});f.seedForm();
  f.set('email','');f.run("setDelivery('post')");
  assert.equal(f.elements.get('email').required,false);
  assert.equal(f.run('validate(2)'),true);assert.equal(f.run('validate(4)'),false);
  f.run('submitForm(true)');assert.equal(f.requests.length,0);
  f.set('postAddress','테스트시 테스트로 1, 원본 수령인');f.set('docEtc_1','영상CD, 진료기록 원본');
  assert.equal(f.run('validate(4)'),true);assert.equal(f.run('calcFee().addPost'),20000);
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
  assert.equal(f.elements.get('email').required,true);assert.equal(f.run('validate(2)'),false);
  assert.equal(f.run('calcFee().addPost'),0);assert.equal(f.elements.get('postAddress').value,'보존할 등기 주소');
});

test('signature step and confirmation show email and contact as plain text without adding a new step',()=>{
  const f=fixture();f.seedForm();const attack='<img src=x onerror="alert(1)">';
  f.set('patientPhone',attack);f.set('email',attack);
  f.run('goToStep(6);fillConfirm()');
  for(const id of ['cf-contact','cf-email'])assert.equal(f.elements.get(id).textContent,attack);
  assert.ok(!f.htmlWrites.some(value=>value.includes(attack)));
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

test('depositor is always applicant and a reminder precedes submission',async()=>{
  const f=fixture();f.seedForm();
  assert.equal(f.elements.has('depositorName'),false);
  assert.equal(f.elements.has('diffDepositor'),false);
  f.run('submitForm(true)');await tick();
  assert.equal(f.requests[0].payload.depositorName,'테스트 신청인');
  assert.equal(f.alerts.length,0);
  assert.equal(f.elements.get('successDepositor').textContent,'테스트 신청인');
});

test('network failure retains single contact, email, physical-delivery address and signature',async()=>{
  const f=fixture({fetch:()=>Promise.reject(new Error('offline'))});f.seedForm();
  f.set('patientPhone','010-2222-3333');
  f.set('postAddress','보존할 등기 주소');f.run("setDelivery('post');submitForm(true)");await tick();
  assertRecovered(f);assert.equal(f.elements.get('patientPhone').value,'010-2222-3333');
  assert.equal(f.elements.has('sameContact'),false);assert.equal(f.elements.get('postAddress').value,'보존할 등기 주소');
  assert.equal(f.run('deliveryMethod'),'post');
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
test('missing identity does not block intake and is sent as blank',async()=>{
 const f=fixture();f.seedForm();['patientName','patientBirth','patientAddress'].forEach(id=>f.set(id,''));
 f.run('submitForm(true)');await tick();assert.equal(f.requests.length,1);
 const body=f.requests[0].payload;assert.equal(body.patientName,'');assert.equal(body.patientBirth,'');assert.equal(body.patientAddress,'');
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

 assert.equal(f.run('idRecognitionBusy'),false);assert.equal(f.requests.length,0);
});
test('cancelled recognition cannot overwrite manual input',async()=>{
 const f=fixture();f.seedForm();let resolve,cancelled=false;
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:new Promise(r=>resolve=r),cancel(){cancelled=true;}})};
 f.run('extractIdInfo(()=>{});cancelIdRecognition()');
 resolve({name:'오래된값',birth:'20000101',address:'오래된주소'});await tick();
 assert.equal(cancelled,true);assert.equal(f.elements.get('patientName').value,'테스트 신청인');
 assert.equal(f.run('idRecognitionBusy'),false);
});
test('failed recognition falls back to manual without network submission',async()=>{
 const f=fixture();f.seedForm();
 f.context.window.SeoryuIdOCR={recognize:()=>({promise:Promise.reject(new Error('offline')),cancel(){}})};
 f.run('extractIdInfo(()=>{})');await tick();
 assert.match(f.elements.get('ocrStatus').textContent,/사진 첨부 완료/);assert.equal(f.requests.length,0);assert.equal(f.run('idRecognitionBusy'),false);
});
test('new photo clears old identity, review and signature',()=>{
 const f=fixture();f.seedForm();f.run('signaturePad.clear=()=>{window.cleared=true}');
 f.run('handleUpload({files:[{name:"new.jpg",type:"image/jpeg",size:100}]})');
 assert.equal(f.elements.get('patientName').value,'');assert.equal(f.elements.get('patientBirth').value,'');assert.equal(f.elements.get('patientAddress').value,'');
assert.equal(f.context.window.cleared,true);
});

test('deposit warning shares diagnosis sheet and sends only after confirmation',async()=>{
 const f=fixture();f.seedForm();f.run('submitForm()');
 assert.equal(f.requests.length,0);assert.equal(f.alerts.length,0);
 assert.match(f.elements.get('warningModalTitle').textContent,/입금자명/);
 assert.equal(f.elements.get('warningModalDetail').textContent,'테스트 신청인');
 f.run('confirmWarning()');
 for(const timer of [...f.timers.values()])if(timer.delay===100)timer.callback();
 await tick();assert.equal(f.requests.length,1);
});
test('closing warning sends nothing and diagnosis text resets on reuse',()=>{
 const f=fixture();f.seedForm();f.run('submitForm();closeWarningModal();confirmWarning()');
 for(const timer of [...f.timers.values()])if(timer.delay===100)timer.callback();
 assert.equal(f.requests.length,0);
 f.run('openWarningModal(()=>{})');assert.match(f.elements.get('warningModalTitle').textContent,/진단서/);
 assert.equal(f.elements.get('warningModalDetail').style.display,'none');
});
