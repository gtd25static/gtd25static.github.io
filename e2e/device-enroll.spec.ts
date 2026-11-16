// QR enrolment on the production build (CSP included), two devices on the fake
// GitHub: the device that syncs shows a QR, the new one "scans" it — its camera is
// a canvas showing the very SVG the first device rendered, decoded by the real
// jsQR — both show the same code, and once it is confirmed the new device has the
// credentials and the repository's data in place of its own. Nothing of the
// exchange lands on the default branch, and its branch is gone afterwards.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import type { FakeGitHub } from './fake-github';
import {
  SYNC_PASSWORD, closeSettings, configureSync, createList, createTask, dialogTitled, openApp, openList, openSettings,
  readSyncSettings, taskCards,
} from './helpers';

async function newDevice(browser: Browser, github: FakeGitHub): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(context);
  const page = await context.newPage();
  await openApp(page);
  return { context, page };
}

/**
 * Replace the page's camera with a canvas showing this SVG the way a phone held
 * up to a laptop sees it: the code covers ~40% of the frame's height, on a grey
 * bezel, tilted a little, slightly out of focus, washed out (a lit screen filmed)
 * and noisy. Like Chrome, the camera gives 640×480 unless a resolution is asked
 * for. What was asked is kept in `window.__cameraAsked`.
 */
async function pointCameraAt(page: Page, svg: string): Promise<void> {
  await page.evaluate(async (markup) => {
    const image = new Image();
    // Without a size the SVG rasterises at the browser's default and is stretched.
    image.src = `data:image/svg+xml;base64,${btoa(markup.replace('<svg ', '<svg width="1000" height="1000" '))}`;
    await image.decode();
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      (window as unknown as { __cameraAsked: unknown }).__cameraAsked = constraints;
      const video = (constraints?.video ?? {}) as { width?: { ideal?: number }; height?: { ideal?: number } };
      const width = video.width?.ideal ?? 640;
      const height = video.height?.ideal ?? 480;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const noise = [0, 1, 2].map(() => {
        const layer = document.createElement('canvas');
        layer.width = width;
        layer.height = height;
        const pixels = layer.getContext('2d')!.createImageData(width, height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const v = Math.random() * 255;
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
          pixels.data[i + 3] = 255;
        }
        layer.getContext('2d')!.putImageData(pixels, 0, 0);
        return layer;
      });
      const qr = height * 0.4;
      let frame = 0;
      const draw = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#5a5a5a';
        ctx.fillRect(0, 0, width, height);
        ctx.translate(width / 2, height / 2);
        ctx.rotate((6 * Math.PI) / 180);
        ctx.filter = `blur(${height / 720}px) contrast(0.6) brightness(1.05)`;
        ctx.drawImage(image, -qr / 2, -qr / 2, qr, qr);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = 'none';
        ctx.globalAlpha = 0.18;
        ctx.drawImage(noise[frame++ % noise.length], 0, 0);
      };
      draw();
      setInterval(draw, 100); // a static canvas stops producing frames
      return canvas.captureStream(10);
    };
  }, svg);
}

test('a new device joins from a QR code, replacing its own data, and the exchange leaves no trace on the default branch', async ({ page, browser, github }) => {
  github.refs = true;

  // The device that syncs already.
  await openApp(page);
  await createList(page, 'Ring list');
  await createTask(page, 'Task from the ring');
  await configureSync(page, github);
  await closeSettings(page);
  await expect.poll(() => github.readText('gtd25-changelog.json') ?? '', { timeout: 60_000 }).toBe('[]');

  // The new device, with data of its own that the join replaces.
  const other = await newDevice(browser, github);
  await createList(other.page, 'Only on the new device');

  // Old device: show the code.
  const settings = await openSettings(page, 'General');
  await settings.getByRole('button', { name: 'Add a device (QR)', exact: true }).click();
  const show = dialogTitled(page, 'Add a device');
  const qr = show.getByRole('img', { name: 'Enrolment QR code' });
  await expect(qr).toBeVisible();
  const svg = await qr.evaluate((el) => new XMLSerializer().serializeToString(el));
  expect(svg).not.toContain(SYNC_PASSWORD);

  // New device: scan it.
  await pointCameraAt(other.page, svg);
  const otherSettings = await openSettings(other.page, 'General');
  await otherSettings.getByRole('button', { name: 'Join with a QR code', exact: true }).click();
  const scan = dialogTitled(other.page, 'Join with a QR code');
  await scan.getByRole('button', { name: 'Open camera', exact: true }).click();
  const newCode = scan.getByTestId('enroll-code');
  await expect(newCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  // The back camera at 1080p: at the 640×480 Chrome opens by default this frame is not read.
  expect(await other.page.evaluate(() => (window as unknown as { __cameraAsked: unknown }).__cameraAsked)).toMatchObject({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  await expect(scan.getByText(github.fullName)).toBeVisible();

  // Both screens show the same code; the QR is off the old device's screen.
  const oldCode = show.getByTestId('enroll-code');
  await expect(oldCode).toHaveText((await newCode.textContent())!, { timeout: 30_000 });
  await expect(qr).toBeHidden();
  // The exchange is on its own branch, which holds nothing else, never on the default one.
  expect(github.branchNames().filter((b) => b.startsWith('gtd25-enroll-'))).toHaveLength(1);
  const exchange = github.paths().filter((p) => p.includes('gtd25-enroll'));
  expect(exchange).toHaveLength(1);
  expect(exchange[0]).toMatch(/^gtd25-enroll-[\w-]+:gtd25-enroll\.json$/);

  await show.getByRole('button', { name: 'It matches — send', exact: true }).click();
  await expect(scan.getByText(/now syncs with/)).toBeVisible({ timeout: 60_000 });
  await expect(show.getByText(/has the password and is downloading/)).toBeVisible({ timeout: 30_000 });

  // The new device holds the credentials and the ring's data, not its own.
  await scan.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await readSyncSettings(other.page)).toMatchObject({ token: github.token, repo: github.fullName, password: SYNC_PASSWORD });
  await closeSettings(other.page);
  await openList(other.page, 'Ring list', { timeout: 60_000 });
  await expect(taskCards(other.page).filter({ hasText: 'Task from the ring' })).toBeVisible();
  await expect(other.page.locator('aside nav').getByText('Only on the new device')).toHaveCount(0);

  // No exchange branch left, and nothing of it ever on the default branch.
  expect(github.branchNames()).toEqual(['main']);
  expect(github.paths().filter((p) => p.includes('gtd25-enroll'))).toEqual([]);

  await other.context.close();
});
