# 湖山亭うぶや（产屋）：Tripla 适配

产屋的 [官方房型页](https://www.ubuya.co.jp/en/room/) 使用 Tripla 预约组件，接口为 `concierge.tripla.ai/book/hotels/4398/rooms`。因此在同一项目中增加 Tripla 查询与表单准备适配，复用轮询、退避、日期备选、报告、进程锁和 PushPlus 持久去重。

## 11 月 29 日实站验证已通过

`config.ubuya.nov29.example.json` 配置 **2026-11-29～11-30、2 位成人、98㎡特别房编号 20**，已开启 PushPlus，真实 token 只保存在本地 `.env`。

2026-10-05 00:01 和 00:04（北京时间）两次实查均检测到 **118,800 JPY、库存 1、不可退款** 的含早晚餐方案。脚本成功进入旅客信息页，使用虚构资料填好 5 个联系字段，未点击“下一步”，预约／支付写请求被拦截。

PushPlus 已受理一条测试消息和一条目标空房消息。重新加载实际的受理记录后，100 次通知判断没有再次调用发送；再次运行官网查询也没有重复发送。按照 [PushPlus 官方说明](https://www.pushplus.plus/doc/guide/api.html)，受理是异步发送的确认，实际微信接收仍需在接收端核对。

```sh
npm start -- --config config.ubuya.nov29.example.json
```

记录见 [查询结果](examples/ubuya-nov29-scan.md)、[实站表单验证](examples/ubuya-nov29-live-validation.json) 和 [真实推送去重验证](examples/ubuya-nov29-pushplus-validation.json)。保持 `runtime/tripla/4398/` 的现有记录，继续运行不会再次推送这个已提醒的日期／房型组合。

## 已配置目标

`config.ubuya.example.json`：2026-11-09 入住、11-10 退房，2 位成人、1 间房，房型编号 `20`，对应“附露天浴池的特别房(98㎡)【富士山景观/禁烟】”。预算 150,000 JPY、现场税费预留 300 JPY 均为示例，可自行调整。房型用编号匹配，方案默认不限，不依赖中文房型名称是否变化。

首次实站监控查询返回 1 个报价，基础价 108,000 JPY + 消费税 10,800 JPY = **118,800 JPY**，含早餐和晚餐，库存显示 1，**不可退款**。随后复查曾返回有效空结果，说明通知和报告必须使用当轮结果；初次检测成功不表示现在仍有房。查询样本与时间见 `examples/ubuya-monitor-initial-scan.json` 和 `examples/ubuya-monitor-scan.json`。

解析使用日元原始价格，验证日期、成人数、每日房价与税费。不使用 `min_price` 的起价或美元 `mcp_total_price` 作为合计。匹配要求可预约、有库存、无需登录，错误响应不会转换为“无房”。

## 运行

```sh
npm run check -- --config config.ubuya.example.json
npm run scan -- --config config.ubuya.example.json
npm start -- --config config.ubuya.example.json
npm run inspect -- --config config.ubuya.example.json
```

运行记录在 `runtime/tripla/4398/`。开始持续运行前，可把 `notifications.pushplus.enabled` 设为 `true`，在**本地 `.env`** 填写 `PUSHPLUS_TOKEN`；`.env.example` 仅为模板，不会被脚本加载。开启推送不需要旅客资料或支付信息。

`alternatives.enabled: true` 会启用默认前后三天、不同房型备选；`notifications.pushplus.includeAlternatives: true` 才会推送其预算内的新鲜报价。通知去重方式与湖月相同，保存记录后重启不会重复推送同一日期／房型／人数。可以用同一项目分别启动湖月和产屋配置，它们的 runtime 和去重记录分开。

## 预约准备的范围

`checkout.mode: "prepare"`、`browser.headless: false` 时，发现空房后重新检查具体房型和套餐的报价；确认只有一个对应预约按钮才进入 `/reservation/guest-detail`。自动填写 `GUEST_LAST_NAME`、`GUEST_FIRST_NAME`、`GUEST_EMAIL` 及确认邮箱、`GUEST_PHONE`，停在“下一步”之前。额外字段可用 `checkout.fields`，选择器作用于 Tripla 旅客页的 iframe，填值仍支持引用本地环境变量。

地址、旅客性别人数、酒店必填问题和条款须逐项检查。产屋当前还要求确认最晚入住／晚餐时间等信息。这些字段未作通用自动同意处理。Tripla 暂不支持 `payment` 或 `auto`，也不自动填写信用卡、创建预约或点击最终付款按钮。准备页可能由你手工继续，因此关闭后保留 `UNVERIFIED` 保护状态，重新运行前须按 README 核对预约并 resolve。

公开页面探针曾进入指定房型的旅客信息页，拦截预约／支付写请求，没有点击“下一步”。可用下面的验证脚本重新测试当前有房方案：

```sh
npm run validate:tripla -- --config config.ubuya.example.json
```

它允许官网创建匿名查询会话，拦截其他非 GET/HEAD/OPTIONS 请求，只填虚构联系资料；没有报价时会明确报 `NO_MATCHING_OFFER`。报告仅记录字段是否已填，不记录字段值或会话 token。监控会自动从官网取得新的匿名会话，收到 401 时最多刷新一次；不会要求你从浏览器复制或长期保存会话令牌。

本次没有测试实际创建预约、退款、支付或服务端库存保留期限。进入旅客页、返回库存 0，以及浏览器等待时间都不能用来确认锁单机制。
