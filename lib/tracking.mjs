import { pairPlanLinks } from './plan-matching.mjs';

/** Precise actual-time records are independent of the editable 30-minute plan. */
export const MAX_TRACKING_SESSIONS = 10000;
const trackingIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const trackingFormatters = new Map();
const trackingIsObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const trackingIsId = value => typeof value === 'string' && trackingIdPattern.test(value);
const trackingIsInstant = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402214400000;
function trackingIsDate(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10)===value;
}
function trackingIsReference(value) {
  return trackingIsObject(value) && trackingIsId(value.id) && trackingIsDate(value.planDate)
    && trackingIsId(value.blockId) && trackingIsId(value.category)
    && (value.tagId===undefined || trackingIsId(value.tagId))
    && (value.unplanned===undefined || typeof value.unplanned==='boolean')
    && (value.planBinding===undefined || value.planBinding==='explicit')
    && typeof value.title==='string' && value.title.trim().length>0 && value.title.length<=160;
}
/** Old V3 backups omit tracking; deleted plan entries/groups may retain actual records. */
export function validateTracking(value) {
  if(value===undefined)return true;
  if(!trackingIsObject(value) || !Array.isArray(value.sessions) || value.sessions.length>MAX_TRACKING_SESSIONS)return false;
  if(!value.sessions.every(session=>trackingIsReference(session) && trackingIsInstant(session.startedAt)
    && trackingIsInstant(session.endedAt) && session.endedAt>session.startedAt))return false;
  if(new Set(value.sessions.map(session=>session.id)).size!==value.sessions.length)return false;
  const ordered=[...value.sessions].sort((a,b)=>a.startedAt-b.startedAt);
  if(ordered.some((session,index)=>index>0&&session.startedAt<ordered[index-1].endedAt))return false;
  const timer=value.timer;
  if(timer===null)return true;
  return trackingIsReference(timer) && (timer.startedAt===null || (trackingIsInstant(timer.startedAt)
    && (!ordered.length || timer.startedAt>=ordered.at(-1).endedAt)));
}
function trackingAssert(condition,message) { if(!condition)throw new Error(message); }
function trackingCheckNow(now) { trackingAssert(trackingIsInstant(now),'计时时间无效。'); }
function trackingLatestEnd(tracking) { return Math.max(0,...tracking.sessions.map(session=>session.endedAt)); }
function trackingTagId(data,item) {
  if(item?.tagId!==undefined)return item.tagId;
  const block=!item?.unplanned&&item?.planDate&&data.days?.[item.planDate]?.find(block=>block.id===item.blockId);
  if(block?.tagId!==undefined)return block.tagId;
  const tags=data.tags||data.groups||[];
  return tags.some(tag=>tag.id===item?.category)?item.category:tags[0]?.id||item?.category;
}
function trackingFlush(data,now,sessionId) {
  const tracking=data.tracking,timer=tracking?.timer;
  trackingAssert(timer,'当前没有正在计时的任务。');
  trackingCheckNow(now);
  if(timer.startedAt===null)return null;
  trackingAssert(now>=timer.startedAt,'结束时间不能早于开始时间，请检查系统时间。');
  if(now===timer.startedAt)return null;
  const session={id:sessionId,planDate:timer.planDate,blockId:timer.blockId,title:timer.title,
    category:timer.category,tagId:trackingTagId(data,timer),startedAt:timer.startedAt,endedAt:now};
  if(timer.unplanned)session.unplanned=true;
  if(timer.planBinding!==undefined)session.planBinding=timer.planBinding;
  trackingAssert(validateTracking({sessions:[...tracking.sessions,session],timer:null}),'执行记录无效、时间重叠或记录数量已达上限。');
  tracking.sessions.push(session);
  return session;
}
/** Only one timer may run (or remain paused) at a time. No planned-time snapshot is stored. */
export function startTracking(data,planDate,block,now,id) {
  trackingCheckNow(now);
  trackingAssert(!data.tracking?.timer,'请先结束当前任务的计时。');
  trackingAssert(block?.kind!=='tag-slot','请先为标签时段选择任务。');
  const timer={id,planDate,blockId:block?.id,title:block?.title,category:block?.category,tagId:trackingTagId(data,block),startedAt:now};
  if(block?.unplanned)timer.unplanned=true;
  else timer.planBinding='explicit';
  const next={sessions:data.tracking?.sessions||[],timer};
  trackingAssert(validateTracking(next),'无法开始计时，请检查任务和时间。');
  data.tracking=next;
  return timer;
}
export function pauseTracking(data,now,sessionId) {
  trackingAssert(data.tracking?.timer?.startedAt!==null,'计时已经暂停。');
  const session=trackingFlush(data,now,sessionId);
  data.tracking.timer.startedAt=null;
  return session;
}
export function resumeTracking(data,now) {
  const timer=data.tracking?.timer;
  trackingAssert(timer,'当前没有暂停的计时。');
  trackingAssert(timer.startedAt===null,'计时已经在进行中。');
  trackingCheckNow(now);
  trackingAssert(now>=trackingLatestEnd(data.tracking),'继续时间不能早于已有记录，请检查系统时间。');
  timer.startedAt=now;
  return timer;
}
export function stopTracking(data,now,sessionId) {
  const session=trackingFlush(data,now,sessionId);
  data.tracking.timer=null;
  return session;
}
function trackingMinutes(session,now) {
  return session.startedAt===null?0:Math.max(0,(session.endedAt??now)-session.startedAt)/60000;
}
/** Derive one owner per record without changing stored references or precise timestamps. */
export function trackingRecordAssignments(blocks,sessions=[],timer=null,planDate,now=Date.now(),timezone='Asia/Shanghai') {
  const tasks=blocks.filter(block=>block.kind!=='tag-slot');
  const blockMap=new Map(tasks.map(block=>[block.id,block])),owners=new Map();
  const plans=tasks.map(block=>{
    let startAt=NaN;
    try{
      const date=new Date(planDate+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+Math.floor(block.start/1440));
      startAt=parseTimeInput(date.toISOString().slice(0,10)+'T'+String(Math.floor(block.start%1440/60)).padStart(2,'0')+':'+String(block.start%60).padStart(2,'0')+':00',timezone);
    }catch{}
    return {role:'plan',planDate,blockId:block.id,title:block.title,category:block.category,taskId:block.taskId,startAt};
  });
  const records=sessions.filter(record=>record.planDate===planDate).map(record=>({record,key:'session:'+record.id}));
  if(timer?.planDate===planDate)records.push({record:timer,key:'timer:'+timer.id});
  const actuals=[];
  for(const {record,key} of records){
    const block=blockMap.get(record.blockId);
    if(record.unplanned||!block)continue;
    // Extra pause/resume records stay assigned to their original plan; a nearest
    // representative below replaces this owner rather than adding a second one.
    owners.set(key,block.id);
    if(record.startedAt===null)continue;
    actuals.push({role:'actual',planDate,blockId:record.blockId,title:block.title,category:block.category,taskId:block.taskId,
      startAt:record.startedAt,recordId:key,hasOrigin:true,binding:record.planBinding});
  }
  for(const group of pairPlanLinks([...plans,...actuals]).groups)for(const actual of group.actuals)owners.set(actual.recordId,group.plan.blockId);
  return owners;
}

