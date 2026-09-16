import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('actual Next background revalidation and the foreground freshness bound share one read', () => {
 const result = JSON.parse(execFileSync(process.execPath,
  [path.resolve(__dirname, '../test-support/discover-shared-read-next.cjs')],
  { encoding: 'utf8', timeout: 20000 }));
 expect(result.cases).toEqual([
  { ageMs:61000, reads:1, writes:1, result:['fresh'] },
  { ageMs:31000, reads:1, writes:1, result:['cached'] },
 ]);
}, 25000);
