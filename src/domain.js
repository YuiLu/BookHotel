import { createHash } from 'node:crypto';
import { DEFAULT_HOTEL, LODGER_TYPES } from './profiles.js';
import { triplaUrl } from './tripla-url.js';
export const ORIGIN = 'https://d-reserve.jp';
export const SEARCH_PATH = '/GSEA001F01300/GSEA001A06';
export const LIST_PATH = '/GSEA001F01300/GSEA001A01';
export const RESERVE_PATH = '/guest-reserve-front/GRES001F02100/GRES001A01';
export const compact = d => d.replaceAll('-','');
export const nights = s => (Date.parse(s.checkOut)-Date.parse(s.checkIn))/86400000;
export const guestCounts = g => [g.adults,g.childA,g.childB,g.childC,g.childD,g.infant];
export const sha256 = s => createHash('sha256').update(s).digest('hex');
export function guestParameters(guests,hotel=DEFAULT_HOTEL) {
  for(const t of LODGER_TYPES)if(guests[t.key]>0&&!hotel.lodgerTypeCodes.includes(t.code))throw new Error('UNSUPPORTED_GUEST_CATEGORY');
  const types=hotel.lodgerTypeCodes.map(code=>LODGER_TYPES.find(t=>t.code===code));
  if(types.some(t=>!t))throw new Error('UNSUPPORTED_GUEST_CATEGORY');
  return {lt001:types.map(t=>t.code).join('_'),lnum001:types.map(t=>guests[t.key]??0).join('_')};
}
export function parameters(stay, guests, page=1,hotel=DEFAULT_HOTEL) {
  return new URLSearchParams({hotelCode:hotel.code,lodgingDateFrom:compact(stay.checkIn),lodgingDateTo:compact(stay.checkOut),
    sumrm:'1',dpck:'false',pagingKey:String(page),sortKeyOrder:'0',DPCheckEnable:'false',...guestParameters(guests,hotel)});
}
export function reserveUrl(candidate, guests,hotel=DEFAULT_HOTEL) {
  if(candidate.hotelCode&&candidate.hotelCode!==hotel.code)throw new Error('CANDIDATE_HOTEL_MISMATCH');
  if(hotel.engine==='tripla')return triplaUrl(candidate.stay,guests,hotel,{roomCode:candidate.roomCode,planCode:candidate.hotelPlanCode});
  const p = new URLSearchParams({hotelCode:hotel.code,pl:candidate.planCode,rmcd001:candidate.roomCode,rm001:'1',
    ...guestParameters(guests,hotel),ci:compact(candidate.stay.checkIn),co:compact(candidate.stay.checkOut),
    stay:String(nights(candidate.stay)),sumrm:'1',way:'1',dpck:'false'});
  return `${ORIGIN}${RESERVE_PATH}?${p}`;
}
export function amount(v) {
  if(typeof v==='number') return Number.isSafeInteger(v) && v>0 ? v:null;
  if(typeof v!=='string' || !/^\d+(?:,\d{3})*$/.test(v)) return null;
  const n=Number(v.replaceAll(',','')); return Number.isSafeInteger(n)&&n>0?n:null;
}
export function parseCandidates(data, stay,hotel=DEFAULT_HOTEL) {
  if(!data || !Array.isArray(data.planDetailResources) || !Number.isInteger(data.resultCount)) throw new Error('SEARCH_SCHEMA_CHANGED');
  const found=[];
  for(const p of data.planDetailResources) {
    if(!Array.isArray(p.roomSearchResults)) throw new Error('SEARCH_SCHEMA_CHANGED');
    if(p.memberLimit !== '0' || p.dayuseSearch || p.dynamicPackageCheckEnable) continue;
    for(const group of p.roomSearchResults) {
      const rooms=group.roomSearchResults;
      if(group.combinationFlg !== 'N' || !Array.isArray(rooms) || rooms.length!==1) continue;
      const r=rooms[0], total=amount(group.planPrice);
      // referencePrice is a per-person "from" price. Never use it as a booking total.
      if(!total || group.planPriceText !== '合計' || !/^PL\w+$/.test(p.planCode) || !/^RM\w+$/.test(r.roomTypeCode)) continue;
      found.push({hotelCode:hotel.code,stay,planCode:p.planCode,planName:p.planTitle,roomCode:r.roomTypeCode,roomName:r.roomTypeName,
        totalJpy:total,paymentMethods:p.paymentMethods,description:p.planDescription});
    }
  }
  return found;
}
export function matches(c, f) {
  const includes=(list,v)=>!list.length || list.some(x=>v.includes(x));
  return (!f.roomCodes.length||f.roomCodes.includes(c.roomCode)) && (!f.planCodes.length||f.planCodes.includes(c.planCode)) &&
    includes(f.roomKeywords,c.roomName) && includes(f.planKeywords,c.planName) &&
    !f.excludedKeywords.some(x=>`${c.planName} ${c.roomName}`.includes(x)) && c.totalJpy+f.extraTaxBudgetJpy<=f.maxTotalJpy;
}
export function delayMs(poll, errors=0, retryAfterSeconds=0, random=Math.random) {
  const base=Math.min(poll.maxBackoffSeconds,poll.intervalSeconds*2**Math.min(errors,20));
  return (Math.max(base,retryAfterSeconds)+random()*poll.jitterSeconds)*1000;
}
export function retryAfter(value, now=Date.now()) {
  if(!value) return 0;
  const n=Number(value);return Number.isFinite(n)?Math.max(0,n):Math.max(0,(Date.parse(value)-now)/1000)||0;
}
export function publicCandidate(c) {
  const {description,...safe}=c;return safe;
}
