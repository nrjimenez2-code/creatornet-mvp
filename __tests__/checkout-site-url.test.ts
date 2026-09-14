import {getCheckoutSiteUrl} from '@/lib/checkoutSiteUrl';
const original={...process.env};
beforeEach(()=>{delete process.env.SCHEDULING_OAUTH_ORIGIN;delete process.env.VERCEL_BRANCH_URL;delete process.env.VERCEL_URL;process.env.NEXT_PUBLIC_SITE_URL='https://production.example';});
afterEach(()=>{process.env={...original};});
test('preview transactions use their fixed origin while production keeps its canonical domain',()=>{
 process.env.VERCEL_ENV='preview';process.env.SCHEDULING_OAUTH_ORIGIN='https://staging.example';
 expect(getCheckoutSiteUrl()).toBe('https://staging.example');
 process.env.VERCEL_ENV='production';expect(getCheckoutSiteUrl()).toBe('https://production.example');
});
test('preview can use the deployment branch host without falling back to production',()=>{
 process.env.VERCEL_ENV='preview';process.env.VERCEL_BRANCH_URL='branch.vercel.app';
 expect(getCheckoutSiteUrl()).toBe('https://branch.vercel.app');
 delete process.env.VERCEL_BRANCH_URL;expect(()=>getCheckoutSiteUrl()).toThrow();
});
test.each(['http://staging.example','https://user:secret@staging.example','https://staging.example/path','https://staging.example?query=1','https://staging.example#fragment'])('invalid preview origin fails closed: %s',raw=>{
 process.env.VERCEL_ENV='preview';process.env.SCHEDULING_OAUTH_ORIGIN=raw;expect(()=>getCheckoutSiteUrl()).toThrow();
});
