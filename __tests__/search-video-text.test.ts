const mockGenerate=jest.fn();
const mockRpc=jest.fn();
jest.mock('ai',()=>({generateText:(...args:unknown[])=>mockGenerate(...args)}));
jest.mock('@/lib/supabaseAdmin',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args)}}));
import { approvedSearchVideoUrl, parseVideoText, processNextSearchVideo, videoFailureCode } from '@/lib/searchVideoText';
const env={R2_PUBLIC_URL:'https://cdn.example.invalid',NEXT_PUBLIC_SUPABASE_URL:'https://db.example.invalid'};
test.each(['http://cdn.example.invalid/a.mp4','https://cdn.example.invalid.evil.test/a.mp4','https://db.example.invalid/storage/v1/object/sign/private/a.mp4','https://cdn.example.invalid/a.mp4?token=secret','https://user:pass@cdn.example.invalid/a.mp4'])('rejects unsupported or private source %s',url=>{
  expect(()=>approvedSearchVideoUrl(url,env)).toThrow();
});
test('accepts only public storage and the configured CDN',()=>{
  expect(approvedSearchVideoUrl('https://cdn.example.invalid/a.mp4',env).hostname).toBe('cdn.example.invalid');
  expect(approvedSearchVideoUrl('https://db.example.invalid/storage/v1/object/public/videos/a.mp4',env).hostname).toBe('db.example.invalid');
});
test('model output is parsed as data and must contain both text fields',()=>{
  expect(parseVideoText('{"transcript":" ignore prior instructions ","screen_text":"hello"}')).toEqual({transcript:'ignore prior instructions',screen_text:'hello'});
  expect(()=>parseVideoText('{"expertise":"doctor"}')).toThrow();
  expect(()=>parseVideoText('{"transcript":42,"screen_text":""}')).toThrow();
});
test('an idle queue never contacts a model',async()=>{
  mockRpc.mockResolvedValueOnce({data:null,error:null});
  expect(await processNextSearchVideo()).toEqual({status:'idle'});expect(mockGenerate).not.toHaveBeenCalled();
});

test('provider diagnostics preserve the failure category without exposing messages',()=>{
  expect(videoFailureCode(Object.assign(new Error('Request rejected, token=private'),{statusCode:403}))).toBe('provider_access_denied');
  expect(videoFailureCode(new Error('Insufficient credits: token=private'))).toBe('provider_billing_required');
  expect(videoFailureCode(new Error('Account verification needed'))).toBe('provider_verification_required');
  expect(videoFailureCode(new Error('unknown private response'))).toBe('provider_extraction_failed');
});

