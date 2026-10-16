import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createDashboard, PROJECT_ROOT } from '../src/dashboard.js';
import { atomicJson, privateDir } from '../src/state.js';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bookhotel-ui-'));
  for(const file of ['config.ubuya.nov29.example.json','config.monitor.jan3.example.json','config.kariyushi.example.json','config.nagisakan.example.json'])await fs.copyFile(path.join(PROJECT_ROOT,file),path.join(root,file));
  await fs.cp(path.join(PROJECT_ROOT,'web'),path.join(root,'web'),{recursive:true});
  const previous=process.env.PUSHPLUS_TOKEN;delete process.env.PUSHPLUS_TOKEN;
  let calls=0,notifications=0,lastConfig,lastDir;
  const app=await createDashboard({root,jobRun:async(c,dir,{once,signal})=>{
    calls++;lastConfig=c;lastDir=dir;await privateDir(dir);
    const at=new Date().toISOString();
    await atomicJson(path.join(dir,'availability.json'),{at,engine:c.hotel.engine,hotelCode:c.hotel.code,hotel:c.hotel.name,
      dates:[{stay:c.stays[0],offset:0,bookableOffers:1}],primary:[{engine:c.hotel.engine,hotelCode:c.hotel.code,stay:c.stays[0],roomCode:'20',hotelPlanCode:'14572645',planCode:'14572645-20',roomName:'附露天浴池的特别房 (98㎡)',planName:'测试住宿方案 <script>unsafe</script>',totalJpy:118800,inventory:1,noRefund:true}],alternatives:[]});
    await fs.appendFile(path.join(dir,'events.jsonl'),JSON.stringify({at,type:'AVAILABILITY_CHANGED',primary:[{}],alternatives:[]})+'\n');
    if(!once)await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
  },pushSend:async()=>{notifications++;return {status:'accepted',serialNumber:'NOT_EXPOSED'};}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(url);const cookie=response.headers.get('set-cookie').split(';')[0];
  const request=(route,data,headers={})=>fetch(url+route,{method:data===undefined?'GET':'POST',headers:{cookie,...(data===undefined?{}:{'content-type':'application/json','x-bookhotel-client':'1'}),...headers},body:data===undefined?undefined:JSON.stringify(data)});
  t.after(async()=>{await app.stop();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});await fs.rm(root,{recursive:true,force:true});if(previous===undefined)delete process.env.PUSHPLUS_TOKEN;else process.env.PUSHPLUS_TOKEN=previous;});
  return {app,url,request,root,calls:()=>calls,notifications:()=>notifications,config:()=>lastConfig,dir:()=>lastDir};
}

