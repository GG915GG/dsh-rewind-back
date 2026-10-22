import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = ['host.test.mjs', 'client.test.cjs'];

for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(here, test)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`FAILED: ${test}`);
    process.exit(result.status ?? 1);
  }
}

console.log('ALL TESTS OK');
