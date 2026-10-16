import fs from 'node:fs/promises';
import path from 'node:path';
import { secret } from './config.js';
import { guestCounts, reserveUrl, sha256 } from './domain.js';
import { atomicJson } from './state.js';

export const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send';
const statuses = new Set(['pending', 'accepted', 'uncertain', 'rejected']);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

// PushPlus acknowledges queueing, not delivery. No server idempotency key is documented.
export async function sendPushPlus(settings, message, {signal, fetchImpl = fetch} = {}) {
  const token = secret(settings.tokenEnv);
  try {
    const timeout = AbortSignal.timeout(settings.timeoutSeconds * 1000);
    const response = await fetchImpl(PUSHPLUS_ENDPOINT, {
      method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token, title: message.title, content: message.content, template: 'html', channel: 'wechat'}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const data = await response.json();
    if(response.ok && data?.code === 200) {
      const serialNumber = typeof data.data === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(data.data) ? data.data : undefined;
      return {status: 'accepted', ...(serialNumber ? {serialNumber} : {})};
    }
    if(response.status < 500 && Number.isInteger(data?.code) && data.code !== 200)
      return {status: 'rejected', code: data.code};
  } catch {
    // A timeout can follow a successful server enqueue. Never automatically replay it.
  }
  return {status: 'uncertain'};
}

export function notificationKey(candidate, config) {
  return sha256(JSON.stringify([config.hotel.code, candidate.stay.checkIn, candidate.stay.checkOut,
    candidate.roomCode, guestCounts(config.guests)]));
}

export function notificationOffers(result, config, alternativesFresh) {
  if(result.hotelCode !== config.hotel.code) throw new Error('NOTIFICATION_HOTEL_MISMATCH');
  const grouped = new Map();
  const add = (offer, scope) => {
    if(offer.hotelCode !== config.hotel.code) throw new Error('NOTIFICATION_HOTEL_MISMATCH');
    if(offer.totalJpy + config.filters.extraTaxBudgetJpy > config.filters.maxTotalJpy) return;
    const key = notificationKey(offer, config), previous = grouped.get(key);
    if(!previous || offer.totalJpy < previous.offer.totalJpy) grouped.set(key, {key, offer, scope: previous?.scope === 'primary' ? 'primary' : scope});
  };
  result.primary.forEach(offer => add(offer, 'primary'));
  if(config.notifications.pushplus.includeAlternatives && alternativesFresh)
    result.alternatives.forEach(offer => add(offer, 'alternative'));
  return [...grouped.values()];
}

export function availabilityMessage(items, result, config) {
  const shown = items.slice(0, config.notifications.pushplus.maxOffersInMessage);
  const content = [
    `<p>${escapeHtml(config.hotel.name)}：发现 ${items.length} 个新的日期／房型组合。</p>`,
    `<p>查询时间：${escapeHtml(new Date(result.at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}))}（北京时间）</p>`,
    `<p>人数：成人 ${config.guests.adults}；儿童／幼儿 ${guestCounts(config.guests).slice(1).reduce((a, b) => a + b, 0)}；1 间房。</p>`,
    ...shown.map(({offer: c, scope}) => `<p>${scope === 'primary' ? '目标' : '备选'} ${escapeHtml(c.stay.checkIn)} → ${escapeHtml(c.stay.checkOut)}<br>${escapeHtml(c.roomName)}<br>${escapeHtml(c.planName)}<br>合计 ${c.totalJpy.toLocaleString('en-US')} JPY（另预留税费 ${config.filters.extraTaxBudgetJpy} JPY）${c.noRefund?'<br>此方案不可退款':''}<br><a href="${escapeHtml(reserveUrl(c, config.guests, config.hotel))}">打开官网预约页</a></p>`),
    ...(shown.length < items.length ? [`<p>另有 ${items.length - shown.length} 个组合，详见本地 availability.md。</p>`] : []),
    '<p>这是查询时的报价，库存可能变化；通知不会创建预约或锁定房间。</p>',
  ].join('\n');
  return {title: `${config.hotel.name} 空房提醒（${items.length} 个）`, content};
}

export class AvailabilityNotifier {
  constructor(config, dir, {send = sendPushPlus, now = Date.now, event = async () => {}} = {}) {
    this.config = config; this.settings = config.notifications.pushplus;
    this.file = path.join(dir, 'pushplus-state.json');
    this.send = send; this.now = now; this.event = event;
  }
  async load() {
    if(this.state) return;
    try {this.state = JSON.parse(await fs.readFile(this.file, 'utf8'));}
    catch(e) {
      if(e.code !== 'ENOENT') throw new Error('PUSHPLUS_STATE_INVALID');
      this.state = {version: 1, hotelCode: this.config.hotel.code, entries: {}};
    }
    const s = this.state;
    if(s.version !== 1 || s.hotelCode !== this.config.hotel.code || !s.entries || Array.isArray(s.entries) || typeof s.entries !== 'object' ||
      Object.entries(s.entries).some(([key, r]) => !/^[a-f0-9]{64}$/.test(key) || !r || !statuses.has(r.status) ||
        !Number.isInteger(r.attempts) || r.attempts < 1 || !Number.isInteger(r.missingScans) || r.missingScans < 0 ||
        !['primary', 'alternative'].includes(r.scope) || !Number.isFinite(Date.parse(r.attemptedAt)))) {
      this.state = undefined;
      throw new Error('PUSHPLUS_STATE_INVALID');
    }
    // The prior process may have died after the remote server accepted its request.
    let changed = false;
    for(const r of Object.values(s.entries)) if(r.status === 'pending') {r.status = 'uncertain'; changed = true;}
    if(changed) await atomicJson(this.file, s);
  }
  async process(result, {alternativesFresh = true, signal} = {}) {
    if(!this.settings.enabled) return {status: 'disabled'};
    signal?.throwIfAborted();
    await this.load();
    const items = notificationOffers(result, this.config, alternativesFresh), seen = new Map(items.map(i => [i.key, i]));
    const entries = this.state.entries, eligible = [], at = new Date(this.now()).toISOString();
    let changed = false;
    for(const [key, r] of Object.entries(entries)) {
      if(seen.has(key)) continue;
      // Cached alternative results and failed queries do not count as absence.
      if(r.scope === 'alternative' && (!alternativesFresh || !this.settings.includeAlternatives)) continue;
      const count = Math.min(this.settings.rearmAfterMissingScans, r.missingScans + 1);
      if(count !== r.missingScans) {r.missingScans = count; changed = true;}
    }
    for(const item of items) {
      const r = entries[item.key];
      const restocked = r?.status === 'accepted' && this.settings.notifyOnRestock && r.missingScans >= this.settings.rearmAfterMissingScans;
      const retry = r?.status === 'rejected' && r.attempts < this.settings.maxAttempts &&
        this.now() - Date.parse(r.attemptedAt) >= this.settings.retrySeconds * 1000;
      if(!r || restocked || retry) eligible.push({...item, attempts: restocked ? 1 : (r?.attempts ?? 0) + 1});
      if(r && (r.missingScans !== 0 || r.scope !== item.scope)) {r.missingScans = 0; r.scope = item.scope; changed = true;}
    }
    if(!eligible.length) {
      if(changed) await atomicJson(this.file, this.state);
      return {status: 'unchanged'};
    }
    // Persist before sending; a restart must never blindly repeat an in-flight push.
    for(const item of eligible) entries[item.key] = {
      status: 'pending', scope: item.scope, attempts: item.attempts, attemptedAt: at, missingScans: 0,
      stay: item.offer.stay, roomCode: item.offer.roomCode,
    };
    await atomicJson(this.file, this.state);
    let receipt;
    try {receipt = await this.send(this.settings, availabilityMessage(eligible, result, this.config), {signal});}
    catch {receipt = {status: 'uncertain'};}
    if(!['accepted', 'rejected', 'uncertain'].includes(receipt?.status)) receipt = {status: 'uncertain'};
    for(const item of eligible) {
      const r = entries[item.key];
      r.status = receipt.status;
      if(receipt.status === 'accepted') {
        r.acceptedAt = new Date(this.now()).toISOString();
        if(receipt.serialNumber) r.serialNumber = receipt.serialNumber;
      }
    }
    await atomicJson(this.file, this.state);
    await this.event(`PUSHPLUS_${receipt.status.toUpperCase()}`, {
      combinations: eligible.length, ...(receipt.code !== undefined ? {code: receipt.code} : {}),
      ...(receipt.serialNumber ? {serialNumber: receipt.serialNumber} : {}),
    });
    return {status: receipt.status, combinations: eligible.length};
  }
}

// A notification failure must not turn a successful hotel query into a poll failure.
export async function notifyAvailability(notifier, result, options, event) {
  try {return await notifier.process(result, options);}
  catch(e) {
    if(options.signal?.aborted) return {status: 'aborted'};
    const code = ['PUSHPLUS_STATE_INVALID', 'NOTIFICATION_HOTEL_MISMATCH'].includes(e.message) ? e.message : 'PUSHPLUS_LOCAL_ERROR';
    await event('PUSHPLUS_ERROR', {code});
    return {status: 'error'};
  }
}
