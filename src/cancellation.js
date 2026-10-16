export function tokyoDate(now=new Date()) {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(now);
}
// D-Reserve rate keys are the upper day bounds, with -1 reserved for a no-show.
// Beyond the largest bound, zero is inferred from the table; expose this inference.
export function cancellationEstimate(policy,stay,today=tokyoDate()) {
  const days=(Date.parse(stay.checkIn)-Date.parse(today))/86400000;
  const raw=policy?.rate;
  const unknown={asOfDate:today,daysBeforeCheckIn:days,ratePercent:null,freeDaysRemaining:null,basis:'unknown'};
  if(!Number.isInteger(days)||days<0||!raw||typeof raw!=='object'||Array.isArray(raw))return unknown;
  const rows=Object.entries(raw).map(([k,v])=>({day:Number(k),rate:v}));
  if(!rows.length||rows.some(r=>!Number.isInteger(r.day)||r.day<-1||typeof r.rate!=='number'||!Number.isFinite(r.rate)||r.rate<0||r.rate>100))return unknown;
  const bands=rows.filter(r=>r.day>=0).sort((a,b)=>a.day-b.day);
  if(!bands.length)return unknown;
  const forDay=d=>bands.find(r=>d<=r.day)?.rate??0;
  const band=bands.find(r=>days<=r.day),rate=forDay(days);
  const chargeStarts=bands.filter(r=>r.rate>0).at(-1)?.day;
  // A non-monotonic policy is readable, but cannot authorize automatic free-cancel tests.
  const monotonic=bands.every((r,i)=>i===0||r.rate<=bands[i-1].rate);
  return {asOfDate:today,daysBeforeCheckIn:days,ratePercent:rate,
    freeDaysRemaining:rate===0&&monotonic?(chargeStarts===undefined?days:Math.max(0,days-chargeStarts)):null,
    basis:band?'structured-rate-table':'inferred-beyond-last-rate-bound',monotonic};
}
export function assertFreeCancellation(estimate,config) {
  if(!config.checkout.requireFreeCancellation)return;
  if(estimate.ratePercent!==0||estimate.freeDaysRemaining===null||estimate.freeDaysRemaining<config.checkout.freeCancellationBufferDays)
    throw new Error('FREE_CANCELLATION_REQUIRED');
}
