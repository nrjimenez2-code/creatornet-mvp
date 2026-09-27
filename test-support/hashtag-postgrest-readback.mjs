// Read-only acceptance against the existing staging PostgREST service.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { normalize } from 'node:path';
import assert from 'node:assert/strict';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (new URL(config.url).hostname !== 'nwqfofezfzljhxolkycz.supabase.co') throw Error('Staging binding required');
const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
(async () => {
  const legacy = await client.from('posts').select('id').ilike('hashtags', '%entrepreneurship%').limit(1);
  assert.equal(legacy.error?.code, '42883', 'The baseline text-array operator must fail');
  const exact = await client.from('posts').select('id,hashtags').contains('hashtags', ['entrepreneurship']).is('hidden_at', null).is('removed_at', null).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(3);
  assert.equal(exact.error, null);
  assert.ok(exact.data.length > 0, 'Existing canonical staging tags must be visible to PostgREST');
  assert.ok(exact.data.every(row => row.hashtags.includes('entrepreneurship')));
  const partial = await client.from('posts').select('id').contains('hashtags', ['entrepreneur']).limit(3);
  assert.equal(partial.error, null);
  assert.equal(partial.data.length, 0, 'Array contains must not match a substring');
  const caption = await client.from('posts').select('id').filter('content', 'imatch', '#entrepreneurship([^a-z0-9_]|$)').is('hidden_at', null).is('removed_at', null).limit(3);
  assert.equal(caption.error, null, 'The exact caption-tag filter must work on hosted PostgREST');
  const result = { checkedAt: new Date().toISOString(), project: 'nwqfofezfzljhxolkycz', readOnly: true, baselineErrorCode: legacy.error.code, containsStatus: exact.status, exactMatchCount: exact.data.length, substringMatchCount: partial.data.length, captionRegexStatus: caption.status };
  if (process.argv[3]) writeFileSync(normalize(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(err => { console.error(err.message); process.exitCode = 1; });
