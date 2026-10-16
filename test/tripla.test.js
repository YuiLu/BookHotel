import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './helpers.js';
import { schema, runtimeDirectory } from '../src/config.js';
import { parseTriplaCandidates, TriplaSearch } from '../src/tripla.js';
import { triplaUrl, triplaRoomsUrl, TRIPLA_API_ORIGIN } from '../src/tripla-url.js';
import { reserveUrl } from '../src/domain.js';
import { createSearch } from '../src/engines.js';
import { DReserveSearch } from '../src/search.js';
import { scan } from '../src/runner.js';
import { anonymousTriplaRequest } from '../scripts/validate-tripla.js';

import { triplaStay, triplaConfig, triplaData } from './tripla-helpers.js';

test('Tripla 房型与含税总价正确：108000+10800=118800；不使用最低起价或美元转换价',()=>{
  const [c]=parseTriplaCandidates(triplaData(),triplaStay,triplaConfig());
  assert.equal(c.roomCode,'20');assert.equal(c.planCode,'14572645-20-14098-4398');
  assert.equal(c.totalJpy,118800);assert.equal(c.currency,'JPY');assert.equal(c.inventory,1);assert.equal(c.noRefund,true);
  assert.deepEqual(c.priceBreakdown,{baseJpy:108000,consumptionTaxJpy:10800,accommodationTaxJpy:0});
});
test('Tripla 严格验证查询日期、成人数、每日房价和税费，错误响应不视为无房',()=>{
  const cases=[
    [d=>d.search_params.checkin_date='2026/11/10','SEARCH_DATE_MISMATCH'],
    [d=>d.rooms[0].room_plan[0].matched_search_criteria.adults_count=3,'SEARCH_GUEST_MISMATCH'],
    [d=>d.rooms[0].room_plan[0].room_rate[0].rate=108000,'SEARCH_PRICE_SCHEMA_CHANGED'],
    [d=>d.rooms[0].room_plan[0].tax=-100,'SEARCH_PRICE_SCHEMA_CHANGED'],
    [d=>d.rooms[0].room_plan[0].room_rate[0].date='2026/11/10','SEARCH_PRICE_SCHEMA_CHANGED'],
  ];
  for(const [change,code]of cases){const d=triplaData();change(d);assert.throws(()=>parseTriplaCandidates(d,triplaStay,triplaConfig()),new RegExp(code));}
  assert.throws(()=>parseTriplaCandidates({rooms:[]},triplaStay,triplaConfig()),/SEARCH_DATE_MISMATCH/);
});
test('Tripla 不通知不可订、库存为零或需登录的报价；多晚合计另计住宿税',()=>{
  for(const change of [r=>r.room_count=0,r=>r.room_plan[0].inventory=0,r=>r.room_plan[0].availability='unavailable',
    r=>r.room_plan[0].sign_in_required=true,r=>r.room_plan[0].only_visible_to_guest=true]) {
    const d=triplaData();change(d.rooms[0]);assert.deepEqual(parseTriplaCandidates(d,triplaStay,triplaConfig()),[]);
  }
  const stay={...triplaStay,checkOut:'2026-11-11'},d=triplaData(stay),p=d.rooms[0].room_plan[0];
  p.total_price=216000;p.tax=21600;p.accommodation_tax=600;p.room_rate.push({date:'2026/11/10',rate:118800});
  assert.equal(parseTriplaCandidates(d,stay,triplaConfig())[0].totalJpy,238200);
});
test('引擎按配置选择、runtime 按引擎酒店隔离，Tripla 拒绝未适配支付与儿童',async()=>{
  const c=triplaConfig();assert.ok(createSearch({},c)instanceof TriplaSearch);assert.ok(createSearch({},config())instanceof DReserveSearch);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tripla-config-'));
  try{const file=path.join(dir,'config.json');await fs.writeFile(file,JSON.stringify(c));assert.equal(await runtimeDirectory(file),path.join(dir,'runtime','tripla','4398'));}
  finally{await fs.rm(dir,{recursive:true,force:true});}
  assert.equal(schema.safeParse({...c,checkout:{...c.checkout,mode:'auto'}}).success,false);
  assert.equal(schema.safeParse({...c,guests:{...c.guests,childA:1}}).success,false);
  assert.equal(schema.safeParse({...c,hotel:{...c.hotel,bookingUrl:'http://www.ubuya.co.jp'}}).success,false);
  assert.equal(schema.safeParse({...c,hotel:{...c.hotel,bookingUrl:'https://user:secret@www.ubuya.co.jp'}}).success,false);
  assert.equal(schema.safeParse({...config(),hotel:{...config().hotel,code:'4398'}}).success,false);
});
test('Tripla 官方预约链接带正确日期房型人数，查询 URL 清理旧日期、筛选和会话参数',()=>{
  const c=triplaConfig(),offer=parseTriplaCandidates(triplaData(),triplaStay,c)[0];
  const u=new URL(reserveUrl(offer,c.guests,c.hotel));
  assert.equal(u.origin,'https://www.ubuya.co.jp');assert.equal(u.searchParams.get('room_type_code'),'20');
  assert.equal(u.searchParams.get('checkin'),'2026/11/09');assert.equal(u.searchParams.get('hotel_plan_code'),'14572645');
  assert.equal(u.searchParams.get('adults'),'2');assert.equal(u.searchParams.get('mcp_currency'),'JPY');
  assert.throws(()=>reserveUrl({...offer,hotelCode:'9999'},c.guests,c.hotel),/CANDIDATE_HOTEL_MISMATCH/);
  const query=new URL(triplaRoomsUrl(`${TRIPLA_API_ORIGIN}/book/hotels/4398/rooms?session=secret&room_type_codes[]=OTHER`,triplaStay,c.guests,['20','21']));
  assert.equal(query.searchParams.get('session'),null);assert.deepEqual(query.searchParams.getAll('room_type_codes[]'),['20','21']);
  assert.equal(query.searchParams.get('bookable'),'true');assert.equal(query.searchParams.get('rooms[][checkout_date]'),'2026/11/10');
  assert.throws(()=>triplaRoomsUrl('https://concierge.tripla.ai.evil.example/book/hotels/4398/rooms',triplaStay,c.guests),/UNTRUSTED_SEARCH_URL/);
});
test('Tripla GET 查询过滤预算并释放响应；401 只刷新一次匿名会话，不重复发送写请求',async()=>{
  const c=triplaConfig();let calls=0,disposed=0,refreshes=0;
  const search=new TriplaSearch({request:{get:async(url,options)=>{
    calls++;assert.ok(url.startsWith(`${TRIPLA_API_ORIGIN}/book/hotels/4398/rooms?`));assert.ok(!url.includes('session='));
    return {status:()=>calls===1?401:200,ok:()=>true,headers:()=>({'content-type':'application/json'}),json:async()=>triplaData(),dispose:async()=>disposed++};
  }}},c);
  search.baseUrl=`${TRIPLA_API_ORIGIN}/book/hotels/4398/rooms`;search.headers={'client-session':'test-memory-only'};
  search.initialize=async()=>{refreshes++;};
  assert.equal((await search.find(triplaStay)).length,1);assert.equal(refreshes,1);assert.equal(calls,2);assert.equal(disposed,2);
  assert.deepEqual(await search.find(triplaStay,undefined,{...c.filters,maxTotalJpy:118800}),[]);
});
test('Tripla 限流与非 JSON 不会转换为空房；验证脚本仅放行匿名会话写请求',async()=>{
  let disposed=0;
  const search=new TriplaSearch({request:{get:async()=>({status:()=>429,headers:()=>({'retry-after':'300'}),dispose:async()=>disposed++})}},triplaConfig());
  search.baseUrl=`${TRIPLA_API_ORIGIN}/book/hotels/4398/rooms`;
  await assert.rejects(search.find(triplaStay),e=>e.message==='RATE_LIMITED'&&e.retryAfterSeconds===300);assert.equal(disposed,1);
  for(const [url,allowed]of [['https://idp.tripla.ai/book/api/client_sessions',true],['https://concierge.tripla.ai/book/hotels/4398/reservations',false],
    ['https://idp.tripla.ai.evil.example/book/api/client_sessions',false],['https://concierge.tripla.ai/book/payments',false]])
    assert.equal(anonymousTriplaRequest({method:()=>'POST',url:()=>url}),allowed);
});
test('Tripla 复用现有日期范围扫描，目标与前后日期建议分开',async()=>{
  const c=triplaConfig({alternatives:{enabled:true,daysBefore:1,daysAfter:1}}),calls=[];
  const search={find:async(stay,signal,filter)=>{
    calls.push({stay,filter});return parseTriplaCandidates(triplaData(stay),stay,c);
  }};
  const r=await scan(search,c);
  assert.equal(r.engine,'tripla');assert.equal(r.primary.length,1);assert.equal(r.alternatives.length,2);
  assert.deepEqual(new Set(r.alternatives.map(a=>a.offset)),new Set([-1,1]));
  assert.ok(calls.every(x=>x.filter.roomCodes.length===0));
});
