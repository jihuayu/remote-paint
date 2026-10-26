// Trusted opt-in verifier configuration; every run owns a fresh profile.
export function cacheBrowserOptions() {
  return {
    executablePath: process.env.REMOTE_PAINT_TEST_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'],
  };
}
