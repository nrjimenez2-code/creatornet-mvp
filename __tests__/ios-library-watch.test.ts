import { NextRequest } from 'next/server';
import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';

const buyer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const creator = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const postId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let db: MockClient;
let actor = { id: buyer };
let purchaseAllowed = true;
let premiumPath = `${creator}/lesson.pdf`;
let entitlement: unknown = { allowed: true, maxAgeSeconds: 17 };
const sign = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return db; } }));
jest.mock('@/lib/mobileApi', () => ({ mobileApi: (handler: (req: NextRequest, user: typeof actor) => Promise<Response>) =>
  (req: NextRequest) => handler(req, actor) }));

import { GET as libraryGet } from '@/app/api/mobile/library/route';
import { GET as watchGet } from '@/app/api/mobile/watch/[postId]/route';
import { POST as progressPost } from '@/app/api/mobile/watch/progress/route';

const post = () => ({ id: postId, creator_id: creator, title: 'Synthetic lesson', poster_url: null,
  video_url: 'https://media.example.invalid/preview.mp4', premium_path: premiumPath,
  duration_seconds: 60, hidden_at: null, removed_at: null });
const purchase = (id: string, buyerId = buyer, allowed = purchaseAllowed) => ({ id, buyer_id: buyerId,
  post_id: postId, created_at: '2026-10-08T00:00:00Z', status: allowed ? 'paid' : 'refunded',
  access_granted: allowed, posts: post() });
beforeEach(() => {
  actor = { id: buyer }; purchaseAllowed = true; premiumPath = `${creator}/lesson.pdf`;
  entitlement = { allowed: true, maxAgeSeconds: 17 };
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = 'false';
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = 'false';
  sign.mockReset().mockResolvedValue({ data: { signedUrl: 'https://storage.example.invalid/signed' }, error: null });
  db = createMockClient(op => {
    if (op.table === 'posts') return { data: post(), error: null };
    if (op.table === 'purchases' && op.columns?.includes('posts(')) return { data: [
      purchase('owned'), purchase('revoked', buyer, false), purchase('foreign', other, true),
    ], error: null };
    if (op.table === 'purchases') return { data: [purchase('owned', buyer, purchaseAllowed)], error: null };
    if (op.table === 'watch_progress') return { data: [{ post_id: postId, seconds: 8 }], error: null };
    if (op.table === 'profiles') return { data: [{ id: creator, username: 'teacher', full_name: 'Teacher' }], error: null };
    if (op.table.startsWith('read_') && op.table.endsWith('_entitlement_v1')) return { data: entitlement, error: null };
    return undefined;
  });
  db.storage.from = () => ({ createSignedUrl: sign });
});
afterAll(() => {
  delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
  delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
});

test('mobile library lists only current purchases owned by the bearer identity', async () => {
  const response = await libraryGet(new NextRequest('https://site.example.invalid/api/mobile/library?page=0'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items).toEqual([expect.objectContaining({ id: 'owned', postId, creatorName: 'Teacher', positionSeconds: 8 })]);
  expect(db.opsFor('purchases')[0]).toMatchObject({ filters: { buyer_id: buyer }, range: { from: 0, to: 50 } });
  expect(sign).not.toHaveBeenCalled();
});

test('mobile Watch signs an owned file, then rejects revoked access', async () => {
  const request = () => watchGet(new NextRequest(`https://site.example.invalid/api/mobile/watch/${postId}`), { params: Promise.resolve({ postId }) });
  const allowed = await request();
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).downloadUrl).toBe('https://storage.example.invalid/signed');
  expect(sign).toHaveBeenCalledWith(`${creator}/lesson.pdf`, 3600);
  expect(db.opsFor('purchases')[0].filters).toMatchObject({ buyer_id: buyer, post_id: postId });
  sign.mockClear(); purchaseAllowed = false;
  expect((await request()).status).toBe(402);
  expect(sign).not.toHaveBeenCalled();
});

test('mobile Watch bounds a timed download to live entitlement and rejects a foreign file path', async () => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = 'true';
  purchaseAllowed = false;
  const request = () => watchGet(new NextRequest(`https://site.example.invalid/api/mobile/watch/${postId}`), { params: Promise.resolve({ postId }) });
  expect((await request()).status).toBe(200);
  expect(sign).toHaveBeenCalledWith(`${creator}/lesson.pdf`, 17);
  sign.mockClear(); entitlement = { allowed: false, maxAgeSeconds: 0 };
  expect((await request()).status).toBe(402);
  expect(sign).not.toHaveBeenCalled();
  entitlement = { allowed: true, maxAgeSeconds: 17 }; premiumPath = `${other}/private.pdf`;
  const unsafe = await request();
  expect(unsafe.status).toBe(200);
  expect((await unsafe.json()).downloadUrl).toBeNull();
  expect(sign).not.toHaveBeenCalled();
});

test('mobile progress writes only for live access and the authenticated account', async () => {
  const request = (seconds: number, duration: number) => progressPost(new NextRequest('https://site.example.invalid/api/mobile/watch/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ post_id: postId, seconds, duration, user_id: other }),
  }));
  expect((await request(90, 60)).status).toBe(200);
  expect(db.opsFor('watch_progress')[0]).toMatchObject({ kind: 'upsert', payload: { user_id: buyer, post_id: postId, seconds: 60 } });
  db.ops.length = 0; purchaseAllowed = false;
  expect((await request(5, 60)).status).toBe(402);
  expect(db.opsFor('watch_progress')).toHaveLength(0);
  expect((await request(-1, 60)).status).toBe(400);
  expect(db.opsFor('watch_progress')).toHaveLength(0);
});
