import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORIGIN, reserveUrl, publicCandidate, amount } from './domain.js';
import { verifyQuote } from './quote.js';
import { guestFields, configuredFields, autoCardFields, metadata, trustedPaymentUrl, urlMatches, unique } from './fields.js';
import { atomicJson } from './state.js';

export async function readQuote(page) {
  if(new URL(page.url()).origin!==ORIGIN)throw new Error('UNTRUSTED_PAGE');
  await page.waitForFunction(()=>window.$initialData?.candidateSet,null,{timeout:30000});
  return page.evaluate(()=>window.$initialData);
}
export async function completion(page,hotelCode) {
  if(page.isClosed() || new URL(page.url()).origin!==ORIGIN)return null;
  if(hotelCode) {
    const code=await page.evaluate(()=>new URL(location.href).searchParams.get('hotelCode')??window.$initialData?.candidateSet?.hotelCode??window.$initialData?.reservationGroup?.reservations?.[0]?.hotelCode);
    if(code!==hotelCode)return null;
  }
  if(!await page.getByRole('heading',{name:'予約完了',exact:true}).isVisible().catch(()=>false))return null;
  const text=await page.locator('body').innerText();
  return text.match(/予約番号\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{5,39})/)?.[1]??null;
}
export async function captureMetadata(page,dir) {
  await atomicJson(path.join(dir,'form-metadata.json'),await metadata(page));
}
export async function waitForHandoff(context,state,candidate,config,signal,reason) {
  await state.write('NEEDS_ATTENTION',{candidate:publicCandidate(candidate),reason});
  await state.event('NEEDS_ATTENTION',{reason,minutes:config.checkout.handoffMinutes});
  process.stdout.write('\x07');
  const page=context.pages().at(-1);
  if(page){await page.bringToFront().catch(()=>{});await captureMetadata(page,state.dir).catch(()=>{});}
  const end=Date.now()+config.checkout.handoffMinutes*60000;
  while(Date.now()<end&&!signal?.aborted) {
    for(const p of context.pages()) {
      const number=await completion(p,config.hotel.code).catch(()=>null);
      if(number){await state.write('CONFIRMED',{candidate:publicCandidate(candidate),reservationNumber:number});await state.event('CONFIRMED',{reservationNumber:number});return;}
    }
    if(!context.pages().length)break;
    await sleep(1000,undefined,{signal}).catch(()=>{});
  }
  await state.write('UNVERIFIED',{candidate:publicCandidate(candidate),reason:'MANUAL_REVIEW_REQUIRED'});
  await state.event('UNVERIFIED',{message:'未确认预约成功。请检查官网/邮件后再决定是否重试。'});
}
export async function paymentFlow(context,startPage,candidate,config,state,signal) {
  let page=startPage;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) {
    signal?.throwIfAborted();
    for(const p of context.pages()) {
      const number=await completion(p,config.hotel.code).catch(()=>null);
      if(number){await state.write('CONFIRMED',{candidate:publicCandidate(candidate),reservationNumber:number});await state.event('CONFIRMED');return;}
    }
    page=context.pages().find(p=>trustedPaymentUrl(p.url()))??startPage;
    if(trustedPaymentUrl(page.url()))break;
    await sleep(500,undefined,{signal});
  }
  if(!trustedPaymentUrl(page.url()))return waitForHandoff(context,state,candidate,config,signal,'PAYMENT_REDIRECT_OR_VERIFICATION');
  await page.waitForLoadState('domcontentloaded');
  await captureMetadata(page,state.dir);
  // Arrival at JTB is evidence of a payment session, not evidence of a held room.
  await state.write('PAYMENT_PAGE',{candidate:publicCandidate(candidate),holdConfirmed:false,holdExpiresAt:null});
  await autoCardFields(page,config);
  if(config.checkout.mode==='payment'||!config.checkout.paymentSteps.length)
    return waitForHandoff(context,state,candidate,config,signal,'JTB_PAYMENT_READY');
  for(const [i,step] of config.checkout.paymentSteps.entries()) {
    signal?.throwIfAborted();
    await page.waitForURL(u=>urlMatches(u.href,step.urlPrefix),{timeout:30000});
    if(!trustedPaymentUrl(page.url()))throw new Error('UNTRUSTED_PAYMENT_PAGE');
    await page.locator(step.readySelector).waitFor({state:'visible',timeout:30000});
    await configuredFields(page,step.fields,config);
    const text=(await (await unique(page,step.totalSelector)).innerText()).trim();
    const nums=text.match(/\d[\d,]*/g);
    if(!text.includes(step.currencyText)||nums?.length!==1||amount(nums[0])!==candidate.totalJpy)throw new Error('PAYMENT_TOTAL_MISMATCH');
    const invalid=await page.locator('input,select,textarea').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&!e.disabled&&e.willValidate&&!e.validity.valid).length);
    if(invalid)throw new Error('PAYMENT_FORM_VALIDATION_FAILED');
    const button=await unique(page,step.buttonSelector);
    const label=await button.evaluate(el=>(el.tagName==='INPUT'?el.value:el.textContent).trim());
    if(label!==step.buttonText)throw new Error('PAYMENT_BUTTON_CHANGED');
    signal?.throwIfAborted();
    await state.write('PAYMENT_SUBMITTING',{candidate:publicCandidate(candidate),step:i});
    signal?.throwIfAborted();
    await button.click({timeout:15000});
  }
  return waitForHandoff(context,state,candidate,config,signal,'AWAITING_CONFIRMATION_OR_3DS');
}
export async function submitToPayment(page,beforeSubmit,signal) {
  signal?.throwIfAborted();
  const submit=page.getByRole('button',{name:'決済へ進む',exact:true});
  if(!await submit.isEnabled() || (await submit.getAttribute('class')??'').includes('button-disabled'))throw new Error('RESERVATION_SUBMIT_DISABLED');
  await beforeSubmit();
  await submit.click({timeout:15000});
  const prompt=page.getByText('決済情報入力画面へ進みます。よろしいですか？',{exact:true});
  // Wait for the known confirmation dialog; its button is scoped to the dialog.
  await prompt.waitFor({state:'visible',timeout:10000});
  const modal=page.locator('.modal').filter({has:prompt}).filter({visible:true});
  if(await modal.count()!==1)throw new Error('CONFIRM_DIALOG_CHANGED');
  const button=modal.getByRole('button',{name:'OK',exact:true});
  signal?.throwIfAborted();
  await button.click({timeout:15000});
}
export async function checkout(context,page,candidate,config,state,signal) {
  signal?.throwIfAborted();
  const safe=publicCandidate(candidate);
  await state.write('ATTEMPT_STARTED',{candidate:safe});
  await page.goto(reserveUrl(candidate,config.guests,config.hotel),{waitUntil:'domcontentloaded'});
  const quote=verifyQuote(await readQuote(page),candidate,config);
  await atomicJson(path.join(state.dir,'review.json'),{candidate:safe,...quote});
  await state.event('QUOTE_VERIFIED',{totalJpy:quote.totalJpy,policySha256:quote.policySha256});
  await page.locator('input[name="lastName"]').filter({visible:true}).waitFor({state:'visible'});
  await guestFields(page,config,quote.questionForms);
  await state.write('PREPARED',{candidate:safe});
  if(config.checkout.mode==='prepare')return waitForHandoff(context,state,candidate,config,signal,'PREPARED_NOT_SUBMITTED');
  if(quote.policySha256!==config.checkout.acceptedCancellationPolicySha256)throw new Error('CANCELLATION_POLICY_CHANGED');
  verifyQuote(await readQuote(page),candidate,config);
  const invalid=await page.locator('input,select,textarea').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&!e.disabled&&e.willValidate&&!e.validity.valid).length);
  if(invalid)throw new Error('FORM_VALIDATION_FAILED');
  if(!config.checkout.allowFinalSubmit||!config.checkout.acceptTermsAndPrivacy)throw new Error('SUBMIT_NOT_ENABLED');
  await submitToPayment(page,()=>state.write('SUBMITTING',{candidate:safe}),signal);
  await paymentFlow(context,page,candidate,config,state,signal);
}
