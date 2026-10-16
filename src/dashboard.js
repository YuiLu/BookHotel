import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import { schema, validateSecrets, runtimeDirectory } from './config.js';
import { run, safeError } from './runner.js';
import { atomicJson, atomicText } from './state.js';
import { sendPushPlus } from './notifications.js';
import { reserveUrl } from './domain.js';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRESETS = [
  {id:'ubuya',name:'湖山亭 产屋',region:'河口湖 · 山梨',engine:'Tripla',file:'config.ubuya.nov29.example.json',roomHint:'20 · 98㎡ 露天浴池特别房'},
  {id:'kogetsu',name:'秀峰阁 湖月',region:'河口湖 · 山梨',engine:'D-Reserve',file:'config.monitor.jan3.example.json',roomHint:'RM00010240 · 日式房'},
  {id:'nagisakan',name:'热海 渚馆',region:'热海 · 静冈',engine:'D-Reserve',file:'config.nagisakan.example.json',roomHint:'RM00019024'},
  {id:'kariyushi',name:'冲绳 Kariyushi',region:'恩纳村 · 冲绳',engine:'D-Reserve',file:'config.kariyushi.example.json',roomHint:'RM00022712'},
];
const formSchema=z.object({
  hotelId:z.enum(['ubuya','kogetsu','nagisakan','kariyushi']),
  checkIn:z.string(),checkOut:z.string(),adults:z.number().int().min(1).max(6),
  roomCodes:z.string().max(1000),roomKeywords:z.string().max(1000),planCodes:z.string().max(1000),
  maxTotalJpy:z.number().int().positive(),extraTaxBudgetJpy:z.number().int().nonnegative(),
  intervalSeconds:z.number().min(30).max(86400),
  alternativesEnabled:z.boolean(),daysBefore:z.number().int().min(0).max(30),daysAfter:z.number().int().min(0).max(30),
  allRoomTypes:z.boolean(),pushEnabled:z.boolean(),includeAlternatives:z.boolean(),notifyOnRestock:z.boolean(),
}).strict();
const split=s=>s.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
const fail=(status,code)=>Object.assign(new Error(code),{status});
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const messages={PROCESS_LOCKED:'该酒店已有查询进程，请先停止其他终端中的监控。',CONFIG_PAST_DATE:'入住日期已过去，请选择未来日期。',
  PREVIOUS_ATTEMPT_REQUIRES_REVIEW:'该酒店有待人工核实的预约记录，请先在命令行核实处理。',BUSY:'请先停止当前任务，再修改设置。',
  MISSING_ENV:'请先配置 PushPlus token。',BROWSER_TIMEOUT:'酒店页面响应超时，请稍后重试。',
  UNEXPECTED_ERROR:'操作未完成，请检查网络或浏览器安装。',TOO_MANY_POLL_ERRORS:'连续查询失败，监控已停止，请检查网络后重试。'};
export function explainError(e) {
  if(e?.name==='ZodError')return e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；');
  const code=safeError(e);return messages[code]??(code.startsWith('MISSING_ENV:')?messages.MISSING_ENV:code);
}

