import {createHash,timingSafeEqual} from 'node:crypto';
export function authorizedSchedulingCron(req:Request){
 const secret=process.env.CRON_SECRET;
 if(!secret||secret.length<32)return false;
 const hash=(value:string)=>createHash('sha256').update(value).digest();
 return timingSafeEqual(hash(req.headers.get('authorization')??''),hash(`Bearer ${secret}`));
}
