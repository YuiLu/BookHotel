import { reserveUrl } from './domain.js';
const cell=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
export function availabilityMarkdown(result,config) {
  const lines=[`# ${config.hotel.name} 空房查询`,`\n酒店编号：${config.hotel.code}`,`\n目标查询时间：${result.at}`,`\n备选查询时间：${result.alternativesCheckedAt??result.at}`,
    '\n查询结果是可订报价，不代表库存已保留。没有报价可能是未开放、售罄或人数/方案条件不符。',
    '\n## 查询日期','\n| 入住 | 退房 | 日期偏移 | 返回报价数 |','| --- | --- | --- | --- |'];
  for(const d of result.dates)lines.push(`| ${d.stay.checkIn} | ${d.stay.checkOut} | ${d.offset} | ${d.bookableOffers} |`);
  for(const [title,offers]of [['目标方案',result.primary],['备选建议',result.alternatives]]) {
    lines.push(`\n## ${title}`);
    if(!offers.length){lines.push('\n暂无符合查询范围的报价。');continue;}
    lines.push('\n| 入住→退房 | 偏移 | 房型 | 方案 | 合计 JPY | 预算 | 官网预约页 |','| --- | --- | --- | --- | ---: | --- | --- |');
    for(const c of offers) {
      const within=c.totalJpy+config.filters.extraTaxBudgetJpy<=config.filters.maxTotalJpy;
      lines.push(`| ${c.stay.checkIn}→${c.stay.checkOut} | ${c.offset??0} | ${cell(c.roomName)} (${c.roomCode}) | ${cell(c.planName)} (${c.planCode})${c.noRefund?'（不可退款）':''} | ${c.totalJpy.toLocaleString('en-US')} | ${within?'范围内':'超预算'} | [查看](${reserveUrl(c,config.guests,config.hotel)}) |`);
    }
  }
  lines.push(`\n价格为所选人数、全部住宿晚数的方案合计；预算另预留 ${config.filters.extraTaxBudgetJpy} JPY 现场税费。`,
    `\n备选自动预约：${config.alternatives.allowBooking?'已启用，只选择新查询且预算内的建议':'未启用，只供参考'}。`);
  return lines.join('\n')+'\n';
}