test('控制台保护会话与来源、保存设置和 token、复用引擎与通知记录并正确停止',async t=>{
  const s=await setup(t);
  assert.equal((await fetch(s.url+'/api/state')).status,403);
  assert.equal((await s.request('/api/state',undefined,{origin:'https://example.com'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(s.url+'/api/state',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(hostStatus,403);
  assert.equal((await s.request('/api/start',{once:true},{'x-bookhotel-client':''})).status,403);
  const presets=await (await s.request('/api/presets')).json();assert.equal(presets.length,4);
  assert.equal((await s.request('/api/config',{...presets[0].defaults,checkout:{mode:'auto'}})).status,400);
  const form={...presets[0].defaults,alternativesEnabled:true,daysBefore:3,daysAfter:3,pushEnabled:true};
  assert.equal((await s.request('/api/config',form)).status,200);
  assert.equal((await s.request('/api/start',{once:true})).status,500);
  const fakeToken='test_only_pushplus_12345678';
  assert.equal((await s.request('/api/token',{token:fakeToken})).status,200);
  assert.match(await fs.readFile(path.join(s.root,'.env'),'utf8'),new RegExp(fakeToken));
  assert.equal((await fs.stat(path.join(s.root,'.env'))).mode&0o777,0o600);
  assert.equal((await s.request('/api/notify-test',{})).status,200);
  assert.equal((await s.request('/api/notify-test',{})).status,429);assert.equal(s.notifications(),1);
  const results=await Promise.all([s.request('/api/start',{once:false}),s.request('/api/start',{once:false})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);
  assert.equal((await s.request('/api/config',form)).status,409);
  await delay(30);assert.equal(s.calls(),1);assert.equal(s.config().checkout.mode,'monitor');
  assert.equal(s.config().checkout.allowFinalSubmit,false);assert.equal(s.config().alternatives.allowBooking,false);
  assert.equal(s.config().alternatives.daysBefore,3);assert.equal(s.config().notifications.pushplus.enabled,true);
  assert.equal(s.dir(),path.join(s.root,'runtime','tripla','4398'));
  const response=await s.request('/api/state'),body=await response.text();
  assert.ok(!body.includes(fakeToken));assert.ok(!body.includes('NOT_EXPOSED'));assert.equal(JSON.parse(body).tokenConfigured,true);
  assert.match(JSON.parse(body).snapshot.primary[0].bookingUrl,/https:\/\/www.ubuya.co.jp/);
  assert.equal((await s.request('/api/stop',{})).status,202);await delay(30);
  assert.equal((await (await s.request('/api/state')).json()).job.status,'stopped');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.root,'dashboard.config.json'),'utf8')),form);
});

test('浏览器实测：配置保存、扫描结果、备选切换、推送测试与移动布局',async t=>{
  const s=await setup(t),browser=await chromium.launch({headless:true,executablePath:process.env.BOOKING_TEST_BROWSER});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(s.url);await page.getByText('本地服务已连接').waitFor();
  assert.equal(await page.locator('#hotelId option').count(),4);
  await page.locator('#alternativesEnabled').check();await page.locator('#daysBefore').fill('2');
  await page.locator('#save-button').click();await page.getByText('监控设置已保存。',{exact:true}).waitFor();
  await page.locator('#scan-button').click();
  await page.locator('.offer h3').waitFor();
  assert.match(await page.locator('.offer').textContent(),/118,800/);
  assert.match(await page.locator('.offer').textContent(),/不可退款/);
  assert.equal(await page.locator('.offer script').count(),0);
  assert.equal(s.calls(),1);assert.equal(s.config().alternatives.daysBefore,2);
  if(process.env.BOOKHOTEL_SCREENSHOT){await fs.mkdir(path.dirname(process.env.BOOKHOTEL_SCREENSHOT),{recursive:true});await page.locator('#toast').waitFor({state:'hidden'});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.BOOKHOTEL_SCREENSHOT,fullPage:true});}
  await page.getByRole('tab',{name:/备选建议/}).click();await page.getByText('暂未发现符合条件的方案',{exact:true}).waitFor();
  await page.locator('[data-view="notifications"]').click();
  await page.locator('#push-token').fill('test_only_pushplus_12345678');await page.locator('#token-save').click();
  await page.getByText('token 已安全保存到本机。',{exact:true}).waitFor();assert.equal(await page.locator('#push-token').inputValue(),'');
  await page.locator('#notify-test-button').click();await page.getByText('PushPlus 已受理测试通知，请在微信查看。',{exact:true}).waitFor();assert.equal(s.notifications(),1);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.locator('[data-view="overview"]').click();await page.getByRole('tab',{name:/目标房型/}).click();
  if(process.env.BOOKHOTEL_SCREENSHOT){await page.locator('#toast').waitFor({state:'hidden'});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.BOOKHOTEL_SCREENSHOT.replace('.png','-mobile.png'),fullPage:true});}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.locator('#start-button').click();await page.locator('#stop-button').waitFor();await page.locator('#stop-button').click();
  await page.getByText('已停止',{exact:true}).first().waitFor();assert.deepEqual(errors,[]);
});
