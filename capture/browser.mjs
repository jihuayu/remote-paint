import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

export function browserExecutable() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(mac) ? mac : chromium.executablePath();
}

export async function launchCaptureBrowser() {
  // The file exporter is an opt-in benchmarking API. Use a disposable profile.
  return chromium.launch({
    executablePath: browserExecutable(), headless: true,
    args: ['--enable-gpu-benchmarking', '--no-sandbox', '--disable-gpu-rasterization'],
  });
}
