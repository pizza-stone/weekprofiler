import { validateData } from '../lib/planner.mjs';
import { applyChanges, validateChanges, isTimerChange, SyncConflictError } from '../lib/sync.mjs';

// A D1 row has a 2 MB ceiling, including columns. Keep deliberate headroom.
export const MAX_SYNC_STATE_BYTES = 1_900_000;
const MAX_SYNC_REQUEST_BYTES = MAX_SYNC_STATE_BYTES*2+262144;
const syncApiOwn = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function syncJson(value,status=200) { return Response.json(value,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}}); }
function syncRevision(value) { return Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER-1; }
async function syncBody(request) {
  if(Number(request.headers.get('content-length'))>MAX_SYNC_REQUEST_BYTES)throw new RangeError();
  const reader=request.body?.getReader();if(!reader)throw new TypeError();
  const chunks=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>MAX_SYNC_REQUEST_BYTES){await reader.cancel();throw new RangeError();}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
function syncCanonical(value) {
  if(Array.isArray(value))return '['+value.map(syncCanonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+syncCanonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
async function syncHash(input) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(syncCanonical(input))))].map(byte=>byte.toString(16).padStart(2,'0')).join(''); }
async function syncRead(env,userId) {
  const row=await env.DB.prepare('SELECT data, revision, timer_revision FROM planner_states WHERE user_id = ?').bind(userId).first();
  return row?{data:JSON.parse(row.data),revision:row.revision,timerRevision:row.timer_revision}:{data:null,revision:0,timerRevision:0};
}
async function syncAcknowledged(env,userId,mutationId,hash) {
  const ack=await env.DB.prepare('SELECT request_hash, revision FROM planner_mutations WHERE user_id = ? AND mutation_id = ?').bind(userId,mutationId).first();
  if(!ack)return null;
  if(ack.request_hash!==hash)return syncJson({error:'这个操作编号已经用于其他修改，请重新同步。',code:'MUTATION_ID_REUSED'},409);
  return syncJson({...await syncRead(env,userId),ackMutationId:mutationId,appliedRevision:ack.revision,serverNow:Date.now()});
}
function syncConflict(current,paths,message) { return syncJson({...current,paths,conflicts:paths,error:message||'另一台设备修改了同一内容，本机修改仍保留。',serverNow:Date.now()},409); }
function syncFutureChanges(before,after,serverNow) {
  const future=serverNow+5*60*1000,paths=[];
  const oldSessions=new Map((before?.tracking?.sessions||[]).map(session=>[session.id,session]));
  for(const session of after.tracking?.sessions||[]){
    const old=oldSessions.get(session.id);
    if(['startedAt','endedAt'].some(key=>session[key]>future&&session[key]!==old?.[key]))paths.push(['tracking','sessions',{id:session.id}]);
  }
  const timer=after.tracking?.timer,oldTimer=before?.tracking?.timer;
  if(timer?.startedAt>future&&(timer.id!==oldTimer?.id||timer.startedAt!==oldTimer?.startedAt))paths.push(['tracking','timer']);
  return paths;
}

