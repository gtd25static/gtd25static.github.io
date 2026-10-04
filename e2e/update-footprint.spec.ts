import { test, expect } from './fixtures';

// The background update check polls version.json from the app's host — every
// 30 minutes, after syncs, on focus. It used to carry the last 25 commit
// subjects ("…remote unlock and wipe", "…what a PAT holder could make devices
// do") to anyone reading the traffic. It now names the build only; the subjects
// moved to changes.json, fetched when an update is offered.

test('version.json names the build only; the changelog is in changes.json', async ({ request }) => {
  const version = await (await request.get('/version.json')).json();
  expect(Object.keys(version).sort()).toEqual(['builtAt', 'commit']);

  const changes = await (await request.get('/changes.json')).json();
  expect(changes.commit).toBe(version.commit);
  expect(Array.isArray(changes.log)).toBe(true);
  expect(changes.log.length).toBeGreaterThan(0);
});
