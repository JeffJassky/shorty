import { expect, test, type Page } from '@playwright/test';

/**
 * PR 6 (plans/ui-spec.md §8, tests 7–8): link detail + analytics overview.
 * File name sorts after links.spec.ts on purpose — test 1 there needs an empty
 * database, and these tests add a link with clicks.
 */
test.describe.configure({ mode: 'serial' });

const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let link: { id: string; slug: string; shortUrl: string };

const kpi = (page: Page, label: string) => page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.kpi-value');

test('7. 3 human + 1 bot click: detail shows 3, Include shows 4, Show separately draws the bot band', async ({ page, request }) => {
  const res = await request.post('api/links', { data: { url: 'https://example.com/analytics-demo?utm_campaign=stats_demo', slug: 'stats-demo' } });
  expect(res.status()).toBe(201);
  link = (await res.json()).link;

  for (let i = 0; i < 3; i++) {
    const hit = await request.get(link.shortUrl, { maxRedirects: 0, headers: { 'user-agent': HUMAN_UA } });
    expect(hit.status()).toBe(302);
  }
  const botHit = await request.get(link.shortUrl, { maxRedirects: 0, headers: { 'user-agent': BOT_UA } });
  expect(botHit.status()).toBe(302);

  // Tracking runs after the response; wait on the stats the page will read,
  // not on time, and not just on the link counters.
  await expect.poll(async () => {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    const res = await page.request.get(`api/links/${link.id}/stats?from=${from}&to=${to}&interval=day`);
    const t = (await res.json()).totals;
    return [t.humans.clicks, t.bots.clicks];
  }).toEqual([3, 1]);

  await page.goto(`./#/links/${link.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(kpi(page, 'Clicks')).toHaveText('3');
  await expect(page.getByRole('radio', { name: 'Hide' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('bot-band')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Include' }).click();
  await expect(kpi(page, 'Clicks')).toHaveText('4');

  await page.getByRole('radio', { name: 'Show separately' }).click();
  await expect(kpi(page, 'Clicks')).toHaveText('3');
  await expect(page.getByTestId('bot-band')).toBeAttached();
  await expect(page.locator('.kpi', { hasText: '+1 bots' }).first()).toBeVisible();

  // The choice sticks for this viewer.
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Show separately' })).toHaveAttribute('aria-checked', 'true');

  // Breakdowns are populated and the chart has an accessible summary.
  await expect(page.getByRole('region', { name: 'Referrers' })).toContainText('Direct');
  await expect(page.getByRole('region', { name: 'Devices' })).toBeVisible();
  await expect(page.getByTestId('timeseries')).toHaveAttribute('aria-label', /clicks/);
});

test('7b. a row click on the list opens the detail; Edit stays in the menu', async ({ page }) => {
  await page.goto('./');
  const row = page.locator('.link-row', { hasText: '/go/stats-demo' });
  await row.locator('.cell-dest').click();
  await expect(page).toHaveURL(new RegExp(`#/links/${link.id}$`));
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
});

test('7c. Edit from the detail page returns to the detail page on close and on save', async ({ page }) => {
  await page.goto(`./#/links/${link.id}`);
  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog', { name: /link/i }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`#/links/${link.id}$`));
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.locator('#f-title').fill('Renamed from detail');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`#/links/${link.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Renamed from detail');
});

test('8. analytics overview lists the link under Top links with its count, and the campaign', async ({ page }) => {
  await page.goto('./#/analytics');
  const top = page.getByRole('region', { name: 'Top links' });
  await expect(top.getByRole('link', { name: '/stats-demo' })).toBeVisible();
  await expect(top.locator('tr', { hasText: '/stats-demo' }).locator('td.num')).toHaveText('3');
  await expect(page.getByRole('region', { name: 'Top campaigns' }).locator('tr', { hasText: 'stats_demo' }).locator('td.num')).toHaveText('3');
  // Hide mode: no bot tile; Show separately adds it and the bot suffix.
  await expect(page.locator('.kpi-label', { hasText: 'Bot clicks' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Show separately' }).click();
  await expect(page.locator('.kpi-label', { hasText: 'Bot clicks' })).toBeVisible();
  await top.getByRole('link', { name: '/stats-demo' }).click();
  await expect(page).toHaveURL(new RegExp(`#/links/${link.id}$`));
});

test('range picker: 12 months renders without error; custom sends YYYY-MM-DD; over 400 days is refused', async ({ page }) => {
  await page.goto('./#/analytics');
  const urls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/stats')) urls.push(r.url()); });

  const twelve = page.waitForResponse((r) => r.url().includes('/stats') && r.url().includes('interval=week'));
  await page.getByRole('radio', { name: '12 months' }).click();
  expect((await twelve).status()).toBe(200);
  await expect(page.getByTestId('timeseries')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Custom' }).click();
  await page.getByLabel('From date').fill('2026-01-01');
  await page.getByLabel('To date').fill('2026-01-31');
  await expect.poll(() => urls.some((u) => /from=2026-01-01&to=2026-01-31/.test(u) || (u.includes('from=2026-01-01') && u.includes('to=2026-01-31')))).toBe(true);
  await expect(page.getByTestId('timeseries')).toBeVisible();

  await page.getByLabel('From date').fill('2020-01-01');
  await page.getByLabel('To date').fill('2024-01-01');
  await expect(page.getByRole('alert')).toContainText('400 days');
});

test('375px: analytics has no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`./#/links/${link.id}`);
  await expect(kpi(page, 'Clicks')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.goto('./#/analytics');
  await expect(page.getByRole('region', { name: 'Top links' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