export async function createDashboard({root=PROJECT_ROOT,jobRun=run,pushSend=sendPushPlus}={}) {
  dotenv.config({path:path.join(root,'.env'),quiet:true});
  const savedFile=path.join(root,'dashboard.config.json');
  let selected,active=null,lastJob=null,sequence=0,tokenBusy=false,lastTestAt=0,mutating=false;
  const templates=new Map();
  for(const p of PRESETS) {
    const raw=JSON.parse(await fs.readFile(path.join(root,p.file),'utf8'));
    raw.notifications={pushplus:{...raw.notifications?.pushplus,tokenEnv:'PUSHPLUS_TOKEN',enabled:false}};
    raw.checkout={...raw.checkout,mode:'monitor',allowFinalSubmit:false};
    raw.browser={headless:true,channel:'chromium'};
    templates.set(p.id,schema.parse(raw));
  }
  function defaultForm(id) {
    const c=templates.get(id);
    return {hotelId:id,checkIn:c.stays[0].checkIn,checkOut:c.stays[0].checkOut,adults:c.guests.adults,
      roomCodes:c.filters.roomCodes.join(', '),roomKeywords:c.filters.roomKeywords.join(', '),planCodes:c.filters.planCodes.join(', '),
      maxTotalJpy:c.filters.maxTotalJpy,extraTaxBudgetJpy:c.filters.extraTaxBudgetJpy,intervalSeconds:c.poll.intervalSeconds,
      alternativesEnabled:c.alternatives.enabled,daysBefore:c.alternatives.daysBefore,daysAfter:c.alternatives.daysAfter,
      allRoomTypes:c.alternatives.allRoomTypes,pushEnabled:false,includeAlternatives:false,notifyOnRestock:false};
  }
  function configuration(input) {
    const f=formSchema.parse(input),base=structuredClone(templates.get(f.hotelId));
    base.stays=[{checkIn:f.checkIn,checkOut:f.checkOut}];base.guests.adults=f.adults;
    base.filters={...base.filters,roomCodes:split(f.roomCodes),roomKeywords:split(f.roomKeywords),planCodes:split(f.planCodes),
      maxTotalJpy:f.maxTotalJpy,extraTaxBudgetJpy:f.extraTaxBudgetJpy};
    base.poll={...base.poll,intervalSeconds:f.intervalSeconds,maxBackoffSeconds:Math.max(1800,f.intervalSeconds),maxCycles:0};
    base.alternatives={...base.alternatives,enabled:f.alternativesEnabled,daysBefore:f.daysBefore,daysAfter:f.daysAfter,
      allRoomTypes:f.allRoomTypes,allowBooking:false};
    base.notifications.pushplus={...base.notifications.pushplus,enabled:f.pushEnabled,includeAlternatives:f.includeAlternatives,notifyOnRestock:f.notifyOnRestock};
    return schema.parse(base);
  }
  try {selected=formSchema.parse(JSON.parse(await fs.readFile(savedFile,'utf8')));configuration(selected);}
  catch(e) {if(e.code!=='ENOENT')throw new Error('DASHBOARD_CONFIG_INVALID');selected=defaultForm('ubuya');}
  const session=randomBytes(32).toString('hex');
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  async function body(req) {
    if(req.headers['content-type']!=='application/json')throw fail(415,'JSON_REQUIRED');
    let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>16384)throw fail(413,'BODY_TOO_LARGE');}
    try{return JSON.parse(text);}catch{throw fail(400,'INVALID_JSON');}
  }
  async function read(file,fallback=null) {try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
  async function directory() {return runtimeDirectory(path.join(root,PRESETS.find(p=>p.id===selected.hotelId).file));}
  async function status() {
    const c=configuration(selected),dir=await directory();
    const snapshot=await read(path.join(dir,'availability.json'));
    if(snapshot?.hotelCode===c.hotel.code) {
      for(const kind of ['primary','alternatives'])for(const offer of snapshot[kind]??[])
        offer.bookingUrl=reserveUrl(offer,c.guests,c.hotel);
    }
    const push=await read(path.join(dir,'pushplus-state.json'));
    const counts={accepted:0,uncertain:0,rejected:0,pending:0};
    for(const r of Object.values(push?.entries??{}))if(r.status in counts)counts[r.status]++;
    let events=[];
    try {
      const h=await fs.open(path.join(dir,'events.jsonl'),'r');
      try {const {size}=await h.stat(),b=Buffer.alloc(Math.min(size,65536));await h.read(b,0,b.length,Math.max(0,size-b.length));
        events=b.toString().split('\n').flatMap(line=>{try{const e=JSON.parse(line);return [{at:e.at,type:e.type,code:e.code,primary:e.primary?.length,alternatives:e.alternatives?.length,combinations:e.combinations}];}catch{return [];}}).slice(-30).reverse();
      }finally{await h.close();}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const env=process.env.PUSHPLUS_TOKEN;
    return {form:selected,job:active?{...active.info}:lastJob,tokenConfigured:Boolean(env&&!/^(CHANGE_ME|YOUR_|REPLACE_)/.test(env)),
      snapshot:snapshot?.hotelCode===c.hotel.code?snapshot:null,push:counts,events,now:new Date().toISOString()};
  }
  async function stop() {if(active){active.info.status='stopping';active.abort.abort();await active.promise;}}
  const server=http.createServer(async(req,res)=>{
    let ownsMutation=false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const origin=`http://127.0.0.1:${server.address()?.port}`;
      if(req.headers.host!==new URL(origin).host)throw fail(403,'INVALID_HOST');
      if(req.headers.origin&&req.headers.origin!==origin)throw fail(403,'INVALID_ORIGIN');
      const url=new URL(req.url,origin);
      const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      if(req.method==='GET'&&assets[url.pathname]) {
        if(url.pathname==='/')res.setHeader('Set-Cookie',`bookhotel=${session}; HttpOnly; SameSite=Strict; Path=/`);
        const [file,type]=assets[url.pathname];res.setHeader('Content-Type',type);
        return res.end(await fs.readFile(path.join(root,'web',file)));
      }
      const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('bookhotel='))?.slice(10)??'';
      if(!same(cookie,session))throw fail(403,'SESSION_REQUIRED');
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,await status());
      if(req.method==='GET'&&url.pathname==='/api/presets')return json(res,200,PRESETS.map(p=>({...p,file:undefined,defaults:defaultForm(p.id)})));
      if(req.method!=='POST'||req.headers['x-bookhotel-client']!=='1')throw fail(403,'CLIENT_HEADER_REQUIRED');
      if(url.pathname!=='/api/stop') {
        if(mutating)throw fail(409,'BUSY');
        mutating=true;ownsMutation=true;
      }
      if(url.pathname==='/api/config') {
        if(active||tokenBusy)throw fail(409,'BUSY');
        const f=formSchema.parse(await body(req));configuration(f);
        await atomicJson(savedFile,f);selected=f;lastJob=null;return json(res,200,await status());
      }
      if(url.pathname==='/api/token') {
        if(active||tokenBusy)throw fail(409,'BUSY');
        const {token}=z.object({token:z.string().trim().regex(/^[A-Za-z0-9_-]{16,160}$/)}).strict().parse(await body(req));
        tokenBusy=true;
        try {const file=path.join(root,'.env');let text=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
          text=text.split(/\r?\n/).filter(line=>!/^\s*(?:export\s+)?PUSHPLUS_TOKEN\s*=/.test(line)).join('\n');
          await atomicText(file,`${text.trimEnd()}\nPUSHPLUS_TOKEN=${token}\n`);process.env.PUSHPLUS_TOKEN=token;
        }finally{tokenBusy=false;}
        return json(res,200,{configured:true});
      }
      if(url.pathname==='/api/notify-test') {
        if(Date.now()-lastTestAt<15000)throw fail(429,'请等待 15 秒再发送测试通知。');
        lastTestAt=Date.now();const c=configuration(selected);
        const receipt=await pushSend(c.notifications.pushplus,{title:'宿见 · PushPlus 测试',content:'<p>通知通道测试。不会查询酒店或更改空房去重记录。</p>'});
        if(receipt.status!=='accepted')throw fail(502,`PUSHPLUS_${receipt.status.toUpperCase()}`);
        return json(res,200,{accepted:true});
      }
      if(url.pathname==='/api/start') {
        if(active||tokenBusy)throw fail(409,'BUSY');
        const {once}=z.object({once:z.boolean()}).strict().parse(await body(req));
        const c=configuration(selected);
        const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
        if(c.stays.some(s=>s.checkIn<today))throw fail(400,'CONFIG_PAST_DATE');
        validateSecrets(c);
        const dir=await directory(),abort=new AbortController();
        const task={abort,info:{id:++sequence,status:'running',once,startedAt:new Date().toISOString(),hotelId:selected.hotelId}};
        active=task;
        task.promise=Promise.resolve().then(async()=>{
          const old=await read(path.join(root,'runtime','state.json'));
          if(old&&!['MONITORING','RESOLVED_NOT_BOOKED'].includes(old.status))throw new Error('LEGACY_ATTEMPT_REQUIRES_REVIEW');
          await jobRun(c,dir,{once,signal:abort.signal});
        }).then(()=>{task.info.status=abort.signal.aborted?'stopped':'completed';},e=>{
          task.info.status=abort.signal.aborted?'stopped':'error';if(!abort.signal.aborted)task.info.error=explainError(e);
        }).finally(()=>{task.info.finishedAt=new Date().toISOString();lastJob=task.info;if(active===task)active=null;});
        return json(res,202,{job:task.info});
      }
      if(url.pathname==='/api/stop') {if(active){active.info.status='stopping';active.abort.abort();}return json(res,202,{stopping:Boolean(active)});}
      throw fail(404,'NOT_FOUND');
    }catch(e) {if(!res.headersSent)json(res,e.status??(e.name==='ZodError'?400:500),{error:explainError(e)});else res.end();}
    finally {if(ownsMutation)mutating=false;}
  });
  return {server,stop};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT??4173);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_PORT');
  const app=await createDashboard();
  app.server.listen(port,'127.0.0.1',()=>console.log(`宿见已启动：http://127.0.0.1:${port}`));
  app.server.on('error',()=>{console.error('控制台启动失败，请检查端口是否被占用。');process.exitCode=1;});
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;app.server.close();await app.stop();app.server.closeAllConnections();};
  process.once('SIGINT',close);process.once('SIGTERM',close);
}
