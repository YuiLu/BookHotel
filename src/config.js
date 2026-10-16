import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_HOTEL, DEFAULT_HOTEL_CODE, LODGER_TYPES } from './profiles.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === s;
}, '日期无效');
const strings = z.array(z.string().min(1)).default([]);
const nonnegative = z.number().int().min(0);
const officialHttps = value => {try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const field = z.object({
  selector: z.string().min(1), frameUrlPrefix: z.string().url().optional(),
  action: z.enum(['fill', 'select', 'check']).default('fill'),
  value: z.string().optional(), env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).strict().refine(f => f.action === 'check' || Boolean(f.env) !== (f.value !== undefined), '填写字段须且仅须提供 value 或 env');
const question=z.object({code:z.number().int().positive(),title:z.string().min(1),formType:z.enum(['TEXT','SELECT_ONE']),
  value:z.string().optional(),env:z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  checkoutKey:z.literal('transport').optional()}).strict().refine(q=>[q.value!==undefined,Boolean(q.env),Boolean(q.checkoutKey)].filter(Boolean).length===1,'问题答案须提供 value、env、checkoutKey 之一');
const hotel=z.object({engine:z.enum(['d-reserve','tripla']).default('d-reserve'),code:z.string().regex(/^\d{1,10}$/),name:z.string().min(1),
  bookingUrl:z.string().url().optional(),
  lodgerTypeCodes:z.array(z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(6)])).min(1).default([0]),
  questions:z.array(question).default([])}).strict().refine(h=>h.lodgerTypeCodes.includes(0)&&new Set(h.lodgerTypeCodes).size===h.lodgerTypeCodes.length,'人数类别必须包含成人且不能重复')
  .refine(h=>h.engine!=='d-reserve'||/^\d{10}$/.test(h.code),'D-Reserve 酒店编号须为 10 位数字')
  .refine(h=>h.engine!=='tripla'||officialHttps(h.bookingUrl),'Tripla 需要官方 HTTPS bookingUrl');
export const schema = z.object({
  version: z.literal(1),
  hotel:hotel.prefault(DEFAULT_HOTEL),
  stays: z.array(z.object({checkIn: date, checkOut: date}).strict()
    .refine(s => s.checkOut > s.checkIn, '退房必须晚于入住')).min(1).max(20),
  alternatives: z.object({enabled:z.boolean().default(false), daysBefore:nonnegative.max(30).default(3),
    daysAfter:nonnegative.max(30).default(3), allRoomTypes:z.boolean().default(true),
    roomCodes:strings,roomKeywords:strings,includeOverBudget:z.boolean().default(true),allowBooking:z.boolean().default(false),
    intervalSeconds:z.number().min(60).default(600)}).strict().prefault({}),
  guests: z.object({adults: z.number().int().min(1).max(6), childA: nonnegative.max(3).default(0),
    childB: nonnegative.max(3).default(0), childC: nonnegative.max(1).default(0),
    childD: nonnegative.max(1).default(0), infant: nonnegative.max(1).default(0)}).strict(),
  filters: z.object({roomCodes: strings, planCodes: strings, roomKeywords: strings,
    planKeywords: strings, excludedKeywords: strings, maxTotalJpy: z.number().int().positive(),
    extraTaxBudgetJpy: nonnegative.default(0)}).strict(),
  poll: z.object({intervalSeconds: z.number().min(30).default(120), jitterSeconds: nonnegative.default(20),
    maxBackoffSeconds: z.number().min(60).default(1800), requestTimeoutSeconds: z.number().min(5).max(120).default(30),
    maxConsecutiveErrors: z.number().int().min(1).default(12), maxPages: z.number().int().min(1).max(50).default(10),
    maxCycles: nonnegative.default(0)}).strict().prefault({}),
  browser: z.object({headless: z.boolean().default(false), channel: z.enum(['chromium','chrome','msedge']).default('chromium'),
    executablePath: z.string().optional()}).strict().prefault({}),
  notifications: z.object({pushplus: z.object({
    enabled: z.boolean().default(false), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('PUSHPLUS_TOKEN'),
    includeAlternatives: z.boolean().default(false), notifyOnRestock: z.boolean().default(false),
    rearmAfterMissingScans: z.number().int().min(2).max(100).default(3),
    timeoutSeconds: z.number().min(2).max(30).default(10),
    retrySeconds: z.number().min(60).max(86400).default(600),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    maxOffersInMessage: z.number().int().min(1).max(20).default(10),
  }).strict().prefault({})}).strict().prefault({}),
  checkout: z.object({mode: z.enum(['monitor','prepare','payment','auto']).default('prepare'),
    allowFinalSubmit: z.boolean().default(false), acceptedCancellationPolicySha256: z.string().default(''),
    acceptTermsAndPrivacy: z.boolean().default(false),
    requireFreeCancellation:z.boolean().default(false),freeCancellationBufferDays:nonnegative.default(2),
    fields: z.array(field).default([]), paymentFields: z.array(field).default([]),
    paymentFrameOrigins: z.array(z.string().url()).default([]),
    paymentSteps: z.array(z.object({urlPrefix:z.string().url(), readySelector:z.string().min(1),
      fields:z.array(field).default([]), totalSelector:z.string().min(1),
      buttonSelector:z.string().min(1), buttonText:z.string().min(1),
      currencyText:z.string().default('円')}).strict()).max(8).default([]),
    handoffMinutes: z.number().min(1).max(180).default(30),
    arrivalTime: z.string().regex(/^\d{2}:\d{2}$/).default('15:00'),
    overseas: z.boolean().default(true), countryCallingCode: z.string().regex(/^\d{1,3}$/).default('86'),
    gender:z.enum(['MALE','FEMALE','OTHER']).optional(),
    genderCounts:z.partialRecord(z.enum(['adults','childA','childB','childC','childD','infant']),
      z.object({male:nonnegative,female:nonnegative,other:nonnegative}).strict()).optional(),
    transport:z.enum(['公共交通機関','自家用車']).optional(),
    guestEnv: z.object({lastName: z.string().default('GUEST_LAST_NAME'), firstName:z.string().default('GUEST_FIRST_NAME'),
      lastNameKana:z.string().default('GUEST_LAST_NAME_KANA'),firstNameKana:z.string().default('GUEST_FIRST_NAME_KANA'),
      email: z.string().default('GUEST_EMAIL'), phone: z.string().default('GUEST_PHONE')}).strict().prefault({}),
    cardEnv: z.object({number: z.string().default('CARD_NUMBER'), holder: z.string().default('CARD_HOLDER'),
      month: z.string().default('CARD_EXP_MONTH'), year: z.string().default('CARD_EXP_YEAR'),
      cvc: z.string().default('CARD_CVC')}).strict().prefault({}),
  }).strict().prefault({}),
}).strict().superRefine((c, ctx) => {
  if(c.hotel.engine==='tripla') {
    if(Object.entries(c.guests).some(([k,v])=>k!=='adults'&&v>0))
      ctx.addIssue({code:'custom',path:['guests'],message:'Tripla 当前只支持成人；儿童分级尚未适配'});
    if(['payment','auto'].includes(c.checkout.mode))
      ctx.addIssue({code:'custom',path:['checkout','mode'],message:'Tripla 当前支持 monitor 和 prepare；尚未适配自动提交与支付'});
  }
  for(const t of LODGER_TYPES)if(c.guests[t.key]>0&&!c.hotel.lodgerTypeCodes.includes(t.code))
    ctx.addIssue({code:'custom',path:['hotel','lodgerTypeCodes'],message:`酒店人数类别不支持 ${t.key}`});
  if(new Set(c.hotel.questions.map(q=>q.code)).size!==c.hotel.questions.length)
    ctx.addIssue({code:'custom',path:['hotel','questions'],message:'问题编号不能重复'});
  if(['payment','auto'].includes(c.checkout.mode) && (!c.checkout.allowFinalSubmit || !c.checkout.acceptTermsAndPrivacy || !/^[a-f0-9]{64}$/.test(c.checkout.acceptedCancellationPolicySha256)))
    ctx.addIssue({code:'custom',path:['checkout'],message:'payment/auto 需要 allowFinalSubmit、acceptTermsAndPrivacy=true 及已审阅的取消政策 SHA-256'});
  if(c.checkout.mode !== 'monitor' && c.hotel.engine==='d-reserve') {
    const g=c.checkout.genderCounts;
    if(!g || !c.checkout.gender || (c.hotel.questions.some(q=>q.checkoutKey==='transport')&&!c.checkout.transport))
      ctx.addIssue({code:'custom',path:['checkout'],message:'预约需要 gender、genderCounts 及配置引用的问题答案'});
    else for(const [key,count] of Object.entries(c.guests)) {
      const v=g[key];
      if(count !== (v ? v.male+v.female+v.other : 0))
        ctx.addIssue({code:'custom',path:['checkout','genderCounts',key],message:'各年龄类别性别人数须与入住人数一致'});
    }
  }
  if(c.checkout.mode !== 'monitor' && c.browser.headless)
    ctx.addIssue({code:'custom',path:['browser','headless'],message:'预约模式需要可见浏览器以接管支付验证'});
  if(c.poll.maxBackoffSeconds < c.poll.intervalSeconds)
    ctx.addIssue({code:'custom',path:['poll'],message:'maxBackoffSeconds 必须不小于 intervalSeconds'});
});