/** Group preferences affect completion counts only; all precise elapsed time remains visible. */
export function summarizeTracking(blocks,sessions=[],timer=null,planDate,now=Date.now(),groups=[],tags=[],timezone='Asia/Shanghai') {
  const records=sessions.filter(record=>record.planDate===planDate).map(record=>({record,key:'session:'+record.id}));
  if(timer?.planDate===planDate && timer.startedAt!==null)records.push({record:timer,key:'timer:'+timer.id});
  const minutesByBlock=new Map();
  const owners=trackingRecordAssignments(blocks,sessions,timer,planDate,now,timezone);
  let actualMinutes=0;
  for(const {record,key} of records){
    const minutes=trackingMinutes(record,now);
    actualMinutes+=minutes;
    const blockId=owners.get(key);
    if(blockId)minutesByBlock.set(blockId,(minutesByBlock.get(blockId)||0)+minutes);
  }
  const excludedGroups=new Set(groups.filter(group=>group.countTowardsCompletion===false).map(group=>group.id));
  const excludedTags=new Set(tags.filter(tag=>tag.countTowardsCompletion===false).map(tag=>tag.id));
  const items=blocks.filter(block=>block.kind!=='tag-slot').map(block=>{
    const actualMinutes=minutesByBlock.get(block.id)||0;
    const coveredMinutes=Math.min(block.duration,actualMinutes),deficitMinutes=block.duration-coveredMinutes;
    return {block,actualMinutes,deficitMinutes,deficitRate:block.duration>0?deficitMinutes/block.duration:null,
      coveredMinutes,coverageRate:block.duration>0?coveredMinutes/block.duration:null,
      countsTowardsCompletion:!excludedGroups.has(block.category)&&!excludedTags.has(trackingTagId({tags},block))};
  });
  const plannedMinutes=items.reduce((sum,item)=>sum+item.block.duration,0);
  const coveredMinutes=items.reduce((sum,item)=>sum+item.coveredMinutes,0);
  const deficitMinutes=plannedMinutes-coveredMinutes;
  const countedItems=items.filter(item=>item.countsTowardsCompletion);
  const count=countedItems.length,done=countedItems.filter(item=>item.block.done).length,excludedCount=items.length-count;
  return {plannedMinutes,actualMinutes,deficitMinutes,deficitRate:plannedMinutes?deficitMinutes/plannedMinutes:null,
    coveredMinutes,coverageRate:plannedMinutes?coveredMinutes/plannedMinutes:null,
    completionRate:count?done/count:null,count,done,excludedCount,items};
}
function trackingFields(timestamp,timezone) {
  let formatter=trackingFormatters.get(timezone);
  if(!formatter){
    formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    trackingFormatters.set(timezone,formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part=>[part.type,part.value]));
}
function trackingFieldString(fields) { return fields.year+'-'+fields.month+'-'+fields.day+'T'+fields.hour+':'+fields.minute+':'+fields.second; }
export function timeInputValue(timestamp,timezone='Asia/Shanghai') {
  trackingCheckNow(timestamp);
  return trackingFieldString(trackingFields(timestamp,timezone));
}
function trackingOffset(timestamp,timezone) {
  const fields=trackingFields(timestamp,timezone);
  return Date.parse(trackingFieldString(fields)+'Z')-Math.floor(timestamp/1000)*1000;
}
/** Reject nonexistent local clock times. An ambiguous repeated time uses its earlier occurrence. */
export function parseTimeInput(value,timezone='Asia/Shanghai') {
  trackingAssert(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value),'请输入有效的日期和时间。');
  const normalized=value.length===16?value+':00':value;
  const wall=Date.parse(normalized+'Z');
  trackingAssert(Number.isFinite(wall) && new Date(wall).toISOString().slice(0,19)===normalized,'日期或时间不正确。');
  // Nearby offsets cover either side of DST changes without trusting the host timezone.
  const offsets=new Set([-2,-1,0,1,2].map(day=>trackingOffset(wall+day*86400000,timezone)));
  const candidates=[...offsets].map(offset=>wall-offset).filter(instant=>trackingIsInstant(instant)
    && timeInputValue(instant,timezone)===normalized).sort((a,b)=>a-b);
  trackingAssert(candidates.length,'该时区不存在这个时间，请选择其他时间。');
  return candidates[0];
}
function trackingNextDate(date) {
  const next=new Date(date+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);
  return next.toISOString().slice(0,10);
}
function trackingWallMinute(timestamp,date,timezone) {
  const fields=trackingFields(timestamp,timezone);
  const day=fields.year+'-'+fields.month+'-'+fields.day;
  const offset=(Date.parse(day+'T00:00:00Z')-Date.parse(date+'T00:00:00Z'))/86400000;
  return offset*1440+Number(fields.hour)*60+Number(fields.minute)+Number(fields.second)/60+(timestamp%1000)/60000;
}
function trackingTransitions(start,end,timezone) {
  const changes=[];
  let cursor=start,offset=trackingOffset(start,timezone);
  while(cursor<end){
    const next=Math.min(end,cursor+3600000),nextOffset=trackingOffset(next,timezone);
    if(nextOffset!==offset){
      let low=cursor,high=next;
      while(high-low>1){const middle=Math.floor((low+high)/2);if(trackingOffset(middle,timezone)===offset)low=middle;else high=middle;}
      if(high>start&&high<end)changes.push(high);
    }
    cursor=next;offset=nextOffset;
  }
  return changes;
}
/** Round display endpoints to the nearest half hour; a 15-minute tie rounds up. */
export function actualSegments(data,date,now=Date.now()) {
  trackingAssert(trackingIsDate(date),'日期不正确。');
  const timezone=data.timezone||'Asia/Shanghai';
  const startOfDay=parseTimeInput(date+'T04:00:00',timezone),endOfDay=parseTimeInput(trackingNextDate(date)+'T04:00:00',timezone);
  const records=(data.tracking?.sessions||[]).map(session=>({...session,live:false}));
  const timer=data.tracking?.timer;
  if(timer && timer.startedAt!==null && now>timer.startedAt)records.push({...timer,endedAt:now,live:true});
  if(!records.some(record=>record.startedAt<endOfDay&&record.endedAt>startOfDay))return [];
  const transitions=trackingTransitions(startOfDay,endOfDay,timezone),result=[];
  for(const record of records){
    const clippedStart=Math.max(startOfDay,record.startedAt),clippedEnd=Math.min(endOfDay,record.endedAt);
    if(clippedStart>=clippedEnd)continue;
    const cuts=[clippedStart,...transitions.filter(instant=>instant>clippedStart&&instant<clippedEnd),clippedEnd];
    for(let i=0;i<cuts.length-1;i++){
      const exactStart=cuts[i],exactEnd=cuts[i+1];
      const rawStart=trackingWallMinute(exactStart,date,timezone);
      // At a DST transition, the end belongs to the clock immediately before the change.
      const rawEnd=trackingWallMinute(exactEnd-1,date,timezone)+1/60000;
      // The epsilon only absorbs floating-point noise at exact 15-minute ties.
      const start=Math.max(240,Math.min(1680,Math.floor((rawStart+15+1e-8)/30)*30));
      const end=Math.max(240,Math.min(1680,Math.floor((rawEnd+15+1e-8)/30)*30));
      if(end<start)continue;
      // Equal display endpoints remain a clickable point; do not invent elapsed time.
      result.push({id:record.id,planDate:record.planDate,blockId:record.blockId,title:record.title,category:record.category,tagId:trackingTagId(data,record),
        start,duration:end-start,exactStart,exactEnd,live:record.live,...(record.unplanned?{unplanned:true}:{}),...(record.planBinding?{planBinding:record.planBinding}:{})});
    }
  }
  return result.sort((a,b)=>a.start-b.start||a.exactStart-b.exactStart||a.id.localeCompare(b.id));
}
