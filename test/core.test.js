import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, candidate, quote, searchData, stay } from './helpers.js';
import { schema } from '../src/config.js';
import { amount, parseCandidates, matches, reserveUrl, delayMs, retryAfter, sha256 } from '../src/domain.js';
import { queryRange, rankAlternatives, alternateFilter } from '../src/alternatives.js';
import { verifyQuote } from '../src/quote.js';
import { State } from '../src/state.js';
import { DReserveSearch } from '../src/search.js';
import { safeError } from '../src/runner.js';
import { trustedPaymentUrl, urlMatches } from '../src/fields.js';
import { cancellationEstimate,assertFreeCancellation } from '../src/cancellation.js';
import { runtimeDirectory } from '../src/config.js';

test('七天范围跨月并保留连续住宿晚数；重叠目标去重',()=>{
  const c=config({stays:[{checkIn:'2027-04-03',checkOut:'2027-04-05'}],alternatives:{enabled:true}});
  const ranges=queryRange(c);
  assert.equal(ranges.length,7);
  assert.equal(ranges[0].stay.checkIn,'2027-04-03');
  assert.deepEqual(ranges.find(x=>x.offset===-3).stay,{checkIn:'2027-03-31',checkOut:'2027-04-02'});
  assert.ok(ranges.every(x=>x.nights===2));
  c.stays.push({checkIn:'2027-04-04',checkOut:'2027-04-06'});
  const merged=queryRange(c);
  assert.equal(merged.length,8);
  assert.equal(merged.filter(x=>x.primary).length,2);
});
test('备选可展示超预算房型但标记不可自动订；保留排除条件和日期距离排序',()=>{
  const c=config({filters:{roomCodes:['RM00010240'],planCodes:['PL00028608'],excludedKeywords:['レディース'],maxTotalJpy:90000,extraTaxBudgetJpy:300}});
  const f=alternateFilter(c);
  assert.deepEqual(f.roomCodes,[]);assert.deepEqual(f.planCodes,[]);
  assert.equal(matches({...candidate,roomCode:'RMOTHER',totalJpy:89800},f),true);
  assert.equal(matches({...candidate,planName:'レディース'},f),false);
  const ranked=rankAlternatives([{...candidate,offset:3,totalJpy:50000},{...candidate,offset:-1},{...candidate,offset:1,roomCode:'RMOTHER',totalJpy:70000}],c);
  assert.equal(ranked[0].roomCode,candidate.roomCode);assert.equal(ranked.at(-1).offset,3);
  assert.equal(rankAlternatives([{...candidate,totalJpy:89800,offset:0}],c)[0].withinBudget,false);
  c.alternatives.includeOverBudget=false;assert.equal(matches({...candidate,totalJpy:89800},alternateFilter(c)),false);
});
test('只使用正数整数的合计价，不使用人均起价或零价',()=>{
  const d=searchData();assert.equal(parseCandidates(d,stay)[0].totalJpy,85800);
  for(const v of ['0','85,80','85,800円','85800.50',-1,0,NaN])assert.equal(amount(v),null);
  d.planDetailResources[0].roomSearchResults[0].planPrice='0';assert.deepEqual(parseCandidates(d,stay),[]);
  d.planDetailResources[0].roomSearchResults[0].planPrice='85,800';d.planDetailResources[0].memberLimit='1';assert.deepEqual(parseCandidates(d,stay),[]);
});
test('预约 URL 使用实际房型、计划、人数和入住天数',()=>{
  const u=new URL(reserveUrl(candidate,config().guests));
  assert.equal(u.searchParams.get('pl'),'PL00028608');assert.equal(u.searchParams.get('lnum001'),'2_0_0_0_0_0');
  assert.equal(u.searchParams.get('ci'),'20270103');assert.equal(u.searchParams.get('stay'),'1');
});
test('配置拒绝非法日期、错误人数和未审阅的自动提交',()=>{
  const base=config();assert.equal(base.poll.intervalSeconds,120);assert.equal(base.checkout.guestEnv.email,'GUEST_EMAIL');
  assert.equal(schema.safeParse({...base,stays:[{checkIn:'2027-02-30',checkOut:'2027-03-02'}]}).success,false);
  assert.equal(schema.safeParse({...base,checkout:{...base.checkout,mode:'auto'}}).success,false);
  assert.equal(schema.safeParse({...base,checkout:{...base.checkout,mode:'prepare',gender:'MALE',transport:'公共交通機関',genderCounts:{adults:{male:1,female:0,other:0}}}}).success,false);
});
test('报价逐一验证身份、金额、人数、库存、附加项和必填问题',()=>{
  const c=config();c.checkout.mode='auto';assert.equal(verifyQuote(quote(),candidate,c).policySha256,sha256('TEST cancellation policy'));
  const cases=[
    [d=>d.candidateSet.hotelCode='OTHER','QUOTE_IDENTITY_MISMATCH'],
    [d=>d.candidateSet.reservations[0].checkInDate='2027-01-04','QUOTE_IDENTITY_MISMATCH'],
    [d=>d.candidateSet.reservations[0].roomTypes[0].roomTypeCode='RMOTHER','QUOTE_IDENTITY_MISMATCH'],
    [d=>d.candidateSet.grandTotalCharge=90000,'QUOTE_PRICE_CHANGED'],
    [d=>d.candidateSet.reservations[0].roomTypes[0].rooms[0].lodgerTypeGenderBreakdowns[0].numberOfLodgers=3,'QUOTE_GUEST_MISMATCH'],
    [d=>d.conflictExceptionsForCandidates=[{status:409}],'INVENTORY_OR_QUOTE_CONFLICT'],
    [d=>d.candidateSet.reservations[0].options=[{}],'UNEXPECTED_EXTRAS'],
    [d=>d.candidateSet.reservations[0].questionForms.push({required:true,code:999}),'HOTEL_QUESTIONS_CHANGED'],
    [d=>d.candidateSet.paymentMethods[0].disabled=true,'UNSUPPORTED_PAYMENT_AGENT'],
  ];
  for(const [change,code] of cases){const d=quote();change(d);assert.throws(()=>verifyQuote(d,candidate,c),new RegExp(code));}
  c.filters.maxTotalJpy=85800;assert.throws(()=>verifyQuote(quote(),candidate,c),/PRICE_LIMIT/);
});
test('同引擎酒店配置改变 URL、报价身份和持久状态，拒绝混用',async()=>{
  const c=config({hotel:{engine:'d-reserve',code:'0000001223',name:'Kariyushi',lodgerTypeCodes:[0],questions:[]}});
  const other={...candidate,hotelCode:c.hotel.code};
  const u=new URL(reserveUrl(other,c.guests,c.hotel));
  assert.equal(u.searchParams.get('hotelCode'),'0000001223');assert.equal(u.searchParams.get('lnum001'),'2');
  assert.throws(()=>reserveUrl(candidate,c.guests,c.hotel),/CANDIDATE_HOTEL_MISMATCH/);
  assert.equal(verifyQuote(quote(c.hotel.code,[]),other,c).hotelCode,c.hotel.code);
  assert.throws(()=>verifyQuote(quote(),candidate,c),/QUOTE_IDENTITY_MISMATCH/);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hotel-isolation-'));
  try {
    const state=new State(dir,'0000001834');await state.acquire();await state.write('MONITORING');await state.release();
    await assert.rejects(new State(dir,'0000001223').ensureReady(),/STATE_HOTEL_MISMATCH/);
    const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify(c));
    assert.equal(await runtimeDirectory(file),path.join(dir,'runtime','0000001223'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('取消费率按入住倒数天数计算；提前 22 天不会落入湖月 10% 区间',()=>{
  const policy={rate:{'-1':100,'0':100,'1':50,'7':30,'14':20,'21':10}};
  const stay={checkIn:'2027-01-31',checkOut:'2027-02-01'};
  const early=cancellationEstimate(policy,stay,'2027-01-09');assert.equal(early.ratePercent,0);assert.equal(early.freeDaysRemaining,1);
  assert.equal(cancellationEstimate(policy,stay,'2027-01-10').ratePercent,10);
  assert.equal(cancellationEstimate(policy,stay,'2027-01-17').ratePercent,20);
  assert.equal(cancellationEstimate(policy,stay,'2027-01-30').ratePercent,50);
  const c=config();c.checkout.requireFreeCancellation=true;
  assert.throws(()=>assertFreeCancellation(early,c),/FREE_CANCELLATION_REQUIRED/);
  assert.doesNotThrow(()=>assertFreeCancellation(cancellationEstimate(policy,stay,'2027-01-08'),c));
  assert.throws(()=>assertFreeCancellation(cancellationEstimate({},stay,'2027-01-08'),c),/FREE_CANCELLATION_REQUIRED/);
  assert.equal(cancellationEstimate({rate:{'0':100,'7':20,'8':0}},stay,'2027-01-22').ratePercent,0);
});
test('只读检查暴露未知问题和支付代理；下单模式拒绝未适配的 TravelPay',()=>{
  const d=quote();d.candidateSet.paymentMethods[0].agent='TRAVELPAY';d.candidateSet.reservations[0].questionForms=[{code:999,title:'Extra',formType:'TEXT',required:true}];
  const c=config(),review=verifyQuote(d,candidate,c);
  assert.equal(review.supportedPayment,false);assert.equal(review.unresolvedQuestions[0].code,999);
  c.checkout.mode='auto';assert.throws(()=>verifyQuote(d,candidate,c),/UNSUPPORTED_PAYMENT_AGENT/);
});
test('退避尊重 Retry-After；错误输出不泄露填入值',()=>{
  const p=config().poll;assert.equal(delayMs(p,2,0,()=>0),480000);
  assert.equal(delayMs(p,10,3600,()=>0),3600000);
  assert.equal(retryAfter('120'),120);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT',0),60);
  assert.equal(safeError(new Error('locator.fill("SECRET CARD")')),'UNEXPECTED_ERROR');
});
test('付款 URL 拒绝相似域名和伪造前缀',()=>{
  assert.ok(trustedPaymentUrl('https://www2.jtbbookandpay.com/FrontEnd/'));
  for(const u of ['http://www2.jtbbookandpay.com','https://www2.jtbbookandpay.com.evil.example','https://user@www2.jtbbookandpay.com'])assert.equal(trustedPaymentUrl(u),false);
  assert.equal(urlMatches('https://evil.example/FrontEnd/','https://www2.jtbbookandpay.com/FrontEnd/'),false);
});
test('进程互斥与持久状态阻止不确定提交后的重复下单',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kogetsu-test-'));const a=new State(dir),b=new State(dir);
  try {
    await a.acquire();await assert.rejects(b.acquire(),/PROCESS_LOCKED/);
    await a.write('SUBMITTING',{candidate});await a.release();await b.acquire();
    await assert.rejects(b.ensureReady(),/PREVIOUS_ATTEMPT_REQUIRES_REVIEW/);
    await b.write('RESOLVED_NOT_BOOKED');await b.ensureReady();
    if(process.platform!=='win32')assert.equal((await fs.stat(b.file)).mode&0o777,0o600);
  }finally{await a.release();await b.release();await fs.rm(dir,{recursive:true,force:true});}
});
test('分页采用每页数量；限流响应会释放响应对象',async()=>{
  const c=config();const search=new DReserveSearch({},c);let calls=0;
  search.page=async(_stay,n)=>{calls++;const d=searchData();d.resultCount=11;if(n===2)d.planDetailResources=[];return d;};
  assert.equal((await search.find(stay)).length,1);assert.equal(calls,2);
  let disposed=false;
  const limited=new DReserveSearch({request:{get:async()=>({status:()=>429,headers:()=>({'retry-after':'300'}),dispose:async()=>{disposed=true;}})}},c);
  await assert.rejects(limited.page(stay,1),e=>e.message==='RATE_LIMITED'&&e.retryAfterSeconds===300);assert.equal(disposed,true);
});
