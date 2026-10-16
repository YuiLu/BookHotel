import { secret } from './config.js';
import { ORIGIN } from './domain.js';

export const JTB_ORIGINS=['https://www.jtbbookandpay.com','https://www2.jtbbookandpay.com'];
export function trustedPaymentUrl(raw) {
  try {const u=new URL(raw);return JTB_ORIGINS.includes(u.origin)&&!u.username&&!u.password;}catch{return false;}
}
export function urlMatches(raw,prefix) {
  const u=new URL(raw),p=new URL(prefix);
  return u.origin===p.origin && u.pathname.startsWith(p.pathname) && [...p.searchParams].every(([k,v])=>u.searchParams.get(k)===v);
}
export async function unique(root,selector) {
  const l=root.locator(selector).filter({visible:true});
  if(await l.count()!==1)throw new Error('FIELD_MISSING_OR_AMBIGUOUS');
  return l;
}
export async function fill(root,selector,value,action='fill') {
  const l=await unique(root,selector);
  if(action==='check')await checked(l,true);
  else if(action==='select')await l.selectOption(value);
  else {await l.fill(value);await l.press('Tab');}
}
export async function checked(locator,value) {
  const l=locator.filter({visible:true});
  if(await l.count()!==1)throw new Error('CHECKBOX_MISSING_OR_AMBIGUOUS');
  if(await l.isChecked()!==value) {
    const text=l.locator('xpath=..').locator('.input-label-text');
    // The site's wide label can overlap other elements. Click its visible text.
    if(await text.count()===1)await text.click();
    else await l.setChecked(value);
  }
  // Vue can replace the input on its next update; wait for the replacement state.
  for(let attempt=0;attempt<20;attempt++) {
    if(await l.isChecked()===value)return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('CHECKBOX_NOT_CHANGED');
}
export async function configuredFields(page,fields,config) {
  const origin=new URL(page.url()).origin;
  if(origin!==ORIGIN && !trustedPaymentUrl(page.url()))throw new Error('UNTRUSTED_PAGE');
  for(const f of fields) {
    let root=page;
    if(f.frameUrlPrefix) {
      const requested=new URL(f.frameUrlPrefix).origin;
      if(requested!==origin && !config.checkout.paymentFrameOrigins.includes(requested))throw new Error('UNTRUSTED_PAYMENT_FRAME');
      const frames=page.frames().filter(x=>/^https:/.test(x.url())&&urlMatches(x.url(),f.frameUrlPrefix));
      if(frames.length!==1)throw new Error('FRAME_MISSING_OR_AMBIGUOUS');root=frames[0];
    }
    await fill(root,f.selector,f.env?secret(f.env):(f.value??''),f.action);
  }
}
export async function hotelQuestions(page,config,questions=[]) {
  if(questions.some(q=>q.required&&!config.hotel.questions.some(a=>a.code===q.code&&a.title===q.title&&a.formType===q.formType)))throw new Error('HOTEL_QUESTIONS_CHANGED');
  const forms=page.locator('form.question_wrap').filter({visible:true});
  if(questions.length&&await forms.count()!==questions.length)throw new Error('QUESTION_FIELDS_CHANGED');
  for(const a of config.hotel.questions) {
    const index=questions.findIndex(q=>q.code===a.code&&q.title===a.title&&q.formType===a.formType);
    if(index<0)throw new Error('HOTEL_QUESTIONS_CHANGED');
    const form=forms.nth(index);
    const title=await form.locator('.item-question-title').evaluate(el=>{const copy=el.cloneNode(true);copy.querySelectorAll('.icon-required').forEach(e=>e.remove());return copy.textContent.trim();});
    if(title!==a.title)throw new Error('QUESTION_TITLE_CHANGED');
    const value=a.env?secret(a.env):a.checkoutKey?config.checkout[a.checkoutKey]:a.value;
    if(typeof value!=='string')throw new Error('QUESTION_ANSWER_MISSING');
    if(a.formType==='TEXT')await fill(form,'textarea[name="reservationQuestion"]',value);
    else await (await unique(form,'select[name="reservationQuestion"]')).selectOption({label:value});
  }
}
export async function guestFields(page,config,questions=[]) {
  const c=config.checkout,e=c.guestEnv;
  await checked(page.getByLabel('予約と同時に会員登録する',{exact:true}),false);
  for(const key of ['lastName','firstName','lastNameKana','firstNameKana'])await fill(page,`input[name="${key}"]`,secret(e[key]));
  await checked(page.locator('label:has(input[name="livingAbroad"]) input[type="checkbox"]'),c.overseas);
  if(c.overseas) {
    await fill(page,'input[name="phoneCountryCode"]',c.countryCallingCode);
  }
  const rawPhone=secret(e.phone);
  const parts=rawPhone.includes('-')?rawPhone.split('-'):
    c.overseas&&c.countryCallingCode==='86'&&/^1\d{10}$/.test(rawPhone)?[rawPhone.slice(0,3),rawPhone.slice(3,7),rawPhone.slice(7)]:[];
  if(parts.length!==3||parts.some(x=>!/^\d+$/.test(x)))throw new Error('PHONE_NEEDS_THREE_PARTS');
  for(const [i,n] of ['areaCode','exchangeNumber','subscriberNumber'].entries())await fill(page,`input[data-name="${n}"]`,parts[i]);
  await checked(page.locator(`input[name="gender"][value="${c.gender.toLowerCase()}"]`),true);
  await fill(page,'input[name="email"]',secret(e.email));
  await fill(page,'input[data-name="email-confirm"]',secret(e.email));
  await checked(page.getByLabel('予約者と同じ',{exact:true}),true);
  const types=['adults','childA','childB','childC','childD','infant'].filter(k=>config.guests[k]>0);
  for(const [prop,name] of [['male','numberOfMales'],['female','numberOfFemales'],['other','numberOfOthers']]) {
    const loc=page.locator(`select[name="${name}"]`).filter({visible:true});
    if(await loc.count()!==types.length)throw new Error('GENDER_FIELDS_CHANGED');
    for(const [i,t] of types.entries())await loc.nth(i).selectOption(String(c.genderCounts[t][prop]));
  }
  await fill(page,'select[name="reservationCheckInTime"]',c.arrivalTime,'select');
  await hotelQuestions(page,config,questions);
  await checked(page.getByLabel('オンラインカード決済',{exact:true}),true);
  await configuredFields(page,c.fields,config);
  if(c.acceptTermsAndPrivacy)await checked(page.getByLabel('約款、プライバシーポリシーに同意する',{exact:true}),true);
}
export async function autoCardFields(page,config) {
  if(!trustedPaymentUrl(page.url()))throw new Error('UNTRUSTED_PAYMENT_PAGE');
  if(config.checkout.paymentFields.length) return configuredFields(page,config.checkout.paymentFields,config);
  // Standard autocomplete attributes only; never guess a generic "number" or password input.
  const map={'cc-number':'number','cc-name':'holder','cc-exp-month':'month','cc-exp-year':'year','cc-csc':'cvc'};
  let count=0;
  for(const [a,key] of Object.entries(map)) {
    const l=page.locator(`[autocomplete="${a}"]`).filter({visible:true});
    if(await l.count()>1)throw new Error('CARD_FIELD_AMBIGUOUS');
    if(await l.count()===1) {
      const value=secret(config.checkout.cardEnv[key]);
      const tag=await l.evaluate(el=>el.tagName);
      if(tag==='SELECT')await l.selectOption(value);else {await l.fill(value);await l.press('Tab');}
      count++;
    }
  }
  return count;
}
export async function metadata(page) {
  const result=[];
  for(const frame of page.frames()) {
    if(!/^https?:/.test(frame.url()))continue;
    const u=new URL(frame.url());
    const fields=await frame.locator('input,select,textarea,button').evaluateAll(els=>els.filter(e=>e.getClientRects().length).map(e=>({
      tag:e.tagName,id:e.id,name:e.getAttribute('name'),dataName:e.getAttribute('data-name'),
      type:e.getAttribute('type'),autocomplete:e.getAttribute('autocomplete'),
      required:e.required===true,buttonText:e.tagName==='BUTTON'?e.textContent.trim():undefined,
    }))).catch(()=>[]);
    result.push({origin:u.origin,path:u.pathname,fields});
  }
  return result;
}
