import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Localiza um Chromium headless: `CHROME_PATH` ou o cache do Playwright (`~/.cache/ms-playwright`). */
export function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  for (const dir of fs.readdirSync(root).sort().reverse()) {
    if (!dir.startsWith('chromium')) continue;
    for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = path.join(root, dir, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}
