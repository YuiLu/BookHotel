import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, candidate } from './helpers.js';
import { validateSecrets } from '../src/config.js';
import { AvailabilityNotifier, notifyAvailability, notificationKey, sendPushPlus, PUSHPLUS_ENDPOINT } from '../src/notifications.js';

const result = (primary = [candidate], alternatives = []) => ({at: '2026-10-04T13:36:33.680Z', hotelCode: candidate.hotelCode, primary, alternatives});
async function fixture(t, settings = {}, sendResult = {status: 'accepted', serialNumber: 'mock_serial'}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushplus-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const c = config({notifications: {pushplus: {enabled: true, ...settings}}});
  const messages = [], events = [];
  let time = Date.parse('2026-10-04T13:36:33Z');
  const options = {send: async (_settings, message) => {messages.push(message); return typeof sendResult === 'function' ? sendResult() : sendResult;},
    now: () => time, event: async (type, details) => events.push({type, ...details})};
  return {dir, c, messages, events, options, notifier: new AvailabilityNotifier(c, dir, options), advance: seconds => {time += seconds * 1000;}};
}

test('监控默认关闭推送；启用时校验本地 token，不要求旅客或支付信息', () => {
  assert.equal(config().notifications.pushplus.enabled, false);
  const c = config({notifications: {pushplus: {enabled: true, tokenEnv: 'TEST_PUSHPLUS_REQUIRED_TOKEN'}}});
  assert.throws(() => validateSecrets(c), /MISSING_ENV:TEST_PUSHPLUS_REQUIRED_TOKEN/);
  process.env.TEST_PUSHPLUS_REQUIRED_TOKEN = 'unit-test-only';
  try {assert.doesNotThrow(() => validateSecrets(c));} finally {delete process.env.TEST_PUSHPLUS_REQUIRED_TOKEN;}
});

test('100 次轮询、套餐和价格变化、进程重启均不会重复发送已受理的同一房型', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.notifier.process(result()), {status: 'accepted', combinations: 1});
  for(let i = 0; i < 100; i++) await f.notifier.process(result([{...candidate, totalJpy: 85000 + i, planCode: `PL${i}`} ]));
  await new AvailabilityNotifier(f.c, f.dir, f.options).process(result());
  assert.equal(f.messages.length, 1);
  assert.equal(f.events[0].type, 'PUSHPLUS_ACCEPTED');
  const state = await fs.readFile(path.join(f.dir, 'pushplus-state.json'), 'utf8');
  assert.ok(!state.includes('token'));
  if(process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.dir, 'pushplus-state.json'))).mode & 0o777, 0o600);
});

test('首次无房不发消息；同一房型多个套餐合并为最低报价，不同日期和房型批量提醒', async t => {
  const f = await fixture(t);
  await f.notifier.process(result([])); assert.equal(f.messages.length, 0);
  const offers = [candidate, {...candidate, planCode: 'PLCHEAP', planName: '更便宜的套餐', totalJpy: 81000},
    {...candidate, roomCode: 'RMOTHER', roomName: '另一房型'},
    {...candidate, stay: {checkIn: '2027-01-04', checkOut: '2027-01-05'}}];
  assert.deepEqual(await f.notifier.process(result(offers)), {status: 'accepted', combinations: 3});
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].content, /81,000/);
  const roomParagraph = f.messages[0].content.split('\n').find(p => p.includes('目标 2027-01-03 → 2027-01-04') && p.includes(candidate.roomName));
  assert.match(roomParagraph, /81,000/); assert.ok(!roomParagraph.includes('85,800'));
  await f.notifier.process(result(offers.reverse())); assert.equal(f.messages.length, 1);
  assert.notEqual(notificationKey(candidate, f.c), notificationKey(candidate, {...f.c, guests: {...f.c.guests, adults: 3}}));
});

test('备选通知需开启且查询新鲜，超预算不推送', async t => {
  const alt = {...candidate, stay: {checkIn: '2027-01-02', checkOut: '2027-01-03'}, offset: -1};
  const f = await fixture(t);
  await f.notifier.process(result([], [alt])); assert.equal(f.messages.length, 0);
  f.c.notifications.pushplus.includeAlternatives = true;
  await f.notifier.process(result([], [alt]), {alternativesFresh: false}); assert.equal(f.messages.length, 0);
  await f.notifier.process(result([], [{...alt, totalJpy: 100000}])); assert.equal(f.messages.length, 0);
  await f.notifier.process(result([], [alt])); assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].content, /备选 2027-01-02/);
});

test('默认卖完后再放房仍不重复；开启补房通知需连续三次成功查询无房', async t => {
  const f = await fixture(t);
  await f.notifier.process(result());
  for(let i = 0; i < 5; i++) await f.notifier.process(result([]));
  await f.notifier.process(result()); assert.equal(f.messages.length, 1);
  f.c.notifications.pushplus.notifyOnRestock = true;
  for(let i = 0; i < 2; i++) await f.notifier.process(result([]));
  await f.notifier.process(result()); assert.equal(f.messages.length, 1);
  for(let i = 0; i < 3; i++) await f.notifier.process(result([]));
  await f.notifier.process(result()); assert.equal(f.messages.length, 2);
  await f.notifier.process(result()); assert.equal(f.messages.length, 2);
});

test('备选缓存不会让已通知备选错误地重新触发', async t => {
  const f = await fixture(t, {includeAlternatives: true, notifyOnRestock: true});
  const r = result([], [{...candidate, roomCode: 'RMALT'}]);
  await f.notifier.process(r);
  for(let i = 0; i < 10; i++) await f.notifier.process(result([]), {alternativesFresh: false});
  await f.notifier.process(r); assert.equal(f.messages.length, 1);
});

