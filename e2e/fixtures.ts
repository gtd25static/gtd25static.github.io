import { test as base } from '@playwright/test';
import { FakeGitHub } from './fake-github';

export { expect } from '@playwright/test';

export const test = base.extend<{ github: FakeGitHub }>({
  // Automatic: every test's context talks to an in-memory GitHub, and any request
  // to another external host is blocked and fails the test. Contexts a test
  // creates itself must call github.install(context) too.
  github: [
    async ({ context }, provide, testInfo) => {
      const github = new FakeGitHub();
      await github.install(context);
      await provide(github);
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('fake-github-requests.json', {
          body: JSON.stringify({ requests: github.requests, unhandled: github.unhandled }, null, 2),
          contentType: 'application/json',
        });
      }
      if (github.blockedExternal.length > 0) {
        throw new Error(`Blocked requests to external hosts:\n${github.blockedExternal.join('\n')}`);
      }
    },
    { auto: true },
  ],
});
