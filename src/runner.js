import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from './browser.js';
import { createSearch } from './engines.js';
import { prepareTripla } from './tripla.js';
import { State, atomicJson, atomicText } from './state.js';
import { validateSecrets } from './config.js';
import { checkout, waitForHandoff } from './checkout.js';
import { queryRange, alternateFilter, rankAlternatives } from './alternatives.js';
import { publicCandidate, delayMs, sha256, matches } from './domain.js';
import { availabilityMarkdown } from './report.js';
import { AvailabilityNotifier, notifyAvailability } from './notifications.js';

export async function scan(search,config,signal,withAlternatives=true) {
  const primary=[], alternatives=[], dates=[];
  for(const query of queryRange(config)) {
    if(!query.primary&&!withAlternatives)continue;
    signal?.throwIfAborted();
    const filter=config.alternatives.enabled&&withAlternatives?alternateFilter(config):config.filters;
    const results=await search.find(query.stay,signal,filter);
    dates.push({stay:query.stay,offset:query.offset,bookableOffers:results.length});
    for(const c of results) {
      const candidate={...c,offset:query.offset};
      const matchesPrimary=query.primary&&config.stays.some(s=>s.checkIn===c.stay.checkIn&&s.checkOut===c.stay.checkOut);
      if(matchesPrimary&&matches(candidate,config.filters))primary.push(candidate);
      else alternatives.push(candidate);
    }
    await sleep(1500,undefined,{signal});
  }
  primary.sort((a,b)=>config.stays.findIndex(s=>s.checkIn===a.stay.checkIn)-config.stays.findIndex(s=>s.checkIn===b.stay.checkIn)||a.totalJpy-b.totalJpy);
  return {at:new Date().toISOString(),hotel:config.hotel.name,hotelCode:config.hotel.code,engine:config.hotel.engine,dates,primary:primary.map(publicCandidate),
    alternatives:rankAlternatives(alternatives,config).map(publicCandidate)};
}
export async function run(config,dir,{once=false,signal}={}) {
  validateSecrets(config);
  const state=new State(dir,config.hotel.code);await state.acquire();
  let browser,context,page;
  try {
    await state.ensureReady();
    const event=(type, details)=>state.event(type, details);
    const notifier=new AvailabilityNotifier(config,dir,{event});
    ({browser,context,page}=await openBrowser(config));
    const search=createSearch(context,config);await search.initialize(page,signal);
    let errors=0,cycle=0,lastAlternativeScan=0,lastFingerprint='';
    await state.write('MONITORING');
    while(!signal?.aborted) {
      cycle++;let retry=0;
      try {
        const includeAlternatives=once||Date.now()-lastAlternativeScan>=config.alternatives.intervalSeconds*1000;
        const result=await scan(search,config,signal,includeAlternatives);
        if(includeAlternatives)lastAlternativeScan=Date.now();
        const previous=await readSnapshot(dir);
        result.alternativesCheckedAt=includeAlternatives?result.at:previous?.alternativesCheckedAt;
        if(!includeAlternatives && previous?.hotelCode===config.hotel.code)result.alternatives=previous.alternatives;
        await atomicJson(path.join(dir,'availability.json'),result);
        await atomicText(path.join(dir,'availability.md'),availabilityMarkdown(result,config));
        const fingerprint=sha256(JSON.stringify({primary:result.primary,alternatives:result.alternatives}));
        if(fingerprint!==lastFingerprint){await state.event('AVAILABILITY_CHANGED',{primary:result.primary,alternatives:result.alternatives});lastFingerprint=fingerprint;}
        errors=0;
        await notifyAvailability(notifier,result,{alternativesFresh:includeAlternatives,signal},event);
        if(once)return result;
        // Cached suggestions are for display only. Book an alternative only after a fresh scan.
        const selected=result.primary[0]??(config.alternatives.allowBooking&&includeAlternatives?result.alternatives.find(c=>c.withinBudget):undefined);
        if(selected&&config.checkout.mode!=='monitor') {
          try {
            if(config.hotel.engine==='tripla')await prepareTripla(search,context,page,selected,config,state,signal);
            else await checkout(context,page,selected,config,state,signal);
            return result;
          }
          catch(e) {
            const status=(await state.read())?.status;
            if(status==='ATTEMPT_STARTED'&&['INVENTORY_OR_QUOTE_CONFLICT','QUOTE_PRICE_CHANGED'].includes(e.message)) {
              await state.write('MONITORING');await state.event('OFFER_CHANGED_BEFORE_SUBMISSION');
            } else {
              // Never replay a reservation or payment POST after an uncertain response.
              await waitForHandoff(context,state,selected,config,signal,safeError(e));return result;
            }
          }
        }
      } catch(e) {
        if(signal?.aborted)break;
        errors++;retry=e.retryAfterSeconds??0;
        await state.event('POLL_ERROR',{code:safeError(e),consecutiveErrors:errors});
        if(errors>=config.poll.maxConsecutiveErrors)throw new Error('TOO_MANY_POLL_ERRORS');
      }
      if(config.poll.maxCycles&&cycle>=config.poll.maxCycles)break;
      await sleep(delayMs(config.poll,errors,retry),undefined,{signal}).catch(()=>{});
    }
  } finally {await browser?.close().catch(()=>{});await state.release();}
}
async function readSnapshot(dir) {try {const fs=await import('node:fs/promises');return JSON.parse(await fs.readFile(path.join(dir,'availability.json'),'utf8'));}catch{return null;}}
export function safeError(e) {
  // Playwright error messages can include field values. Log controlled codes only.
  return /^[A-Z][A-Z0-9_:]{0,100}$/.test(e?.message??'')?e.message:(e?.name==='TimeoutError'?'BROWSER_TIMEOUT':'UNEXPECTED_ERROR');
}