test('网络响应不确定时即使重启也不自动重发；先落盘 pending，崩溃恢复也不重发', async t => {
  const f = await fixture(t, {}, () => {throw new Error('network error with secret');});
  f.options.send = async () => {
    const s = JSON.parse(await fs.readFile(path.join(f.dir, 'pushplus-state.json')));
    assert.equal(s.entries[notificationKey(candidate, f.c)].status, 'pending');
    f.messages.push({}); throw new Error('network error with secret');
  };
  f.notifier = new AvailabilityNotifier(f.c, f.dir, f.options);
  assert.equal((await f.notifier.process(result())).status, 'uncertain');
  f.advance(99999);
  await new AvailabilityNotifier(f.c, f.dir, f.options).process(result()); assert.equal(f.messages.length, 1);
  const file = path.join(f.dir, 'pushplus-state.json'), state = JSON.parse(await fs.readFile(file));
  state.entries[notificationKey(candidate, f.c)].status = 'pending'; await fs.writeFile(file, JSON.stringify(state));
  await new AvailabilityNotifier(f.c, f.dir, f.options).process(result()); assert.equal(f.messages.length, 1);
  assert.equal(JSON.parse(await fs.readFile(file)).entries[notificationKey(candidate, f.c)].status, 'uncertain');
});

test('明确拒收按 600 秒退避，最多尝试三次，成功后停止重试', async t => {
  let receipt = {status: 'rejected', code: 600};
  const f = await fixture(t, {}, () => receipt);
  await f.notifier.process(result());
  for(let i = 0; i < 50; i++) await f.notifier.process(result()); assert.equal(f.messages.length, 1);
  f.advance(599); await f.notifier.process(result()); assert.equal(f.messages.length, 1);
  f.advance(1); await f.notifier.process(result()); assert.equal(f.messages.length, 2);
  f.advance(600); await f.notifier.process(result()); assert.equal(f.messages.length, 3);
  f.advance(60000); await f.notifier.process(result()); assert.equal(f.messages.length, 3);
  const second = await fixture(t, {}, () => receipt);
  await second.notifier.process(result()); receipt = {status: 'accepted'};
  second.advance(600); await second.notifier.process(result());
  second.advance(60000); await second.notifier.process(result()); assert.equal(second.messages.length, 2);
});

test('损坏或混用酒店的通知状态不会被静默清空；推送错误不影响监控结果', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, 'pushplus-state.json'), JSON.stringify({version: 1, hotelCode: '0000001223', entries: {}}));
  const outcome = await notifyAvailability(f.notifier, result(), {}, f.options.event);
  assert.equal(outcome.status, 'error'); assert.equal(f.messages.length, 0);
  assert.equal(f.events[0].code, 'PUSHPLUS_STATE_INVALID');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir, 'pushplus-state.json'))).hotelCode, '0000001223');
  await assert.rejects(new AvailabilityNotifier(f.c, f.dir, f.options).process({...result(), hotelCode: '0000001223'}), /PUSHPLUS_STATE_INVALID/);
  const fresh = await fixture(t);
  await assert.rejects(fresh.notifier.process({...result(), hotelCode: '0000001223'}), /NOTIFICATION_HOTEL_MISMATCH/);
});

test('消息转义 HTML、附官网链接；超出显示上限的组合也一次性标记，下一轮不补发', async t => {
  const f = await fixture(t, {maxOffersInMessage: 1});
  const r = result([{...candidate, roomName: '<script>&"'}, {...candidate, roomCode: 'RM2'}]);
  await f.notifier.process(r); await f.notifier.process(r);
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].content, /&lt;script&gt;&amp;&quot;/);
  assert.match(f.messages[0].content, /另有 1 个组合/); assert.match(f.messages[0].content, /打开官网预约页/);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(f.dir, 'pushplus-state.json'))).entries).length, 2);
});

test('PushPlus 使用固定 HTTPS JSON POST；token 不出现在 URL；200 仅表示受理', async () => {
  const settings = config().notifications.pushplus;
  process.env.PUSHPLUS_TOKEN = 'unit-test-private-token';
  try {
    const receipt = await sendPushPlus(settings, {title: '测试', content: '<p>测试</p>'}, {fetchImpl: async (url, options) => {
      assert.equal(url, PUSHPLUS_ENDPOINT); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      assert.ok(!url.includes(process.env.PUSHPLUS_TOKEN)); assert.equal(JSON.parse(options.body).token, process.env.PUSHPLUS_TOKEN);
      assert.equal(JSON.parse(options.body).channel, 'wechat'); assert.equal(JSON.parse(options.body).template, 'html');
      return {ok: true, status: 200, json: async () => ({code: 200, data: 'serial_test'})};
    }});
    assert.deepEqual(receipt, {status: 'accepted', serialNumber: 'serial_test'});
  } finally {delete process.env.PUSHPLUS_TOKEN;}
});

test('明确 API 错误可退避重试；超时、重定向错误、非 JSON、5xx 均视为不确定', async () => {
  const settings = config().notifications.pushplus, message = {title: 'test', content: 'test'};
  process.env.PUSHPLUS_TOKEN = 'unit-test-private-token';
  try {
    assert.deepEqual(await sendPushPlus(settings, message, {fetchImpl: async () => ({ok: true, status: 200, json: async () => ({code: 600, msg: 'secret must not escape'})})}), {status: 'rejected', code: 600});
    for(const fetchImpl of [async () => {throw new Error('secret');}, async () => ({json: async () => {throw new Error('secret');}}),
      async () => ({ok: false, status: 500, json: async () => ({code: 500})})])
      assert.deepEqual(await sendPushPlus(settings, message, {fetchImpl}), {status: 'uncertain'});
  } finally {delete process.env.PUSHPLUS_TOKEN;}
});
