import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { amount, matches, nights, publicCandidate, reserveUrl, retryAfter } from './domain.js';
import { SearchError } from './search.js';
import { secret } from './config.js';
import { atomicJson } from './state.js';
import { fill } from './fields.js';
import { triplaDate, triplaUrl, triplaRoomsUrl, TRIPLA_API_ORIGIN, TRIPLA_WIDGET_ORIGIN } from './tripla-url.js';

export function parseTriplaCandidates(data,stay,config) {
  if(!Array.isArray(data?.rooms))throw new SearchError('SEARCH_SCHEMA_CHANGED');
  if(data.search_params?.checkin_date!==triplaDate(stay.checkIn)||data.search_params?.checkout_date!==triplaDate(stay.checkOut))
    throw new SearchError('SEARCH_DATE_MISMATCH');
  const found=[];
  for(const room of data.rooms) {
    if(!Array.isArray(room.room_plan)||typeof room.room_type_code!=='string'||typeof room.room_type_name!=='string')throw new SearchError('SEARCH_SCHEMA_CHANGED');
    if(!Number.isInteger(room.room_count)||room.room_count<1)continue;
    for(const plan of room.room_plan) {
      if(plan.availability!=='available'||plan.sign_in_required||plan.only_visible_to_guest)continue;
      if(plan.inventory!==null&&plan.inventory!==undefined&&(!Number.isInteger(plan.inventory)||plan.inventory<1))continue;
      if(plan.matched_search_criteria?.adults_count!==config.guests.adults||plan.matched_search_criteria?.children_count!==0)
        throw new SearchError('SEARCH_GUEST_MISMATCH');
      const base=amount(plan.total_price),tax=plan.tax,accommodationTax=plan.accommodation_tax;
      if(!base||!Number.isSafeInteger(tax)||tax<0||!Number.isSafeInteger(accommodationTax)||accommodationTax<0||
        !Array.isArray(plan.room_rate)||plan.room_rate.length!==nights(stay))throw new SearchError('SEARCH_PRICE_SCHEMA_CHANGED');
      const dates=plan.room_rate.map(r=>r.date),expected=Array.from({length:nights(stay)},(_,i)=>triplaDate(new Date(Date.parse(stay.checkIn)+i*86400000).toISOString().slice(0,10)));
      const rates=plan.room_rate.map(r=>amount(r.rate));
      if(new Set(dates).size!==dates.length||expected.some(d=>!dates.includes(d))||rates.some(r=>!r)||rates.reduce((a,b)=>a+b,0)!==base+tax)
        throw new SearchError('SEARCH_PRICE_SCHEMA_CHANGED');
      const total=base+tax+accommodationTax;
      if(!Number.isSafeInteger(total)||typeof plan.room_plan_code!=='string'||typeof plan.room_plan_name!=='string'||typeof plan.is_no_refund!=='boolean')throw new SearchError('SEARCH_SCHEMA_CHANGED');
      found.push({engine:'tripla',hotelCode:config.hotel.code,stay,roomCode:room.room_type_code,roomName:room.room_type_name,
        planCode:plan.room_plan_code,hotelPlanCode:plan.hotel_plan_code,planName:plan.room_plan_name,totalJpy:total,currency:'JPY',
        priceBreakdown:{baseJpy:base,consumptionTaxJpy:tax,accommodationTaxJpy:accommodationTax},
        inventory:Math.min(room.room_count,plan.inventory??room.room_count),noRefund:plan.is_no_refund===true,
        cancellationFreeDeadline:plan.cancellation_free_deadline??null,
        paymentMethods:plan.payment_method?.map(m=>m.name).join(', '),description:plan.hotel_plan_description});
    }
  }
  return found;
}

