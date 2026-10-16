import { nights, matches } from './domain.js';

export function shiftDate(date, offset) {
  return new Date(Date.parse(`${date}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10);
}
export function queryRange(config) {
  const map=new Map();
  for(const stay of config.stays) {
    const offsets=config.alternatives.enabled?
      Array.from({length:config.alternatives.daysBefore+config.alternatives.daysAfter+1},(_,i)=>i-config.alternatives.daysBefore):[0];
    for(const offset of offsets) {
      const s={checkIn:shiftDate(stay.checkIn,offset),checkOut:shiftDate(stay.checkOut,offset)};
      const key=`${s.checkIn}/${s.checkOut}`;
      const prev=map.get(key);
      if(!prev||Math.abs(offset)<Math.abs(prev.offset))map.set(key,{stay:s,offset,nights:nights(s),primary:offset===0});
    }
  }
  return [...map.values()].sort((a,b)=>Number(b.primary)-Number(a.primary)||Math.abs(a.offset)-Math.abs(b.offset)||a.offset-b.offset);
}
export function alternateFilter(config) {
  const a=config.alternatives;
  return {...config.filters,roomCodes:a.allRoomTypes?[]:a.roomCodes,roomKeywords:a.allRoomTypes?[]:a.roomKeywords,
    planCodes:[],planKeywords:[],maxTotalJpy:a.includeOverBudget?Number.MAX_SAFE_INTEGER:config.filters.maxTotalJpy};
}
export function rankAlternatives(candidates,config) {
  return candidates.map(c=>({...c,withinBudget:c.totalJpy+config.filters.extraTaxBudgetJpy<=config.filters.maxTotalJpy,
    preferredRoom:matches(c,{...config.filters,maxTotalJpy:Number.MAX_SAFE_INTEGER,extraTaxBudgetJpy:0})}))
    .sort((a,b)=>Math.abs(a.offset)-Math.abs(b.offset)||Number(b.preferredRoom)-Number(a.preferredRoom)||a.totalJpy-b.totalJpy||a.roomCode.localeCompare(b.roomCode));
}
