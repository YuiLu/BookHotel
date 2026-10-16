import { chromium } from 'playwright';
export async function openBrowser(config) {
  const c=config.browser;
  const browser=await chromium.launch({headless:c.headless,executablePath:c.executablePath,
    channel:c.channel==='chromium'?undefined:c.channel});
  const context=await browser.newContext({locale:config.hotel?.engine==='tripla'?'zh-CN':'ja-JP',timezoneId:'Asia/Tokyo',viewport:{width:1440,height:1000},serviceWorkers:'block'});
  context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(45000);
  return {browser,context,page:await context.newPage()};
}
