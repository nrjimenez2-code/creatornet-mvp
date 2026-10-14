import { pathToFileURL } from 'node:url';
import { checkPreview, checkMaintenancePreview } from './preview-credential-check.mjs';

// Sanitized observability for either reviewed profile; identity checks remain in the validator.
const envStages = Object.freeze({VERCEL_ENV:'deployment_environment',NEXT_PUBLIC_SUPABASE_URL:'database_url',
  STRIPE_SECRET_KEY:'secret_key_mode',NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:'publishable_key_mode',
  SUPABASE_SERVICE_ROLE_KEY:'database_key_presence'});
const urls = Object.freeze({
  'https://api.stripe.com/v1/account':'stripe_account',
  'https://api.stripe.com/v1/balance':'stripe_mode',
  'https://nwqfofezfzljhxolkycz.supabase.co/rest/v1/rpc/read_exact_installment_context_pin_v2':'database_pin',
});
export async function diagnosePreview(env, fetcher=fetch) {
  return diagnose(env, fetcher, checkPreview);
}
export async function diagnoseMaintenancePreview(env, fetcher=fetch) {
  return diagnose(env, fetcher, checkMaintenancePreview);
}
async function diagnose(env, fetcher, validator) {
  let stage='configuration', httpStatus=null, networkStarted=false, enumeratingGates=false;
  const inspectedEnv=new Proxy(env, {
    get(target,key) {
      if (!networkStarted && !enumeratingGates) stage=envStages[key] ?? 'readiness_gates';
      return Reflect.get(target,key);
    },
    ownKeys(target) {enumeratingGates=true;stage='readiness_gates';return Reflect.ownKeys(target);},
  });
  const inspectedFetch=async (url,options)=>{
    networkStarted=true;
    const label=urls[url];
    if (!label || options.method!=='GET' || options.redirect!=='error') {
      stage='request_boundary';throw Error('Rejected');
    }
    stage=label+'_transport';httpStatus=null;
    const response=await fetcher(url,options);
    stage=label+'_response';
    httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
    return {ok:response.ok,status:response.status,headers:response.headers,
      async json(){stage=label+'_json';const body=await response.json();stage=label+'_check';return body;}};
  };
  try {
    const proof=await validator(inspectedEnv,inspectedFetch);
    return {status:'passed',proof};
  } catch {
    // Never forward exception text, environment values, URLs, headers or response bodies.
    return {status:'failed',stage,httpStatus};
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const diagnoseProfile=process.argv.includes('--maintenance')?diagnoseMaintenancePreview:diagnosePreview;
  const result=await diagnoseProfile(process.env);
  console.log(JSON.stringify(result));
  if(result.status!=='passed')process.exitCode=1;
}