export async function loadConfig(file) {
  const full = path.resolve(file);
  dotenv.config({path: path.join(path.dirname(full), '.env'), quiet:true});
  const c = schema.parse(JSON.parse(await fs.readFile(full, 'utf8')));
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date());
  if(c.stays.some(s => s.checkIn < today)) throw new Error('CONFIG_PAST_DATE');
  return c;
}
export async function runtimeDirectory(file,override) {
  if(override)return path.resolve(override);
  const raw=JSON.parse(await fs.readFile(file,'utf8'));
  const code=raw.hotel?.code??DEFAULT_HOTEL_CODE;
  const engine=raw.hotel?.engine??'d-reserve';
  if(!['d-reserve','tripla'].includes(engine)||!(engine==='tripla'?/^\d{1,10}$/:/^\d{10}$/).test(code))throw new Error('CONFIG_HOTEL_CODE');
  return path.join(path.dirname(path.resolve(file)),'runtime',...(engine==='tripla'?['tripla']:[]),code);
}
export function secret(name) {
  const value = process.env[name];
  if(!value || /^(CHANGE_ME|YOUR_|REPLACE_)/.test(value)) throw new Error(`MISSING_ENV:${name}`);
  return value;
}
export function validateSecrets(c) {
  if(c.notifications.pushplus.enabled) secret(c.notifications.pushplus.tokenEnv);
  if(c.checkout.mode === 'monitor') return;
  if(c.hotel.engine==='tripla') {
    for(const key of ['lastName','firstName','email','phone'])secret(c.checkout.guestEnv[key]);
    for(const f of c.checkout.fields)if(f.env)secret(f.env);
    return;
  }
  Object.values(c.checkout.guestEnv).forEach(secret);
  for(const q of c.hotel.questions)if(q.env)secret(q.env);
  for(const f of [...c.checkout.fields, ...c.checkout.paymentFields,...c.checkout.paymentSteps.flatMap(s=>s.fields)]) if(f.env) secret(f.env);
  // Card data is only required when its fields actually appear on the checkout page.
}
