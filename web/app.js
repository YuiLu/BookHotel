const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat('ja-JP').format(n);
const dateText=iso=>new Date(iso).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const text=(id,value)=>$(id).textContent=value;
const numberFields=new Set(['adults','maxTotalJpy','extraTaxBudgetJpy','intervalSeconds','daysBefore','daysAfter']);
let presets=[],state=null,dirty=false,busy=false,activeTab='primary',view='overview',toastTimer,refreshing=false,actionPending=false;
function toast(message,error=false){clearTimeout(toastTimer);const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;toastTimer=setTimeout(()=>el.hidden=true,error?8000:5000);}
async function api(url,data) {
  const response=await fetch(url,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'content-type':'application/json','x-bookhotel-client':'1'},body:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'操作未完成，请稍后重试。');return result;
}
function readForm(){return Object.fromEntries([...$('monitor-form').elements].filter(el=>el.name).map(el=>[el.name,el.type==='checkbox'?el.checked:numberFields.has(el.name)?Number(el.value):el.value]));}
function populate(form){for(const [key,value]of Object.entries(form)){const el=$(key);if(!el)continue;if(el.type==='checkbox')el.checked=value;else el.value=value;}dirty=false;formHints();}
function formHints(){
  const p=presets.find(p=>p.id===$('hotelId').value);if(!p)return;
  text('hotel-region',p.region);text('hotel-engine',p.engine);text('room-hint',`预设：${p.roomHint}。可更改或留空。`);
  const nights=(Date.parse($('checkOut').value)-Date.parse($('checkIn').value))/86400000;
  text('nights',nights>0?`${nights} 晚`:'');
  $('range-options').classList.toggle('disabled',!$('alternativesEnabled').checked);
  for(const id of ['daysBefore','daysAfter','allRoomTypes'])$(id).disabled=busy||!$('alternativesEnabled').checked;
  text('saved-state',dirty?'有未保存更改':'已保存');$('saved-state').classList.toggle('unsaved',dirty);
  $('save-button').disabled=busy||actionPending;
}
function setView(next){
  view=next;document.body.className=`view-${view}`;
  $('overview-view').hidden=view!=='overview';$('notifications-view').hidden=view!=='notifications';
  const copy={overview:['监控总览','下一程，从心仪的房间开始。','设好期待的旅程，剩下的等待交给宿见。'],settings:['监控设置','把期待，设成下一次出发。','选择酒店、日期与房型，为你的旅程留多一点可能。'],notifications:['通知中心','好消息，不必一直等在屏幕前。','连接微信通知，让心仪房间的空房消息主动找到你。']}[view];
  text('page-name',copy[0]);text('page-title',copy[1]);text('page-description',copy[2]);
  document.querySelectorAll('[data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  window.scrollTo(0,0);
}
const empty=(title,description)=>{const div=document.createElement('div');div.className='empty-state';const icon=document.createElement('div');icon.className='empty-icon';icon.textContent='⌂';const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=description;div.append(icon,h,p);return div;};
function renderOffers(s){
  const snapshot=s.snapshot,container=$('offers');container.replaceChildren();
  const offers=snapshot?.[activeTab]??[];
  text('primary-count',snapshot?.primary?.length??0);text('alternative-count',snapshot?.alternatives?.length??0);
  const at=activeTab==='alternatives'?snapshot?.alternativesCheckedAt??snapshot?.at:snapshot?.at;
  text('results-time',at?`${dateText(at)} 查询`:'尚未查询');
  const note=$('result-note');note.hidden=!snapshot;
  if(snapshot){
    const old=Date.now()-Date.parse(at)>15*60000;
    const matches=snapshot.dates?.some(d=>d.offset===0&&d.stay.checkIn===s.form.checkIn&&d.stay.checkOut===s.form.checkOut);
    note.textContent=!matches?'这是该酒店之前查询的记录，与当前目标日期不同，请重新查询。':old?'历史查询记录：请重新查询以确认当前空房。':'查询快照，不表示库存已锁定。人数或筛选变化后，请重新查询。';
  }
  const strip=$('date-strip');strip.replaceChildren();
  for(const d of (snapshot?.dates??[]).slice(0,61)){
    const cell=document.createElement('div');cell.className=`date-cell${d.offset===0?' primary':''}`;
    const weekday=document.createElement('small');weekday.textContent=new Date(`${d.stay.checkIn}T12:00:00`).toLocaleDateString('zh-CN',{weekday:'short'});
    const label=document.createElement('strong');label.textContent=d.stay.checkIn.slice(5).replace('-','/');
    const count=document.createElement('span');count.textContent=d.bookableOffers?`${d.bookableOffers} 个报价`:'暂无报价';
    cell.append(weekday,label,count);strip.append(cell);
  }
  if(!offers.length){container.append(empty(snapshot?'暂未发现符合条件的方案':'好旅程，值得等待',snapshot?(activeTab==='alternatives'?'可开启相邻日期探索，或调整预算与房型筛选。':'可能尚未开放、售罄或不符合当前筛选。监控会在成功查询后更新。'):'设好酒店与日期，点击「单次查询」，看看现在有哪些可订的房间。'));return;}
  for(const c of offers.slice(0,100)){
    const over=c.totalJpy+s.form.extraTaxBudgetJpy>s.form.maxTotalJpy;
    const card=document.createElement('article');card.className=`offer${over?' over-budget':''}`;
    const meta=document.createElement('div');meta.className='offer-meta';
    const date=document.createElement('span');date.textContent=`${c.stay.checkIn} → ${c.stay.checkOut}`;meta.append(date);
    if(c.inventory){const badge=document.createElement('span');badge.className='offer-tag';badge.textContent=`库存 ${c.inventory} 间`;meta.append(badge);}
    if(c.noRefund){const badge=document.createElement('span');badge.className='offer-tag refund';badge.textContent='不可退款';meta.append(badge);}
    if(over){const badge=document.createElement('span');badge.className='offer-tag refund';badge.textContent='超出预算';meta.append(badge);}
    const name=document.createElement('h3');name.textContent=c.roomName;
    const plan=document.createElement('p');plan.className='offer-plan';plan.textContent=c.planName;
    const bottom=document.createElement('div');bottom.className='offer-bottom';
    const priceBox=document.createElement('div');const price=document.createElement('div');price.className='price';const currency=document.createElement('small');currency.textContent='¥';price.append(currency,document.createTextNode(money(c.totalJpy)));
    const priceNote=document.createElement('p');priceNote.className='price-note';priceNote.textContent='JPY · 全部住宿晚数合计，另预留税费';priceBox.append(price,priceNote);
    const link=document.createElement('a');link.className='offer-link';link.textContent='官网查看 ↗';link.target='_blank';link.rel='noreferrer noopener';
    try{const url=new URL(c.bookingUrl);if(url.protocol==='https:')link.href=url.href;}catch{}
    bottom.append(priceBox,link);card.append(meta,name,plan,bottom);container.append(card);
  }
  if(offers.length>100){const p=document.createElement('p');p.className='field-hint';p.textContent=`共 ${offers.length} 个方案，页面显示前 100 个。可缩小日期范围或房型筛选。`;container.append(p);}
}
const eventCopy={AVAILABILITY_CHANGED:'空房查询已更新',PUSHPLUS_ACCEPTED:'空房提醒已受理',PUSHPLUS_REJECTED:'推送未被受理',PUSHPLUS_UNCERTAIN:'推送结果待确认，已暂停重发',POLL_ERROR:'查询遇到错误，稍后自动重试',PUSHPLUS_ERROR:'通知通道异常'};
function render(s){
  state=s;busy=['running','stopping'].includes(s.job?.status);
  const p=presets.find(p=>p.id===s.form.hotelId),job=s.job;
  text('current-hotel',p?.name??'酒店监控');
  text('current-summary',`${s.form.checkIn} → ${s.form.checkOut} · ${s.form.adults} 位成人 · 1 间房 · ¥${money(s.form.maxTotalJpy)} 预算`);
  const labels={running:job?.once?'查询中':'监控中',stopping:'停止中',completed:'本次已完成',stopped:'已停止',error:'需要处理'};
  text('job-badge',labels[job?.status]??'待启动');$('job-badge').className=`status-badge ${busy?'running':job?.status==='error'?'error':''}`;
  text('task-stat',labels[job?.status]??'尚未开始');
  text('task-caption',busy?`查询间隔 ${s.form.intervalSeconds} 秒 + 随机延迟`:job?.finishedAt?`${dateText(job.finishedAt)} 结束`:'保存设置后，即可开始监控');
  const stat=(id,n,unit)=>{const el=$(id);el.replaceChildren(document.createTextNode(n===undefined?'—':String(n)));const small=document.createElement('small');small.textContent=unit;el.append(small);};
  stat('primary-stat',s.snapshot?.primary?.length,'个');stat('alternative-stat',s.snapshot?.alternatives?.length,'个');stat('push-stat',s.push.accepted,'组');
  text('snapshot-caption',s.snapshot?.at?`${dateText(s.snapshot.at)} 的查询记录`:'等待首次查询');
  text('alternative-caption',s.form.alternativesEnabled?`入住前 ${s.form.daysBefore} 天 / 后 ${s.form.daysAfter} 天`:'相邻日期探索未开启');
  $('job-error').hidden=!job?.error;if(job?.error)text('job-error',job.error);
  $('start-button').hidden=busy;$('scan-button').hidden=busy;$('stop-button').hidden=!busy;$('stop-button').disabled=job?.status==='stopping';
  $('start-button').disabled=busy||actionPending;$('scan-button').disabled=busy||actionPending;
  for(const el of $('monitor-form').elements)el.disabled=busy;
  $('token-save').disabled=busy||actionPending;$('push-token').disabled=busy;
  text('token-status',s.tokenConfigured?'已配置 · 不回显':'未配置');
  $('notify-test-button').disabled=!s.tokenConfigured||actionPending;
  text('notice-count',s.push.accepted);
  $('push-summary').replaceChildren(document.createTextNode(`当前酒店：已受理 ${s.push.accepted} 组空房提醒；待确认 ${s.push.uncertain+s.push.pending} 组；失败 ${s.push.rejected} 组。`));
  renderOffers(s);
  const events=$('events');events.replaceChildren();
  if(!s.events.length){const p=document.createElement('p');p.className='muted';p.textContent='暂无查询动态，开始一次查询后会显示在这里。';events.append(p);}
  for(const e of s.events){
    const row=document.createElement('div');row.className='event';
    const dot=document.createElement('span');dot.className=`event-dot${/ERROR|REJECTED|UNCERTAIN/.test(e.type)?' error':''}`;
    const content=document.createElement('div');content.className='event-body';const title=document.createElement('strong');title.textContent=eventCopy[e.type]??'任务状态已更新';content.append(title);
    const desc=document.createElement('p');desc.textContent=e.type==='AVAILABILITY_CHANGED'?`目标 ${e.primary??0} 个 · 备选 ${e.alternatives??0} 个`:e.combinations?`${e.combinations} 组日期 / 房型组合`:e.code??'';content.append(desc);
    const time=document.createElement('time');time.textContent=dateText(e.at);row.append(dot,content,time);events.append(row);
  }
  formHints();
}
async function refresh(){if(refreshing)return;refreshing=true;try{const s=await api('/api/state');render(s);text('connection','本地服务已连接');$('connection').classList.remove('offline');}catch{busy=true;text('connection','连接中断，请检查本地服务');$('connection').classList.add('offline');$('start-button').disabled=true;$('scan-button').disabled=true;}finally{refreshing=false;}}
async function save(){
  if(!$('monitor-form').reportValidity())return false;
  if($('checkOut').value<=$('checkIn').value){toast('退房日期必须晚于入住日期。',true);return false;}
  const result=await api('/api/config',readForm());dirty=false;render(result);return true;
}
async function action(fn){if(actionPending)return;actionPending=true;$('start-button').disabled=true;$('scan-button').disabled=true;$('notify-test-button').disabled=true;$('save-button').disabled=true;try{await fn();}catch(e){toast(e.message,true);}finally{actionPending=false;$('start-button').disabled=busy;$('scan-button').disabled=busy;await refresh();}}
$('monitor-form').addEventListener('input',()=>{dirty=true;formHints();});
$('monitor-form').addEventListener('change',formHints);
$('hotelId').addEventListener('change',()=>{const defaults=presets.find(p=>p.id===$('hotelId').value).defaults;populate(defaults);dirty=true;formHints();});
$('checkIn').addEventListener('change',()=>{if($('checkOut').value<=$('checkIn').value){const d=new Date(`${$('checkIn').value}T12:00:00Z`);if(Number.isFinite(+d)){$('checkOut').value=new Date(+d+86400000).toISOString().slice(0,10);}}formHints();});
$('monitor-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{if(await save())toast('监控设置已保存。');});});
for(const [id,once]of [['start-button',false],['scan-button',true]])$(id).addEventListener('click',()=>action(async()=>{if(dirty&&!await save())return;await api('/api/start',{once});toast(once?'正在查询官网，请稍候。':'监控已开始，页面关闭后会继续运行，直到停止本地服务。');}));
$('stop-button').addEventListener('click',()=>action(async()=>{await api('/api/stop',{});toast('正在停止任务并关闭查询浏览器。');}));
$('refresh-button').addEventListener('click',()=>action(async()=>{await refresh();toast('已刷新本地查询记录。');}));
$('token-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{await api('/api/token',{token:$('push-token').value.trim()});$('push-token').value='';toast('token 已安全保存到本机。');});});
$('notify-test-button').addEventListener('click',()=>action(async()=>{await api('/api/notify-test',{});toast('PushPlus 已受理测试通知，请在微信查看。');}));
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>setView(el.dataset.view)));
document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>{activeTab=el.dataset.tab;document.querySelectorAll('[data-tab]').forEach(tab=>{tab.classList.toggle('active',tab===el);tab.setAttribute('aria-selected',String(tab===el));});if(state)renderOffers(state);}));
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
async function init(){
  presets=await api('/api/presets');
  for(const p of presets){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;$('hotelId').append(option);}
  const s=await api('/api/state');populate(s.form);render(s);setView('overview');
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());$('checkIn').min=today;$('checkOut').min=today;
  text('connection','本地服务已连接');setInterval(refresh,2500);
}
init().catch(e=>{toast(`控制台连接失败：${e.message}`,true);text('connection','本地服务未连接');$('connection').classList.add('offline');});
