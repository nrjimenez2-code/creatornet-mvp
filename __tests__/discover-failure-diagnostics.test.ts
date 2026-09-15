import { NextRequest } from 'next/server';
const createSession = jest.fn();
jest.mock('@/lib/supabaseServer', () => ({createServerClient: jest.fn()}));
jest.mock('@/lib/discoverServer', () => ({
 discoverEnabled: () => true,
 discoverIdentity: async () => ({actor:'private-actor',userId:null}),
 createDiscoverSession: (...args: unknown[]) => createSession(...args),
 readDiscoverPage: jest.fn(), setDiscoverCookie: jest.fn(),
}));
import { GET } from '@/app/api/feed/route';
afterEach(() => jest.restoreAllMocks());
test.each(['53300','57014','PGRST003'])('preserves safe database code %s and phase without private detail', async code => {
 const log = jest.spyOn(console,'error').mockImplementation(() => {});
 createSession.mockRejectedValueOnce({code,message:'private database detail',details:'private-actor'});
 const response = await GET(new NextRequest('https://example.test/api/feed'));
 expect(response.status).toBe(503);
 expect(await response.json()).toEqual({error:'Could not load this feed. Refresh to try again.'});
 expect(log).toHaveBeenCalledWith('[discover] feed unavailable',{phase:'session',code});
 expect(JSON.stringify(log.mock.calls)).not.toContain('private');
});
test('rejects arbitrary data in the error code field', async () => {
 const log = jest.spyOn(console,'error').mockImplementation(() => {});
 createSession.mockRejectedValueOnce({code:'secret-token-and-user-id'});
 await GET(new NextRequest('https://example.test/api/feed'));
 expect(log).toHaveBeenCalledWith('[discover] feed unavailable',{phase:'session',code:'UNKNOWN'});
});
