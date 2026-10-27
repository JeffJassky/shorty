import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Slug rename modes (spec §2.4). scripts/e2e.mjs starts one example host per
 * mode (SHORTY_RENAME) and passes each base URL in an env var.
 */
const BASES = {
  always: process.env.E2E_BASE_URL_ALWAYS,
  untilClicked: process.env.E2E_BASE_URL_UNTIL_CLICKED,
  never: process.env.E2E_BASE_URL_NEVER,
};

async function seed(request: APIRequestContext, slug: string): Promise<{ id: string }> {
  const res = await request.post('api/links', { data: { url: `https://example.com/${slug}`, slug } });
  expect(res.status()).toBe(201);
  return (await res.json()).link;
}
const originOf = (base: string) => new URL(base).origin;

test.describe('always', () => {
  test.skip(!BASES.always, 'no always host');
  test.use({ baseURL: BASES.always });

  test('confirm dialog, then the old short URL stops working', async ({ page, request }) => {
    const link = await seed(request, 'old-always');
    await page.goto(`./#/links/${link.id}/edit`);
    await page.locator('#f-slug').fill('new-always');
    await expect(page.locator('#f-slug-status')).toContainText('Available');
    await expect(page.getByText("will get a \u2018not found\u2019 page").first()).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();

    const confirm = page.getByRole('dialog', { name: 'Change the short link?' });
    await expect(confirm).toContainText('old-always');
    await confirm.getByRole('button', { name: 'Change it' }).click();
    await expect(page.getByText('Link saved')).toBeVisible();

    const origin = originOf(BASES.always!);
    expect((await page.request.get(`${origin}/go/new-always`, { maxRedirects: 0 })).status()).toBe(302);
    expect((await page.request.get(`${origin}/go/old-always`, { maxRedirects: 0 })).status()).toBe(404);
  });
});

test.describe('untilClicked', () => {
  test.skip(!BASES.untilClicked, 'no untilClicked host');
  test.use({ baseURL: BASES.untilClicked });

  test('editable until the first human click, then locked', async ({ page, request }) => {
    const link = await seed(request, 'until-click');
    await page.goto(`./#/links/${link.id}/edit`);
    await expect(page.locator('#f-slug')).toBeEditable();

    const res = await page.request.get(`${originOf(BASES.untilClicked!)}/go/until-click`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    await expect.poll(async () => (await (await request.get(`api/links/${link.id}`)).json()).link.clicks).toBeGreaterThan(0);

    await page.reload();
    const slug = page.locator('#f-slug');
    await expect(slug).toHaveJSProperty('readOnly', true);
    await expect(page.getByRole('img', { name: 'Locked after the first click so printed links keep working.' })).toBeVisible();
  });
});

test.describe('never', () => {
  test.skip(!BASES.never, 'no never host');
  test.use({ baseURL: BASES.never });

  test('the slug is read-only from the start', async ({ page, request }) => {
    const link = await seed(request, 'fixed-forever');
    await page.goto(`./#/links/${link.id}/edit`);
    await expect(page.locator('#f-slug')).toHaveJSProperty('readOnly', true);
    await expect(page.getByRole('img', { name: "Short links can't be renamed." })).toBeVisible();
  });
});