export class TriplaSearch {
  constructor(context,config){this.context=context;this.config=config;}
  async initialize(page,signal) {
    signal?.throwIfAborted();this.browserPage=page;
    const apiPath=`/book/hotels/${this.config.hotel.code}/rooms`;
    const pending=page.waitForRequest(r=>r.method()==='GET'&&new URL(r.url()).origin===TRIPLA_API_ORIGIN&&new URL(r.url()).pathname===apiPath,
      {timeout:60000});
    // Handle the pending rejection even if navigation fails before it is awaited.
    pending.catch(()=>{});
    await page.goto(triplaUrl(this.config.stays[0],this.config.guests,this.config.hotel,{roomCode:this.config.filters.roomCodes[0]}),{waitUntil:'domcontentloaded'});
    const request=await pending;signal?.throwIfAborted();
    this.baseUrl=TRIPLA_API_ORIGIN+apiPath;
    const headers=await request.allHeaders();
    if(!headers['client-session'])throw new SearchError('TRIPLA_SESSION_MISSING');
    this.headers=Object.fromEntries(['client-session','app-version','tripla-locale','accept-language','x-site-controller','x-tripla-tier','origin','referer']
      .filter(k=>headers[k]).map(k=>[k,headers[k]]));
    this.headers.Accept='application/json';
  }
  async page(stay,roomCodes=[],renew=true,signal) {
    if(!this.baseUrl)throw new SearchError('SEARCH_NOT_INITIALIZED');
    const response=await this.context.request.get(triplaRoomsUrl(this.baseUrl,stay,this.config.guests,roomCodes),{
      timeout:this.config.poll.requestTimeoutSeconds*1000,maxRedirects:0,headers:this.headers,
    });
    let expired=false;
    try {
      if(response.status()===429)throw new SearchError('RATE_LIMITED',Math.max(60,retryAfter(response.headers()['retry-after'])));
      if(response.status()===401&&renew)expired=true;
      else {
        if(response.status()===401||response.status()===403)throw new SearchError('ACCESS_DENIED',600);
        if(!response.ok())throw new SearchError('SEARCH_HTTP_ERROR',retryAfter(response.headers()['retry-after']));
        if(!response.headers()['content-type']?.includes('json'))throw new SearchError('SEARCH_NOT_JSON');
        return await response.json();
      }
    }finally{await response.dispose();}
    if(expired){signal?.throwIfAborted();await this.initialize(this.browserPage,signal);return this.page(stay,roomCodes,false,signal);}
  }
  async find(stay,signal,filters=this.config.filters) {
    signal?.throwIfAborted();
    const data=await this.page(stay,filters.roomCodes,true,signal);signal?.throwIfAborted();
    return parseTriplaCandidates(data,stay,this.config).filter(c=>matches(c,filters)).sort((a,b)=>a.totalJpy-b.totalJpy);
  }
  async openOffer(page,candidate,signal) {
    if(candidate.hotelCode!==this.config.hotel.code)throw new Error('CANDIDATE_HOTEL_MISMATCH');
    const fresh=(await this.find(candidate.stay,signal,{...this.config.filters,roomCodes:[candidate.roomCode],planCodes:[candidate.planCode],roomKeywords:[],planKeywords:[]}))[0];
    if(!fresh)throw new Error('INVENTORY_OR_QUOTE_CONFLICT');
    if(fresh.totalJpy!==candidate.totalJpy)throw new Error('QUOTE_PRICE_CHANGED');
    signal?.throwIfAborted();
    await page.goto(reserveUrl(fresh,this.config.guests,this.config.hotel),{waitUntil:'domcontentloaded'});
    const frame=page.frameLocator('iframe[src^="https://bw.tripla.ai/"]');
    const button=frame.getByRole('button',{name:'预约',exact:true});
    await button.first().waitFor({timeout:60000});
    // A room-specific link can still show several plans. Never pick by position.
    const widget=page.frames().filter(f=>new URL(f.url()).origin===TRIPLA_WIDGET_ORIGIN);
    if(widget.length!==1)throw new Error('FRAME_MISSING_OR_AMBIGUOUS');
    const visibleText=await widget[0].locator('body').innerText();
    if(await button.count()!==1||!visibleText.includes(fresh.roomName)||!visibleText.includes(fresh.planName)||
      !visibleText.includes(fresh.totalJpy.toLocaleString('en-US')))throw new Error('TRIPLA_OFFER_AMBIGUOUS');
    signal?.throwIfAborted();await button.click();
    await widget[0].waitForURL(u=>u.origin===TRIPLA_WIDGET_ORIGIN&&u.pathname==='/reservation/guest-detail',{timeout:30000});
    await widget[0].locator('#email').filter({visible:true}).waitFor();
    const text=await widget[0].locator('body').innerText();
    if(!text.includes(fresh.roomName)||!text.includes(fresh.planName)||!text.includes(fresh.totalJpy.toLocaleString('en-US'))||
      !text.includes(triplaDate(fresh.stay.checkIn))||!text.includes(triplaDate(fresh.stay.checkOut)))throw new Error('QUOTE_IDENTITY_MISMATCH');
    return {frame:widget[0],candidate:fresh};
  }
}

export async function triplaGuestFields(frame,config) {
  const u=new URL(frame.url());
  if(u.origin!==TRIPLA_WIDGET_ORIGIN||u.pathname!=='/reservation/guest-detail')throw new Error('UNTRUSTED_PAGE');
  const e=config.checkout.guestEnv;
  for(const [selector,key]of [['#email','email'],['#email-confirm','email'],['#last-name-0','lastName'],['#first-name-0','firstName'],['#phone','phone']])
    await fill(frame,selector,secret(e[key]));
  for(const f of config.checkout.fields) {
    if(f.frameUrlPrefix) {
      const p=new URL(f.frameUrlPrefix);
      if(p.origin!==u.origin||!u.pathname.startsWith(p.pathname))throw new Error('UNTRUSTED_PAGE');
    }
    await fill(frame,f.selector,f.env?secret(f.env):(f.value??''),f.action);
  }
}

export async function prepareTripla(search,context,page,candidate,config,state,signal) {
  await state.write('ATTEMPT_STARTED',{candidate:publicCandidate(candidate)});
  const prepared=await search.openOffer(page,candidate,signal);
  await atomicJson(path.join(state.dir,'review.json'),{candidate:publicCandidate(prepared.candidate),
    engine:'tripla',noRefund:prepared.candidate.noRefund,stage:'guest-detail',reservationSubmitted:false,holdConfirmed:false});
  await triplaGuestFields(prepared.frame,config);
  await state.write('PREPARED',{candidate:publicCandidate(candidate),engine:'tripla',reservationSubmitted:false});
  await state.event('NEEDS_ATTENTION',{reason:'TRIPLA_GUEST_DETAILS_READY',minutes:config.checkout.handoffMinutes});
  // Do not click Next or choose/submit payment: additional questions require manual review.
  const end=Date.now()+config.checkout.handoffMinutes*60000;
  while(Date.now()<end&&!signal?.aborted&&context.pages().length)await sleep(1000,undefined,{signal}).catch(()=>{});
  await state.write('UNVERIFIED',{candidate:publicCandidate(candidate),reason:'MANUAL_REVIEW_REQUIRED'});
}
