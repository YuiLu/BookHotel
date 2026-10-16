import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../src/browser.js';
import { TriplaSearch, parseTriplaCandidates, triplaGuestFields } from '../src/tripla.js';
import { triplaConfig, triplaData, triplaStay } from './tripla-helpers.js';

async function fixture(t,{buttons=1}={}) {
  const c=triplaConfig({browser:{headless:true}}),d=triplaData(),offer=parseTriplaCandidates(d,triplaStay,c)[0];
  const {browser,context,page}=await openBrowser(c);t.after(()=>browser.close());
  let mutations=0,guestPages=0;
  await context.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());
    if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations++;
    const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,OPTIONS'};
    if(r.method()==='OPTIONS')return route.fulfill({status:200,headers:cors,body:''});
    if(u.origin==='https://concierge.tripla.ai')return route.fulfill({status:200,contentType:'application/json',headers:cors,body:JSON.stringify(d)});
    if(u.origin==='https://www.ubuya.co.jp')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<iframe src="https://bw.tripla.ai/booking/result"></iframe>'});
    if(u.origin==='https://bw.tripla.ai'&&u.pathname==='/booking/result')return route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <body><div>${offer.roomName} ${offer.planName} 118,800</div>
      ${Array.from({length:buttons},()=>'<button onclick="location.href=\'/reservation/guest-detail\'">预约</button>').join('')}
      <script>fetch('https://concierge.tripla.ai/book/hotels/4398/rooms', {headers:{'client-session':'mock-browser-session','tripla-locale':'zh_Hans'}});</script></body>`});
    if(u.origin==='https://bw.tripla.ai'&&u.pathname==='/reservation/guest-detail') {
      guestPages++;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<body>${offer.roomName} ${offer.planName} 118,800 2026/11/09 2026/11/10
        ${['email','email-confirm','last-name-0','first-name-0','phone'].map(id=>`<input id="${id}">`).join('')}
        <button type="submit" onclick="fetch('https://concierge.tripla.ai/book/hotels/4398/reservations',{method:'POST'})">下一步</button></body>`});
    }
    return route.abort();
  });
  // APIRequestContext bypasses browser route handlers, so mock it separately.
  const api={request:{get:async url=>{
    assert.ok(url.startsWith('https://concierge.tripla.ai/book/hotels/4398/rooms?'));
    return {status:()=>200,ok:()=>true,headers:()=>({'content-type':'application/json'}),json:async()=>structuredClone(d),dispose:async()=>{}};
  }}};
  const search=new TriplaSearch(api,c);await search.initialize(page);
  return {c,d,offer,context,page,search,mutations:()=>mutations,guestPages:()=>guestPages};
}

test('Tripla 模拟浏览器：捕获匿名会话、核对报价、进入旅客页并填 5 个字段，全程无预约写请求',async t=>{
  const f=await fixture(t),{frame}=await f.search.openOffer(f.page,f.offer);
  const fake={lastName:'TEST_LAST',firstName:'TEST_FIRST',email:'test@example.invalid',phone:'13800000000'},previous={};
  for(const [key,value]of Object.entries(fake)) {const name=f.c.checkout.guestEnv[key];previous[name]=process.env[name];process.env[name]=value;}
  try {
    await triplaGuestFields(frame,f.c);
    assert.equal(await frame.locator('#email').inputValue(),fake.email);
    assert.equal(await frame.locator('#email-confirm').inputValue(),fake.email);
    assert.equal(await frame.locator('#last-name-0').inputValue(),fake.lastName);
    assert.equal(await frame.locator('#first-name-0').inputValue(),fake.firstName);
    assert.equal(await frame.locator('#phone').inputValue(),fake.phone);
    assert.equal(f.guestPages(),1);assert.equal(f.mutations(),0);
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('Tripla 模拟浏览器：价格改变或存在两个预约按钮时停止，不选择任意套餐',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.search.openOffer(f.page,{...f.offer,totalJpy:110000}),/QUOTE_PRICE_CHANGED/);
  assert.equal(f.guestPages(),0);assert.equal(f.mutations(),0);
  const ambiguous=await fixture(t,{buttons:2});
  await assert.rejects(ambiguous.search.openOffer(ambiguous.page,ambiguous.offer),/TRIPLA_OFFER_AMBIGUOUS/);
  assert.equal(ambiguous.guestPages(),0);assert.equal(ambiguous.mutations(),0);
});
