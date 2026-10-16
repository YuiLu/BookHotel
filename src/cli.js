#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validateSecrets, runtimeDirectory, secret } from './config.js';
import { run, safeError } from './runner.js';
import { State, atomicJson, privateDir } from './state.js';
import { openBrowser } from './browser.js';
import { createSearch } from './engines.js';
import { readQuote, captureMetadata } from './checkout.js';
import { reserveUrl, publicCandidate } from './domain.js';
import { verifyQuote } from './quote.js';
import { sendPushPlus } from './notifications.js';

function args(tokens) {
  const result={};
  for(let i=0;i<tokens.length;i++) {
    const key=tokens[i];if(!key.startsWith('--'))throw new Error('UNKNOWN_ARGUMENT');
    if(!['--once','--acknowledge-not-booked','--config','--runtime','--plan','--room'].includes(key))throw new Error('UNKNOWN_ARGUMENT');
    if(['--once','--acknowledge-not-booked'].includes(key))result[key.slice(2)]=true;
    else {if(!tokens[i+1]||tokens[i+1].startsWith('--'))throw new Error('ARGUMENT_NEEDS_VALUE');result[key.slice(2)]=tokens[++i];}
  }
  return result;
}
async function main() {
  const command=process.argv[2]??'help',a=args(process.argv.slice(3));
  const file=path.resolve(a.config??'config.json');
  if(command==='help')return console.log(`使用：
  node src/cli.js check --config config.json       校验配置（无网络）
  node src/cli.js scan --config config.json        一次查询目标与备选
  node src/cli.js run --config config.json         持续轮询
  node src/cli.js notify-test --config config.json 测试 PushPlus（不查询酒店）
  node src/cli.js notify-reset --config config.json 清除通知去重记录，下轮可重新提醒
  node src/cli.js inspect --config config.json     只读查看有房方案的表单/取消政策
  node src/cli.js resolve --acknowledge-not-booked  核实未成单后解除重试保护
  node src/cli.js unlock                          只清理已退出进程的锁
  支持 --runtime PATH、--plan PL编号、--room RM编号。敏感信息放 .env。`);
  const dir=await runtimeDirectory(file,a.runtime);
  if(command==='unlock') {
    const file=path.join(dir,'process.lock');
    const lock=JSON.parse(await fs.readFile(file,'utf8'));
    try {process.kill(lock.pid,0);throw new Error('PROCESS_STILL_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}
    await fs.unlink(file);return console.log('已移除失效的进程锁。预约状态保持原样。');
  }
  if(command==='resolve') {
    if(!a['acknowledge-not-booked'])throw new Error('MANUAL_REVIEW_REQUIRED');
    const state=new State(dir);await state.acquire();
    try {const previous=await state.read();await atomicJson(path.join(dir,`state-review-${Date.now()}.json`),previous);await state.write('RESOLVED_NOT_BOOKED');}
    finally {await state.release();}
    return console.log('已记录人工核实未成单，允许重新启动。');
  }
  const config=await loadConfig(file);
  if(command==='check'){validateSecrets(config);return console.log(`配置有效：${config.stays.length} 个目标，模式 ${config.checkout.mode}。`);}
  if(command==='notify-reset') {
    const state=new State(dir,config.hotel.code);await state.acquire();
    try {await fs.rm(path.join(dir,'pushplus-state.json'),{force:true});}
    finally {await state.release();}
    return console.log('已清除 PushPlus 通知记录，下次监控可重新推送。预约状态保持原样。');
  }
  const abort=new AbortController();const stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    if(command==='notify-test') {
      const settings=config.notifications.pushplus;
      secret(settings.tokenEnv);
      const receipt=await sendPushPlus(settings,{title:'酒店空房监控：PushPlus 测试',content:'<p>PushPlus 测试通知。此操作没有查询酒店、创建预约，也不修改空房通知去重记录。</p>'},{signal:abort.signal});
      if(receipt.status!=='accepted')throw new Error(`PUSHPLUS_${receipt.status.toUpperCase()}`);
      console.log(`PushPlus 已受理测试通知${receipt.serialNumber?`，流水号 ${receipt.serialNumber}`:''}。请在微信核对是否收到。`);
    } else if(command==='run'||command==='scan') {
      if(!a.runtime) {
        const legacy=path.join(path.dirname(file),'runtime','state.json');
        const old=await fs.readFile(legacy,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
        if(old&&!['MONITORING','RESOLVED_NOT_BOOKED'].includes(old.status))throw new Error('LEGACY_ATTEMPT_REQUIRES_REVIEW');
      }
      const result=await run(command==='scan'?{...config,checkout:{...config.checkout,mode:'monitor'}}:config,dir,{once:command==='scan'||a.once,signal:abort.signal});
      if(command==='scan')console.log(`结果保存在 ${path.join(dir,'availability.json')}，目标 ${result.primary.length} 个，备选 ${result.alternatives.length} 个。`);
    } else if(command==='inspect') {
      await privateDir(dir);
      const {browser,context,page}=await openBrowser({...config,browser:{...config.browser,headless:true}});
      try {
        const search=createSearch(context,config);await search.initialize(page,abort.signal);
        const offers=await search.find(config.stays[0],abort.signal);
        const c=offers.find(c=>(!a.plan||c.planCode===a.plan)&&(!a.room||c.roomCode===a.room));
        if(!c)throw new Error('NO_MATCHING_OFFER');
        if(config.hotel.engine==='tripla') {
          await atomicJson(path.join(dir,'review.json'),{candidate:publicCandidate(c),engine:'tripla',
            noRefund:c.noRefund,cancellationFreeDeadline:c.cancellationFreeDeadline,
            reservationSubmitted:false,holdConfirmed:false});
          return console.log(`酒店 ${config.hotel.name} 报价 ${c.totalJpy} JPY，不可退款 ${c.noRefund}；Tripla 支持查询和准备旅客信息页，尚未适配自动提交与支付。`);
        }
        await page.goto(reserveUrl(c,config.guests,config.hotel),{waitUntil:'domcontentloaded'});
        const review=verifyQuote(await readQuote(page),c,config);
        await atomicJson(path.join(dir,'review.json'),{candidate:publicCandidate(c),...review});
        await page.locator('input[name="lastName"]').filter({visible:true}).waitFor({state:'visible'});
        await captureMetadata(page,dir);
        console.log(`酒店 ${config.hotel.name} 表单与政策已读取。取消政策 SHA-256：${review.policySha256}`);
        console.log(`当前取消费率推算：${review.cancellationEstimate.ratePercent??'未知'}%。支付代理：${review.paymentMethods.map(m=>m.agent??m.type).join(', ')}。`);
      } finally {await browser.close();}
    } else throw new Error('UNKNOWN_COMMAND');
  } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
main().catch(e=>{
  if(e.name==='ZodError')console.error('配置错误：',e.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('\n'));
  else console.error('停止：',safeError(e));
  process.exitCode=1;
});
