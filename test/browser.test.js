import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { config, candidate, quote } from './helpers.js';
import { ORIGIN, sha256 } from '../src/domain.js';
import { State } from '../src/state.js';
import { checkout, completion, submitToPayment } from '../src/checkout.js';
import { configuredFields, metadata,hotelQuestions } from '../src/fields.js';

function formHtml(hotelCode,questions) {
  const q=quote(hotelCode,questions);
  const input=n=>`<input name="${n}" required>`;
  const select=n=>`<select name="${n}"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select>`;
  return `<!doctype html><html lang="ja"><body><script>window.$initialData=${JSON.stringify(q)}</script>
    <label><input type="checkbox" checked><span class="input-label-text">予約と同時に会員登録する</span></label>
    <div>${['lastName','firstName','lastNameKana','firstNameKana'].map(input).join('')}
    <label><input name="livingAbroad" type="hidden" value="false"><input type="checkbox"><span class="input-label-text">海外在住</span></label>
    ${input('phoneCountryCode')}${['areaCode','exchangeNumber','subscriberNumber'].map(n=>`<input data-name="${n}" required>`).join('')}
    <label><input name="gender" type="radio" value="male"><span class="input-label-text">男性</span></label>
    <input name="email" type="email" required><input data-name="email-confirm" type="email" required>
    <label><input type="checkbox"><span class="input-label-text">予約者と同じ</span></label>
    ${['numberOfMales','numberOfFemales','numberOfOthers'].map(select).join('')}
    <select name="reservationCheckInTime"><option value="15:00">15:00</option></select>
    ${q.candidateSet.reservations[0].questionForms.map(q=>`<form class="question_wrap"><p class="item-question-title">${q.title}<span class="icon-required">必須</span></p>${q.formType==='TEXT'?'<textarea name="reservationQuestion" required></textarea>':'<select name="reservationQuestion"><option value="0">公共交通機関</option></select>'}</form>`).join('')}
    <label><input type="radio"><span class="input-label-text">オンラインカード決済</span></label>
    <label><input type="checkbox"><span class="input-label-text">約款、プライバシーポリシーに同意する</span></label></div>
    <div style="display:none">${input('lastName')}${input('firstName')}</div>
    <button id="submit" type="button">決済へ進む</button>
    <div class="modal" style="display:none"><p>決済情報入力画面へ進みます。よろしいですか？</p><button id="ok">OK</button></div>
    <script>
    document.querySelector('#submit').onclick=()=>document.querySelector('.modal').style.display='block';
    document.querySelector('#ok').onclick=async()=>{document.querySelector('#ok').disabled=true;
      const r=await fetch('/guest-reserve-front/reservation/entry',{method:'POST',body:'mock'});
      location.href=(await r.json()).nextUrl;};
    </script></body></html>`;
}
async function setup(t,{paymentTotal=85800,hotelCode=config().hotel.code,questions}={}) {
  const browser=await chromium.launch({headless:true,executablePath:process.env.BOOKING_TEST_BROWSER});
  t.after(()=>browser.close());
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  let reservations=0,payments=0;
  await context.route('**/*',async r=>{
    const u=new URL(r.request().url());
    if(u.origin===ORIGIN&&u.pathname.endsWith('/reservation/entry')) {
      reservations++;return r.fulfill({json:{nextUrl:'https://www2.jtbbookandpay.com/FrontEnd/mock'}});
    }
    if(u.origin===ORIGIN&&u.pathname==='/complete')return r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>予約完了</h1><p>予約番号：MOCK123456</p>'});
    if(u.origin===ORIGIN)return r.fulfill({contentType:'text/html; charset=utf-8',body:formHtml(hotelCode,questions)});
    if(u.origin==='https://www2.jtbbookandpay.com')return r.fulfill({contentType:'text/html; charset=utf-8',body:`
      <div id="payment"><input autocomplete="cc-number"><input autocomplete="cc-name">
      <input autocomplete="cc-exp-month"><input autocomplete="cc-exp-year"><input autocomplete="cc-csc">
      <p id="total">${paymentTotal.toLocaleString('en-US')}円</p><button id="pay">支払う</button></div>
      <script>document.querySelector('#pay').onclick=async()=>{await fetch('/mock-pay',{method:'POST'});location.href='${ORIGIN}/complete?hotelCode=${hotelCode}'}</script>`});
    // No request in these tests reaches a real server, including unknown URLs.
    return r.abort();
  });
  // Replace the JTB mock payment POST route after the page route (last route wins).
  await context.route('https://www2.jtbbookandpay.com/mock-pay',async r=>{payments++;await r.fulfill({json:{ok:true}});});
  const c=config();if(hotelCode!==c.hotel.code)c.hotel={...c.hotel,code:hotelCode,name:'Mock second hotel',lodgerTypeCodes:[0],questions:[]};
  c.checkout={...c.checkout,mode:'auto',allowFinalSubmit:true,acceptTermsAndPrivacy:true,
    acceptedCancellationPolicySha256:sha256('TEST cancellation policy'),gender:'MALE',
    genderCounts:{adults:{male:1,female:1,other:0}},transport:'公共交通機関',
    paymentSteps:[{urlPrefix:'https://www2.jtbbookandpay.com/FrontEnd/mock',readySelector:'#payment',fields:[],totalSelector:'#total',buttonSelector:'#pay',buttonText:'支払う',currencyText:'円'}]};
  const secrets={GUEST_LAST_NAME:'TEST',GUEST_FIRST_NAME:'TEST',GUEST_LAST_NAME_KANA:'てすと',GUEST_FIRST_NAME_KANA:'てすと',
    GUEST_EMAIL:'test@example.invalid',GUEST_PHONE:'13800000000',CARD_NUMBER:'4242424242424242',CARD_HOLDER:'TEST',CARD_EXP_MONTH:'01',CARD_EXP_YEAR:'2030',CARD_CVC:'123'};
  for(const [k,v] of Object.entries(secrets)){const prev=process.env[k];process.env[k]=v;t.after(()=>{if(prev===undefined)delete process.env[k];else process.env[k]=prev;});}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kogetsu-browser-'));const state=new State(dir,hotelCode);await state.acquire();
  t.after(async()=>{await state.release();await fs.rm(dir,{recursive:true,force:true});});
  return {context,page,c,state,counts:()=>({reservations,payments})};
}
test('模拟全流程：真实选择器填写 → 预约 POST 一次 → JTB 填卡 → 付款一次 → 预约号',async t=>{
  const {context,page,c,state,counts}=await setup(t);
  await checkout(context,page,candidate,c,state);
  assert.deepEqual(counts(),{reservations:1,payments:1});
  assert.equal((await state.read()).status,'CONFIRMED');
  assert.equal((await state.read()).reservationNumber,'MOCK123456');
  const lines=(await fs.readFile(path.join(state.dir,'events.jsonl'),'utf8'));
  assert.ok(!lines.includes('4242424242424242'));assert.ok(!lines.includes('test@example.invalid'));
  await assert.rejects(state.ensureReady(),/PREVIOUS_ATTEMPT_REQUIRES_REVIEW/);
});
test('付款金额变化时停止，不点击支付按钮，保留不可自动重试的状态',async t=>{
  const {context,page,c,state,counts}=await setup(t,{paymentTotal:90000});
  await assert.rejects(checkout(context,page,candidate,c,state),/PAYMENT_TOTAL_MISMATCH/);
  assert.deepEqual(counts(),{reservations:1,payments:0});
  assert.equal((await state.read()).status,'PAYMENT_PAGE');
  assert.equal((await state.read()).holdConfirmed,false);
  await assert.rejects(state.ensureReady(),/PREVIOUS_ATTEMPT_REQUIRES_REVIEW/);
});
test('未经配置许可的付款 iframe 不填写；表单元数据不含字段值',async t=>{
  const {context,page,c}=await setup(t);
  await context.route('https://www2.jtbbookandpay.com/iframe-demo',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<input name="secret" value="DO_NOT_LOG"><iframe src="https://processor.example/card"></iframe>'}));
  await context.route('https://processor.example/card',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<input id="card">'}));
  await page.goto('https://www2.jtbbookandpay.com/iframe-demo');await page.frames()[1].locator('#card').waitFor();
  await assert.rejects(configuredFields(page,[{frameUrlPrefix:'https://processor.example/',selector:'#card',action:'fill',value:'test'}],c),/UNTRUSTED_PAYMENT_FRAME/);
  assert.ok(!JSON.stringify(await metadata(page)).includes('DO_NOT_LOG'));
  assert.equal(await completion(page),null);
});
test('收到停止信号后不确认预约 POST',async t=>{
  const {page,counts}=await setup(t);await page.goto(`${ORIGIN}/mock-form`);
  const stop=new AbortController();
  page.once('console',()=>stop.abort());
  await page.evaluate(()=>document.querySelector('#submit').addEventListener('click',()=>console.log('stop')));
  await assert.rejects(submitToPayment(page,async()=>{},stop.signal),e=>e.name==='AbortError');
  assert.deepEqual(counts(),{reservations:0,payments:0});
});
test('另一家 D-Reserve 酒店复用相同填写和 JTB 流程，不发送湖月编号',async t=>{
  const {context,page,c,state,counts}=await setup(t,{hotelCode:'0000001223',questions:[]});
  const other={...candidate,hotelCode:c.hotel.code};
  const urls=[];context.on('request',r=>{if(new URL(r.url()).origin===ORIGIN)urls.push(r.url());});
  await checkout(context,page,other,c,state);
  assert.deepEqual(counts(),{reservations:1,payments:1});
  assert.equal((await state.read()).hotelCode,'0000001223');
  assert.ok(urls.some(u=>u.includes('hotelCode=0000001223')));
  assert.ok(!urls.some(u=>u.includes('hotelCode=0000001834')));
  assert.equal(await completion(page,'0000001834'),null);
});
test('酒店附加问题按编号、标题和类型匹配，支持多个文本问题且拒绝标题变化',async t=>{
  const questions=[{code:111,title:'Children',formType:'TEXT',required:true},{code:222,title:'Other',formType:'TEXT',required:true}];
  const {page,c}=await setup(t,{hotelCode:'0000001223',questions});
  c.hotel.questions=questions.map((q,i)=>({...q,value:String(i)}));
  await page.goto(`${ORIGIN}/mock-form`);await hotelQuestions(page,c,questions);
  assert.equal(await page.locator('textarea').nth(0).inputValue(),'0');assert.equal(await page.locator('textarea').nth(1).inputValue(),'1');
  await page.locator('.item-question-title').nth(0).evaluate(e=>e.textContent='Changed');
  await assert.rejects(hotelQuestions(page,c,questions),/QUESTION_TITLE_CHANGED/);
});
