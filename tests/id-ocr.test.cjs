'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ocr=require('../id-ocr.js');
const parse=text=>{const {name,birth,address}=ocr.parse(text);return {name,birth,address};};
test('reads synthetic resident card and excludes issuer and issue date',()=>{
  assert.deepEqual(parse('주민등록증\n홍길동 (洪吉童)\n900101-1******\n서울특별시 중구 테스트로 123\n101동 202호\n2020. 1. 1.\n서울특별시 중구청장'),{name:'홍길동',birth:'19900101',address:'서울특별시 중구 테스트로 123 101동 202호'});
});
test('reads labeled fields and 2000s birth',()=>{
  const p=parse('운전면허증\n성명: 김테스트\n010203-4******\n주소: 경기도 수원시 테스트로 12\n2024. 1. 1.');
  assert.equal(p.name,'김테스트');assert.equal(p.birth,'20010203');assert.equal(p.address,'경기도 수원시 테스트로 12');
});
test('fully masked century is not guessed',()=>assert.equal(parse('900101-*******').birth,''));
test('invalid birth is not populated',()=>assert.equal(parse('990230-1******').birth,''));
test('explicit labeled birth works without resident number',()=>assert.equal(parse('생년월일: 1990. 1. 2.').birth,'19900102'));
test('ambiguous name is left for review',()=>assert.equal(parse('주민등록증\n홍길동\n김철수').name,''));
test('blank or unrelated text produces no fabricated identity',()=>assert.deepEqual(parse('random unreadable image'),{name:'',birth:'',address:''}));

for(const correctAngle of [0,90,180,270]) test('rotation retry finds synthetic identity at '+correctAngle+' degrees',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const calls=[];let closed=0,terminated=0;
 const worker={setParameters:async()=>{},terminate:async()=>{terminated++;},recognize:async image=>{
  const angle=image.angle||0;calls.push(angle);
  return {data:{text:angle===correctAngle?'주민등록증\n홍길동\n900101-1******\n서울특별시 테스트로 1\n2020. 1. 1.':'unreadable'}};
 }};
 const ctx={module:{exports:{}},setTimeout,clearTimeout,Tesseract:{createWorker:async()=>worker},
 createImageBitmap:async()=>({width:120,height:80,close(){closed++;}}),
 document:{createElement(){const c={};c.getContext=()=>({translate(){},rotate(r){c.angle=Math.round(r*180/Math.PI);},drawImage(){}});return c;}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../id-ocr.js'),'utf8'),ctx);
 const result=await ctx.module.exports.recognize({}).promise;
 assert.equal(result.name,'홍길동');assert.equal(result.birth,'19900101');
 assert.equal(calls.at(-1),correctAngle);assert.equal(terminated,1);assert.equal(closed,correctAngle?1:0);
});
