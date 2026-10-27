import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * PR 5 happy paths (plans/ui-spec.md §8, tests 1–6), against the example host.
 * Serial on purpose: one in-memory database, and test 1 needs it empty.
 */
test.describe.configure({ mode: 'serial' });

const PASTED = 'https://example.com/pricing?utm_source=instagram&utm_medium=social&utm_campaign=spring_sale&ref=abc#plans';

async function seed(request: APIRequestContext, body: Record<string, unknown>): Promise<{ slug: string; shortUrl: string; id: string }> {
  const res = await request.post('api/links', { data: body });
  expect(res.status()).toBe(201);
  return (await res.json()).link;
}

/** Fires a real `paste` event on the document, as a browser does for Cmd+V outside an input. */
async function pasteAnywhere(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

const sheet = (page: Page) => page.getByRole('dialog', { name: /link/i }).first();
/** The UTM group is collapsed until a tag is set (spec §2.1). */
async function openUtm(page: Page): Promise<void> {
  const head = page.getByRole('button', { name: /Campaign tracking/ });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
}
const destination = (page: Page) => page.getByLabel('Destination', { exact: true });

test('1. empty state: paste a URL with UTMs, fields split, anatomy colours, save, copy', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Make your first short link' })).toBeVisible();

  await pasteAnywhere(page, PASTED);

  await expect(page.getByRole('dialog', { name: 'New link' })).toBeVisible();
  await expect(destination(page)).toHaveValue('https://example.com/pricing');
  await expect(page.getByLabel('Source', { exact: true })).toHaveValue('instagram');
  await expect(page.getByLabel('Medium', { exact: true })).toHaveValue('social');
  await expect(page.getByLabel('Campaign', { exact: true })).toHaveValue('spring_sale');
  await expect(page.getByLabel('Parameter name')).toHaveValue('ref');
  await expect(page.getByLabel('Parameter value')).toHaveValue('abc');

  const anatomy = page.getByLabel('Link anatomy');
  await expect(anatomy.locator('.anat-seg.utm')).toHaveText(['utm_source=instagram', 'utm_medium=social', 'utm_campaign=spring_sale']);
  await expect(anatomy.locator('.anat-seg.custom')).toHaveText(['ref=abc']);
  await expect(anatomy.locator('.anat-seg.hash')).toHaveText(['plans']);
  // The UTM segments really are coloured, not just classed.
  const bg = await anatomy.locator('.anat-seg.utm').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const neutral = await anatomy.locator('.anat-seg.origin').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe(neutral);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Link saved')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New link' })).toBeHidden();

  const row = page.locator('.link-row').first();
  await expect(row).toBeVisible();
  const shortUrl = (await row.locator('.short-url').textContent()) ?? '';
  expect(shortUrl).toMatch(/\/go\/[a-z0-9]+$/);
  await row.getByRole('button', { name: 'Copy short link' }).click();
  await expect(row.getByText('Copied')).toBeAttached();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shortUrl);
});

test('2. custom slug: taken shows the reason, available shows a check, then save', async ({ page, request }) => {
  await seed(request, { url: 'https://example.com/taken', slug: 'taken-one' });
  await page.goto('./');
  await page.getByRole('link', { name: 'New link' }).click();
  await destination(page).fill('https://example.com/two');
  await page.getByRole('radio', { name: 'Custom' }).click();

  const slug = page.locator('#f-slug');
  await slug.fill('taken-one');
  await expect(page.locator('#f-slug-status')).toContainText('That ending is already in use.');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await slug.fill('fresh-ending');
  await expect(page.locator('#f-slug-status')).toContainText('Available');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Link saved')).toBeVisible();
  await expect(page.locator('.link-row', { hasText: '/go/fresh-ending' })).toBeVisible();
});

test('3. combobox: previous values suggest with a count; near-duplicates offer the existing value', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('link', { name: 'New link' }).click();
  await destination(page).fill('https://example.com/podcast');
  await openUtm(page);
  await page.getByLabel('Source', { exact: true }).fill('podcastads');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Link saved')).toBeVisible();

  await page.getByRole('link', { name: 'New link' }).click();
  await destination(page).fill('https://example.com/podcast-two');
  await openUtm(page);
  const source = page.getByLabel('Source', { exact: true });
  await source.fill('podc');
  await expect(page.getByRole('option', { name: /podcastads · 1 link/ })).toBeVisible();

  await source.fill('Podcast-Ads');
  const lint = page.getByText(/1 link uses/);
  await expect(lint).toContainText('podcastads');
  await page.getByRole('button', { name: 'Use podcastads' }).click();
  await expect(source).toHaveValue('podcastads');
});

test('4. edit under alias: rename shows the note and the old short URL keeps redirecting', async ({ page, request, baseURL }) => {
  const link = await seed(request, { url: 'https://example.com/rename', slug: 'rename-me' });
  await page.goto(`./#/links/${link.id}/edit`);
  const slug = page.locator('#f-slug');
  await expect(slug).toHaveValue('rename-me');

  await slug.fill('renamed-link');
  await expect(page.locator('#f-slug-status')).toContainText('Available');
  await expect(page.getByText('will keep working')).toContainText('rename-me');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Link saved')).toBeVisible();

  const origin = new URL(baseURL ?? 'http://127.0.0.1:3000/admin/links/').origin;
  for (const slugName of ['rename-me', 'renamed-link']) {
    const res = await page.request.get(`${origin}/go/${slugName}`, { maxRedirects: 0 });
    expect(res.status(), slugName).toBe(302);
    expect(res.headers().location).toBe('https://example.com/rename');
  }
});

test('5. archive hides the link; Show archived brings it back', async ({ page, request }) => {
  await seed(request, { url: 'https://example.com/archive-me', slug: 'archive-me' });
  await page.goto('./');
  const row = page.locator('.link-row', { hasText: '/go/archive-me' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(row).toBeHidden();

  await page.getByRole('switch', { name: 'Show archived' }).check();
  const archived = page.locator('.link-row', { hasText: '/go/archive-me' });
  await expect(archived).toBeVisible();
  await expect(archived.getByText('Archived', { exact: true })).toBeVisible();
});

test.describe('6. phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('create flow completes and nothing scrolls sideways', async ({ page }) => {
    const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await page.goto('./');
    await expect(page.locator('.link-row').first()).toBeVisible();
    expect(await noSideScroll()).toBe(true);

    await page.getByRole('link', { name: 'New link' }).click();
    await expect(sheet(page)).toBeVisible();
    await destination(page).fill(PASTED);
    await destination(page).blur();
    await expect(page.getByLabel('Source', { exact: true })).toHaveValue('instagram');
    await expect(page.getByLabel('Link anatomy')).toBeVisible();
    expect(await noSideScroll()).toBe(true);
    const overflowing = await page.evaluate(() => {
      const box = document.querySelector('.sheet');
      return box ? box.scrollWidth > box.clientWidth : false;
    });
    expect(overflowing).toBe(false);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Link saved')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'New link' })).toBeHidden();
    expect(await noSideScroll()).toBe(true);
  });
});
