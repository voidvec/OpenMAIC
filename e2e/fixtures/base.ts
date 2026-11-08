import { test as base } from '@playwright/test';
import { MockApi } from './mock-api';

type Fixtures = {
  mockApi: MockApi;
  /** Answers the workspace model settings on every page (see MockApi.mockModelSettings). */
  modelSettings: void;
  /** Keeps exports on the plain download path (see the fixture for why). */
  browserDownloads: void;
};

export const test = base.extend<Fixtures>({
  // Every page reads the workspace's model settings; by default a course
  // model is set up. A spec that needs another view calls
  // `mockApi.mockModelSettings(...)`, whose routes take precedence.
  modelSettings: [
    async ({ page }, use) => {
      await new MockApi(page).mockModelSettings();
      await use();
    },
    { auto: true },
  ],
  // Every export asks the browser where to write the file through
  // `showDirectoryPicker`, so the reader can pick a folder instead of sorting
  // the download afterwards. Headless Chromium exposes the API but has no
  // dialog to answer it: the picker's promise never settles, no download event
  // fires, and an export spec waits out its whole timeout. Shadowing the
  // property makes the app take its browser-download branch, which is what
  // these specs assert on. The folder chooser itself is covered by the
  // save-target unit tests, where the picker can be stubbed deterministically.
  browserDownloads: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        // WebIDL puts the method on Window.prototype, so `delete` would be a
        // no-op; an own property shadowing it is what the feature check sees.
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        });
      });
      await use();
    },
    { auto: true },
  ],
  mockApi: async ({ page }, use) => {
    await use(new MockApi(page));
  },
});

export { expect } from '@playwright/test';
