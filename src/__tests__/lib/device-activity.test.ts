import { deviceActivity, DEVICE_INACTIVE_MS } from '../../lib/device-activity';

const DAY = 24 * 60 * 60 * 1000;

// What a trusted device shows about a protected one (option 1: silence only).
describe('deviceActivity', () => {
  it('shows nothing until a refresh has been seen', () => {
    expect(deviceActivity(undefined)).toBeNull();
  });

  it('shows when it was last seen while that is recent', () => {
    const now = Date.now();
    expect(deviceActivity(now - 3 * DAY, now)).toEqual({ text: 'Last seen 3d ago', inactive: false });
  });

  it('after two weeks of silence says so, and never claims a wipe', () => {
    const now = Date.now();
    const activity = deviceActivity(now - DEVICE_INACTIVE_MS - DAY, now);
    expect(activity?.inactive).toBe(true);
    expect(activity?.text).toMatch(/^No activity since /);
    expect(activity?.text).not.toMatch(/wiped(?!\?)/i); // only ever asked, never stated
  });
});
