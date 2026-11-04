// Preserve provider deadlines. Only individual Node timers are split into
// bounded waits; a long Retry-After must never become an earlier network call.
export const MAX_TIMER_MS=2147483647;
const MAX_DATE_MS=8640000000000000;

export function retryDeadline(now,seconds,fallback=0){
 const delay=Number.isFinite(seconds)&&seconds>=0?seconds:fallback;
 return Math.min(MAX_DATE_MS,now+Math.max(0,delay)*1000);
}
export function retryAfterSeconds(value,now,fallback=120){
 const raw=typeof value==='string'?value.trim():'',numeric=raw?Number(raw):NaN;
 const seconds=Number.isFinite(numeric)&&numeric>0?numeric:raw?(Date.parse(raw)-now)/1000:NaN;
 return (retryDeadline(now,Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):fallback)-now)/1000;
}
export function retryTimerDelay(deadline,now){return Math.min(MAX_TIMER_MS,Math.max(50,deadline-now));}
