'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parse}=require('../id-ocr.js');
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
