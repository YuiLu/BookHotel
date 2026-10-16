// Public-site test: anonymous widget sessions are allowed; reservation/payment writes are blocked.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, runtimeDirectory } from '../src/config.js';
import { openBrowser } from '../src/browser.js';
import { TriplaSearch, triplaGuestFields } from '../src/tripla.js';
import { publicCandidate } from '../src/domain.js';
import { metadata } from '../src/fields.js';
import { atomicJson, privateDir } from '../src/state.js';
import { safeError } from '../src/runner.js';

export function anonymousTriplaRequest(request) {
  const u=new URL(request.url());
  return request.method()==='POST'&&(
    u.origin==='https://idp.tripla.ai'&&/^\/(book|chatbot)\/api\/client_sessions$/.test(u.pathname)||
    u.origin==='https://concierge.tripla.ai'&&['/chatbot/api/triplabot/v1/chats/init','/chatbot/api/v1/auth/anonymous_sign_in'].includes(u.pathname));
}
async function main() {
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){if(!['--config','--runtime'].includes(args[i])||!args[i+1])throw new Error('UNKNOWN_ARGUMENT');options[args[i].slice(2)]=args[i+1];}
  const file=path.resolve(options.config??'config.ubuya.example.json');
  const config=await loadConfig(file),dir=await runtimeDirectory(file,options.runtime);
  if(config.hotel.engine!=='tripla')throw new Error('HOTEL_ENGINE_MISMATCH');
  const fake={lastName:'Validation',firstName:'Test',email:'validation@example.invalid',phone:'13800000000'};
  for(const [key,value]of Object.entries(fake))process.env[config.checkout.guestEnv[key]]=value;
  config.checkout.fields=[];
  const {browser,context,page}=await openBrowser({...config,browser:{...config.browser,headless:true}}),blocked=[];
  await context.route('**/*',async route=>{
    const request=route.request();
    if(!['GET','HEAD','OPTIONS'].includes(request.method())&&!anonymousTriplaRequest(request)) {
      const u=new URL(request.url());
      if(u.hostname.endsWith('.tripla.ai'))blocked.push({method:request.method(),origin:u.origin,path:u.pathname});
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  try {
    const search=new TriplaSearch(context,config);await search.initialize(page);
    const candidate=(await search.find(config.stays[0]))[0];
    if(!candidate)throw new Error('NO_MATCHING_OFFER');
    const {frame}=await search.openOffer(page,candidate);
    await triplaGuestFields(frame,config);
    const filled=await frame.locator('#email,#email-confirm,#last-name-0,#first-name-0,#phone').filter({visible:true})
      .evaluateAll(es=>es.map(e=>({id:e.id,filled:!!e.value})));
    if(filled.length!==5||filled.some(f=>!f.filled))throw new Error('LIVE_VALIDATION_INCOMPLETE');
    const report={at:new Date().toISOString(),engine:'tripla',hotelCode:config.hotel.code,hotelName:config.hotel.name,
      candidate:publicCandidate(candidate),stage:new URL(frame.url()).pathname,contactFields:filled,
      blockedTriplaMutations:blocked,form:await metadata(page),nextButtonClicked:false,
      realReservationCreated:false,realPaymentTested:false,holdConfirmed:false};
    await privateDir(dir);await atomicJson(path.join(dir,'live-validation.json'),report);
    console.log(`Tripla 实站验证：报价 ${candidate.totalJpy} JPY；到达旅客信息页，5 个联系字段已填；未点击下一步。报告：${path.join(dir,'live-validation.json')}`);
  }finally{await browser.close();}
}
// Importable guard for tests; running the script executes the probe.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error('停止：',safeError(e));process.exitCode=1;});