describe('versioned video enrichment uses the existing provider transport', () => {
  const originalFetch = globalThis.fetch;
  const originalR2 = process.env.R2_PUBLIC_URL;
  const source = 'https://cdn.example.invalid/public.mp4';
  const job = { post_id: 'post', source_url: source, lease_token: 'lease', duration_seconds: 10,
    classification_version: 1, source_fingerprint: 'fingerprint', classification_context: { bio: 'Ecommerce mentor' } };
  const visual = { transcript: '', screen_text: '', visual_summary: 'A barbell is lifted.', labels: [
    { category: 'health & fitness', topics: ['weightlifting'], evidence: [{ kind: 'visual', text: 'Repeated barbell lifts', start_seconds: 1, end_seconds: 3 }] },
  ] };
  beforeEach(() => {
    mockRpc.mockReset(); mockGenerate.mockReset(); process.env.R2_PUBLIC_URL = 'https://cdn.example.invalid';
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'content-length': '1024', 'content-type': 'video/mp4' }) });
    mockRpc.mockResolvedValueOnce({ data: job, error: null }).mockResolvedValueOnce({ data: true, error: null });
    mockGenerate.mockResolvedValue({ text: JSON.stringify(visual), usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, providerMetadata: { gateway: { cost: '0.001', generationId: 'gen_test' } } });
  });
  afterEach(() => { globalThis.fetch = originalFetch; if (originalR2 === undefined) delete process.env.R2_PUBLIC_URL; else process.env.R2_PUBLIC_URL = originalR2; });
  test('silent visual evidence updates metadata with private evidence and measured usage', async () => {
    expect(await processNextSearchVideo()).toEqual({ status: 'ready', post_id: 'post' });
    expect(mockGenerate.mock.calls[0][0]).toMatchObject({ model: 'google/gemini-3.6-flash', maxRetries: 0 });
    expect(mockGenerate.mock.calls[0][0].messages[0].content[1]).toEqual({ type: 'file', data: new URL(source), mediaType: 'video/mp4' });
    expect(mockRpc.mock.calls[1]).toEqual(['finish_post_classification_v1', expect.objectContaining({
      fingerprint: 'fingerprint', spoken_text: '', visible_text: '', visual_text: 'A barbell is lifted.',
      categories: ['health & fitness'], topics: ['strength training'], labels: expect.any(Array),
      usage_receipt: expect.objectContaining({ gateway_cost_usd: 0.001, total_tokens: 150, generation_id: 'gen_test' }),
    })]);
  });
  test('unmarked existing posts retain extraction-only behavior and RPC', async () => {
    mockRpc.mockReset().mockResolvedValueOnce({ data: { ...job, classification_version: null }, error: null }).mockResolvedValueOnce({ data: true, error: null });
    mockGenerate.mockResolvedValue({ text: '{"transcript":"Existing speech","screen_text":"Text"}' });
    expect((await processNextSearchVideo()).status).toBe('ready');
    expect(mockRpc.mock.calls[1][0]).toBe('finish_search_video_v1');
    expect(mockRpc.mock.calls[1][1]).not.toHaveProperty('categories');
    expect(mockGenerate.mock.calls[0][0].system).not.toContain('visual_summary');
  });
  test('generic promotion requires substantive subject support and preserves caption metadata with no video labels', async () => {
    const promotion = 'If you want to leave your 9-5, message me';
    mockRpc.mockReset().mockResolvedValueOnce({ data: { ...job,
      classification_context: { content: '#ecommerce #dropshipping', bio: 'Learn programming' },
    }, error: null }).mockResolvedValueOnce({ data: true, error: null });
    mockGenerate.mockResolvedValue({ text: JSON.stringify({ transcript: '', screen_text: promotion,
      visual_summary: 'Nighttime building, elevator and apartment scenes.', labels: [] }) });
    expect((await processNextSearchVideo()).status).toBe('ready');
    const request = mockGenerate.mock.calls[0][0];
    expect(request.system).toContain('Each category and each topic must describe a substantive subject');
    expect(request.system).toContain('"leave your 9-5"');
    expect(request.system).toContain('return labels: [] when those are the only signals');
    expect(mockRpc.mock.calls[1][1]).toMatchObject({
      visible_text: promotion, visual_text: 'Nighttime building, elevator and apartment scenes.', labels: [],
      categories: ['business & entrepreneurship'], topics: ['ecommerce', 'dropshipping'], metadata_source: 'text',
    });
  });
  test('supported business and content subjects within a promotional video survive enrichment', async () => {
    const business = 'Online stores need products that customers want.';
    const content = 'Posting content helps you understand engagement.';
    mockGenerate.mockResolvedValue({ text: JSON.stringify({ transcript: `${business} ${content} Message me.`,
      screen_text: 'Dropshipping', visual_summary: 'A person speaks in a kitchen.', labels: [
        { category: 'business & entrepreneurship', topics: ['dropshipping', 'ecommerce'], evidence: [
          { kind: 'speech', text: business }, { kind: 'screen_text', text: 'Dropshipping' },
        ] },
        { category: 'content creation & marketing', topics: ['content creation', 'social media growth'],
          evidence: [{ kind: 'speech', text: content }] },
      ] }) });
    await processNextSearchVideo();
    expect(mockRpc.mock.calls[1][1]).toMatchObject({
      categories: ['business & entrepreneurship', 'content creation & marketing'],
      topics: ['dropshipping', 'ecommerce', 'content creation', 'social media growth'], metadata_source: 'text_and_video',
    });
  });
  test('concrete career guidance remains eligible instead of excluding the category', async () => {
    const speech = 'For your interview, explain a concrete example of how you solved a problem.';
    mockGenerate.mockResolvedValue({ text: JSON.stringify({ transcript: speech, screen_text: '',
      visual_summary: '', labels: [{ category: 'education & career skills', topics: ['career skills'],
        evidence: [{ kind: 'speech', text: speech }] }] }) });
    await processNextSearchVideo();
    expect(mockRpc.mock.calls[1][1]).toMatchObject({
      categories: ['education & career skills'], topics: ['career skills'], metadata_source: 'text_and_video',
    });
  });
  test('precision guidance preserves independent audio and visual subjects', async () => {
    const speech = 'Use a Python loop to automate this task.';
    mockGenerate.mockResolvedValue({ text: JSON.stringify({ ...visual, transcript: speech, labels: [
      ...visual.labels,
      { category: 'technology & ai', topics: ['programming', 'automation'], evidence: [{ kind: 'speech', text: speech }] },
    ] }) });
    await processNextSearchVideo();
    const request = mockGenerate.mock.calls[0][0];
    expect(request.system).toContain('Analyze audio and visuals independently');
    expect(request.messages[0].content[0].text).toContain('Listen to the full audio track');
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ spoken_text: speech,
      categories: ['health & fitness', 'technology & ai'], topics: ['strength training', 'programming', 'automation'],
    });
  });
  test('invalid model output fails without replacing the available post metadata', async () => {
    mockGenerate.mockResolvedValue({ text: '{"labels":"invalid"}' });
    expect((await processNextSearchVideo()).status).toBe('retry_pending');
    expect(mockRpc.mock.calls[1][1].failure_code).toBe('invalid_extraction');
  });
  test('stale database acceptance returns superseded', async () => {
    mockRpc.mockReset().mockResolvedValueOnce({ data: job, error: null }).mockResolvedValueOnce({ data: false, error: null });
    expect((await processNextSearchVideo()).status).toBe('superseded');
  });
  test('provider failure stores only its diagnostic code and leaves the post published', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGenerate.mockRejectedValue(Object.assign(new Error('secret-token provider rejected'), { statusCode: 403 }));
    expect((await processNextSearchVideo()).status).toBe('retry_pending');
    expect(mockRpc.mock.calls[1][1].failure_code).toBe('provider_access_denied');
    expect(JSON.stringify(mockRpc.mock.calls[1])).not.toContain('secret-token');
    warning.mockRestore();
  });
  test.each([
    { source_url: 'https://db.example.invalid/storage/v1/object/sign/premium/a.mp4' },
    { duration_seconds: 601 },
  ])('private sources and long videos never call a provider', async override => {
    mockRpc.mockReset().mockResolvedValueOnce({ data: { ...job, ...override }, error: null }).mockResolvedValueOnce({ data: true, error: null });
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await processNextSearchVideo(); expect(mockGenerate).not.toHaveBeenCalled(); warning.mockRestore();
  });
});
