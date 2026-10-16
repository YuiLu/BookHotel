// Public-site probe: every non-GET/HEAD browser request is aborted.
// This intentionally never calls paymentFlow or fills payment details.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, runtimeDirectory } from '../src/config.js';
import { openBrowser } from '../src/browser.js';
import { DReserveSearch } from '../src/search.js';
import { reserveUrl, ORIGIN, publicCandidate } from '../src/domain.js';
import { verifyQuote } from '../src/quote.js';
import { guestFields, metadata } from '../src/fields.js';
import { readQuote, submitToPayment } from '../src/checkout.js';
import { atomicJson, privateDir } from '../src/state.js';
import { safeError } from '../src/runner.js';

async function main() {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){if(!['--config','--runtime'].includes(args[i])||!args[i+1])throw new Error('UNKNOWN_ARGUMENT');options[args[i].slice(2)]=args[i+1];}
  const file=path.resolve(options.config??path.join(root,'config.validation.json'));
  const config=await loadConfig(file),dir=await runtimeDirectory(file,options.runtime);
  if(config.guests.adults!==2||Object.entries(config.guests).some(([k,v])=>k!=='adults'&&v!==0))throw new Error('VALIDATION_GUESTS_MUST_BE_TWO_ADULTS');
  config.checkout={...config.checkout,mode:'monitor',fields:[],overseas:true,countryCallingCode:'86',gender:'MALE',
    genderCounts:{adults:{male:1,female:1,other:0}},transport:'公共交通機関',acceptTermsAndPrivacy:true};
  const fake={lastName:'Validation',firstName:'Test',lastNameKana:'てすと',firstNameKana:'てすと',email:'validation@example.invalid',phone:'138-0000-0000'};
  for(const q of config.hotel.questions)if(q.env)process.env[q.env]='VALIDATION';
  for(const [key,value] of Object.entries(fake))process.env[config.checkout.guestEnv[key]]=value;
  const {browser,context,page}=await openBrowser(config);const blocked=[];
  await context.route('**/*',async route=>{
    const r=route.request();
    if(!['GET','HEAD'].includes(r.method())) {
      const u=new URL(r.url());if(u.origin===ORIGIN)blocked.push({method:r.method(),path:u.pathname});
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  try {
    const search=new DReserveSearch(context,config);await search.initialize(page);
    const candidate=(await search.find(config.stays[0]))[0];if(!candidate)throw new Error('NO_MATCHING_OFFER');
    await page.goto(reserveUrl(candidate,config.guests,config.hotel),{waitUntil:'domcontentloaded'});
    const quote=verifyQuote(await readQuote(page),candidate,config);
    await page.locator('input[name="lastName"]').filter({visible:true}).waitFor();
    await guestFields(page,config,quote.questionForms);
    const invalid=await page.locator('input,select,textarea').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&!e.disabled&&e.willValidate&&!e.validity.valid).map(e=>({name:e.name,dataName:e.dataset.name,type:e.type})));
    const button=page.getByRole('button',{name:'決済へ進む',exact:true});
    const disabled=!await button.isEnabled()||(await button.getAttribute('class')??'').includes('button-disabled');
    if(!invalid.length&&!disabled){await submitToPayment(page,async()=>{});await page.waitForTimeout(1000);}
    const report={at:new Date().toISOString(),hotelCode:config.hotel.code,hotelName:quote.hotelName,
      candidate:publicCandidate(candidate),quoteTotalJpy:quote.totalJpy,
      paymentMethods:quote.paymentMethods,cancellationEstimate:quote.cancellationEstimate,
      policySha256:quote.policySha256,invalid,disabled,blockedMutations:blocked,
      reachedInterceptedEntry:blocked.some(r=>r.path==='/guest-reserve-front/reservation/entry'),form:await metadata(page)};
    await privateDir(dir);await atomicJson(path.join(dir,'live-validation.json'),report);
    console.log(`只读验证：表单无效项 ${invalid.length}，预约入口拦截 ${report.reachedInterceptedEntry}。报告：${path.join(dir,'live-validation.json')}`);
    if(invalid.length||disabled||!report.reachedInterceptedEntry)throw new Error('LIVE_VALIDATION_INCOMPLETE');
  }finally{await browser.close();}
}
main().catch(e=>{console.error('停止：',safeError(e));process.exitCode=1;});