/** Identity must come from verified Access authentication, never the request body. */
export async function handleSync(request,env,userId) {
  if(!userId)return syncJson({error:'请先登录后同步日程。'},401);
  if(!['GET','POST'].includes(request.method))return syncJson({error:'不支持的请求方式。'},405);
  if(!env.DB)return syncJson({error:'云端存储暂不可用，已保留本机修改。'},503);
  if(request.method==='GET'){
    try{
      const revision=new URL(request.url).searchParams.get('revision');
      if(revision!==null&&/^\d+$/.test(revision)){
        // The usual five-second poll reads only version columns: do not parse
        // years of historical records merely to discover that nothing changed.
        const row=await env.DB.prepare('SELECT revision, timer_revision FROM planner_states WHERE user_id = ?').bind(userId).first();
        if(Number(revision)===(row?.revision??0))return syncJson({unchanged:true,revision:row?.revision??0,timerRevision:row?.timer_revision??0,serverNow:Date.now()});
      }
      const current=await syncRead(env,userId);
      return syncJson({...current,serverNow:Date.now()});
    }catch{return syncJson({error:'暂时无法读取云端数据，请稍后重试。'},503);}
  }
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return syncJson({error:'仅接受 JSON 数据。'},415);
  const origin=request.headers.get('origin');
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')return syncJson({error:'请求来源不正确。'},403);
  let input;
  try{input=await syncBody(request);}catch(error){return syncJson({error:'同步请求过大或格式不正确。'},error instanceof RangeError?413:400);}
  if(!input||typeof input!=='object'||Array.isArray(input)||!syncRevision(input.baseRevision)
    ||typeof input.mutationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.mutationId)
    ||Object.keys(input).some(key=>!['mutationId','baseRevision','baseTimerRevision','changes','replace','data'].includes(key)))return syncJson({error:'同步请求格式不正确。'},400);
  const replacing=input.replace===true;
  if((syncApiOwn(input,'replace')&&!replacing)||(replacing?(syncApiOwn(input,'changes')||!validateData(input.data)):(syncApiOwn(input,'data')||!validateChanges(input.changes))))return syncJson({error:'请检查同步内容、任务时间和实际记录。'},400);
  const timerChanged=replacing||input.changes.some(isTimerChange);
  if((timerChanged&&!syncRevision(input.baseTimerRevision))||(syncApiOwn(input,'baseTimerRevision')&&!syncRevision(input.baseTimerRevision)))return syncJson({error:'缺少有效的计时器版本，请重新连接后同步。'},400);
  try{
    const hash=await syncHash(input);
    for(let attempt=0;attempt<5;attempt++){
      const acknowledged=await syncAcknowledged(env,userId,input.mutationId,hash);if(acknowledged)return acknowledged;
      const current=await syncRead(env,userId);
      if(input.baseRevision>current.revision)return syncConflict(current,[[]],'云端版本发生变化，请先核对本机内容。');
      if(replacing&&input.baseRevision!==current.revision)return syncConflict(current,[[]],'云端已有更新，恢复备份前请先核对。');
      if(timerChanged&&input.baseTimerRevision!==current.timerRevision)return syncConflict(current,[['tracking','timer']],'另一台设备已操作计时器，请核对本机记录后再继续。');
      if(!replacing&&!current.data)return syncConflict(current,[[]],'云端尚未初始化，请先上传初始数据。');
      let data;
      try{data=replacing?input.data:applyChanges(current.data,input.changes);}catch(error){
        if(error instanceof SyncConflictError)return syncConflict(current,error.paths,error.message);
        return syncJson({error:'同步修改格式不正确。'},400);
      }
      if(!validateData(data))return syncConflict(current,[['validation']],'合并后的安排或实际记录发生重叠，请核对后重试。');
      const futurePaths=syncFutureChanges(current.data,data,Date.now());
      if(futurePaths.length)return syncConflict(current,futurePaths,'设备时间可能不正确：实际记录超过服务器时间 5 分钟，请校准时间并核对记录。');
      const serialized=JSON.stringify(data);
      if(new TextEncoder().encode(serialized).length>MAX_SYNC_STATE_BYTES)return syncJson({error:'云端单份数据接近容量上限，请先导出并整理历史记录。',code:'STATE_TOO_LARGE'},413);
      const revision=current.revision+1,timerRevision=current.timerRevision+(timerChanged?1:0);
      const write=current.revision===0
        ?env.DB.prepare('INSERT INTO planner_states (user_id, data, revision, mutation_id, timer_revision) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM planner_mutations WHERE user_id = ? AND mutation_id = ?) ON CONFLICT(user_id) DO NOTHING').bind(userId,serialized,revision,input.mutationId,timerRevision,userId,input.mutationId)
        :env.DB.prepare('UPDATE planner_states SET data = ?, revision = ?, mutation_id = ?, timer_revision = ? WHERE user_id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM planner_mutations WHERE user_id = ? AND mutation_id = ?)').bind(serialized,revision,input.mutationId,timerRevision,userId,current.revision,userId,input.mutationId);
      const acknowledge=env.DB.prepare('INSERT INTO planner_mutations (user_id, mutation_id, request_hash, revision, created_at) SELECT ?, ?, ?, ?, ? FROM planner_states WHERE user_id = ? AND revision = ? AND mutation_id = ? ON CONFLICT(user_id, mutation_id) DO NOTHING').bind(userId,input.mutationId,hash,revision,Date.now(),userId,revision,input.mutationId);
      // D1 executes a batch transactionally. A failed acknowledgement rolls back
      // the state write; a losing CAS cannot create a false acknowledgement.
      await env.DB.batch([write,acknowledge]);
      const result=await syncAcknowledged(env,userId,input.mutationId,hash);if(result)return result;
    }
    return syncJson({error:'其他设备正在保存，请稍后重试。',code:'RETRY_SYNC'},503);
  }catch{return syncJson({error:'暂时无法同步，已保留本机修改，请稍后重试。'},503);}
}
