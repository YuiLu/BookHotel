import { ORIGIN, SEARCH_PATH, LIST_PATH, parameters, parseCandidates, matches, retryAfter } from './domain.js';
import { setTimeout as sleep } from 'node:timers/promises';

export class SearchError extends Error {
  constructor(code, retry=0) {super(code);this.retryAfterSeconds=retry;}
}
export class DReserveSearch {
  constructor(context, config) {this.context=context;this.config=config;}
  async initialize(page) {
    const response=await page.goto(`${ORIGIN}${LIST_PATH}?${parameters(this.config.stays[0],this.config.guests,1,this.config.hotel)}`,{waitUntil:'domcontentloaded'});
    if(!response?.ok())throw new SearchError('INITIAL_PAGE_ERROR');
    await page.waitForFunction(()=>window.vm?.hotelCode, null,{timeout:30000});
    const hotel=await page.evaluate(()=>window.vm.hotelCode);
    if(hotel!==this.config.hotel.code)throw new SearchError('HOTEL_MISMATCH');
  }
  async page(stay, pageNumber) {
    const r=await this.context.request.get(`${ORIGIN}${SEARCH_PATH}?${parameters(stay,this.config.guests,pageNumber,this.config.hotel)}`,{
      timeout:this.config.poll.requestTimeoutSeconds*1000,maxRedirects:0,
      headers:{Accept:'application/json','Accept-Language':'ja-JP,ja;q=0.9'},
    });
    try {
      if(r.status()===429 || r.headers()['x-dyn-access-limit-exceeded']==='true')
        throw new SearchError('RATE_LIMITED',Math.max(60,retryAfter(r.headers()['retry-after'])));
      if(r.status()===403)throw new SearchError('ACCESS_DENIED',600);
      if(!r.ok())throw new SearchError('SEARCH_HTTP_ERROR',retryAfter(r.headers()['retry-after']));
      if(!r.headers()['content-type']?.includes('json'))throw new SearchError('SEARCH_NOT_JSON');
      return await r.json();
    } finally {await r.dispose();}
  }
  async find(stay, signal, filters=this.config.filters) {
    const candidates=[];let exhausted=false;
    for(let n=1;n<=this.config.poll.maxPages;n++) {
      signal?.throwIfAborted();
      const data=await this.page(stay,n);
      candidates.push(...parseCandidates(data,stay,this.config.hotel).filter(c=>matches(c,filters)));
      if(data.resultCount===0){exhausted=true;break;}
      if(!Number.isInteger(data.pagingCount)||data.pagingCount<=0)throw new SearchError('PAGINATION_SCHEMA_CHANGED');
      if(n*data.pagingCount>=data.resultCount){exhausted=true;break;}
      await sleep(1500,undefined,{signal});
    }
    if(!exhausted)throw new SearchError('SEARCH_PAGE_LIMIT');
    return candidates.sort((a,b)=>a.totalJpy-b.totalJpy);
  }
}
