const exchange=jest.fn(),updates:Record<string,unknown>[]=[];let stored:Record<string,any>;
jest.mock('server-only',()=>({}));
jest.mock('@/lib/schedulingConfig',()=>({googleCalendarConfig:()=>({clientId:'client',clientSecret:'secret'}),schedulingOrigin:()=> 'https://creatornet.example'}));
jest.mock('@/lib/schedulingSecrets',()=>({openSchedulingSecret:(value:string)=>value,sealSchedulingSecret:(value:string)=>value}));
jest.mock('@/lib/googleCalendarProvider',()=>({exchangeGoogleCalendarToken:(...args:unknown[])=>exchange(...args),GoogleCalendarError:class extends Error{status:number;constructor(status:number){super('google error');this.status=status;}get requiresReconnect(){return this.status===401;}}}));
jest.mock('@/lib/supabaseAdmin',()=>({supabaseAdmin:{from:()=>{
 let values:Record<string,unknown>={};let selection='';
 const execute=()=>{updates.push(values);Object.assign(stored,values);return {data:selection==='*'?{...stored}:{id:stored.id},error:null};};
 const query:any={update:(value:Record<string,unknown>)=>{values=value;return query;},select:(value:string)=>{selection=value;return query;},maybeSingle:async()=>execute(),then:(resolve:any)=>Promise.resolve(execute()).then(resolve)};
 for(const key of ['eq','gt','or'])query[key]=()=>query;return query;
}}}));
import {refreshRejectedGoogleAccessToken} from '@/lib/googleCalendarConnection';
import {GoogleCalendarError} from '@/lib/googleCalendarProvider';
beforeEach(()=>{updates.length=0;exchange.mockReset();stored={id:'connection',creator_id:'creator',status:'connected',credentials_ciphertext:JSON.stringify({accessToken:'old',refreshToken:'refresh',expiresAt:Date.now()+3600000})};exchange.mockResolvedValue({accessToken:'fresh',refreshToken:'refresh',expiresAt:Date.now()+3600000});});
test('a rejected unexpired access token is refreshed promptly under the connection lease',async()=>{await refreshRejectedGoogleAccessToken('connection','old');expect(exchange).toHaveBeenCalledWith(expect.anything(),{refreshToken:'refresh'});expect(JSON.parse(stored.credentials_ciphertext).accessToken).toBe('fresh');expect(stored.status).toBe('connected');});
test('a late failure for replaced credentials does not refresh or invalidate the new connection',async()=>{await refreshRejectedGoogleAccessToken('connection','older');expect(exchange).not.toHaveBeenCalled();expect(stored.status).toBe('connected');expect(updates.some(value=>value.credentials_ciphertext)).toBe(false);});
test('a revoked grant becomes reconnect required while transient failures leave it connected',async()=>{exchange.mockRejectedValueOnce(new (GoogleCalendarError as any)(400));await expect(refreshRejectedGoogleAccessToken('connection','old')).rejects.toThrow();expect(stored.status).toBe('reconnect_required');stored.status='connected';exchange.mockRejectedValueOnce(new (GoogleCalendarError as any)(503));await expect(refreshRejectedGoogleAccessToken('connection','old')).rejects.toThrow();expect(stored.status).toBe('connected');});
