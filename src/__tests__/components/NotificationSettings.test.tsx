// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../__tests__/setup-component';
import { NotificationSettings } from '../../components/settings/NotificationSettings';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';

beforeEach(async () => {
  await resetDb();
  // ensureDefaults() created the 'local' row (with deviceId); seed a known window.
  await db.localSettings.update('local', {
    nudgesEnabled: true,
    nudgeIntervalHours: 3,
    nudgeWindowStart: 9,
    nudgeWindowEnd: 18,
    nudgeDayOverrides: undefined,
  });
});

describe('NotificationSettings per-day overrides', () => {
  it('persists silenced days and earlier per-day cutoffs on save', async () => {
    render(<NotificationSettings />);

    // Form mounts once the live record (deviceId) resolves.
    fireEvent.click(await screen.findByRole('switch', { name: 'Sat' })); // weekend off
    fireEvent.click(screen.getByRole('switch', { name: 'Sun' }));        // weekend off
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fri end hour' }), { target: { value: '15' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const local = await db.localSettings.get('local');
      // getDay(): Sun=0, Fri=5, Sat=6. Mon–Thu keep the global window (no entry).
      expect(local?.nudgeDayOverrides).toEqual({
        0: { off: true },
        5: { end: 15 },
        6: { off: true },
      });
    });
  });

  it('clears a day override when the day is turned back on with no custom end', async () => {
    await db.localSettings.update('local', { nudgeDayOverrides: { 5: { end: 15 }, 6: { off: true } } });
    render(<NotificationSettings />);

    // Saturday starts off; toggle it back on. Friday's end input starts at 15; clear it.
    fireEvent.click(await screen.findByRole('switch', { name: 'Sat' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fri end hour' }), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const local = await db.localSettings.get('local');
      expect(local?.nudgeDayOverrides).toEqual({}); // back to the global window everywhere
    });
  });
});
