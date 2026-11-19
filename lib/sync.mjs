import { isTagSlot, materializeDay, upgradePlannerTagDefaults } from './planner.mjs';

/** Small, guarded edits shared by the browser and the cloud API. */
const syncOwn = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const syncObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const syncCopy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const syncForbidden = new Set(['__proto__','prototype','constructor']);
const syncRoots = new Set(['version','timezone','groups','tags','tagDefaultsVersion','tasks','templates','days','dayMeta','weekTemplates','cycle','tracking']);
const syncId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const MAX_SYNC_CHANGES = 20000;

export class SyncConflictError extends Error {
  constructor(paths,message='另一台设备修改了同一内容，请选择要保留的版本。') {
    super(message);this.name='SyncConflictError';this.paths=paths;
  }
}
export function syncEqual(a,b) {
  if(a===b)return true;
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>syncEqual(v,b[i]));
  if(syncObject(a)&&syncObject(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>syncOwn(b,k)&&syncEqual(a[k],b[k]));
  return false;
}
function syncNormalized(data) {
  const copy=syncCopy(data);
  if(syncObject(copy)&&copy.tracking===undefined)copy.tracking={sessions:[],timer:null};
  return copy;
}
function syncKeyed(values) { return Array.isArray(values)&&values.every(v=>syncObject(v)&&syncId(v.id))&&new Set(values.map(v=>v.id)).size===values.length; }
export function isTimerChange(change) { return change.path?.[0]==='tracking'&&(change.path.length===1||change.path[1]==='timer'); }
function syncAtomic(path) { return path.length===2&&path[0]==='tracking'&&path[1]==='timer'; }
function syncSafeJSON(value,depth=0) {
  if(depth>24)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.every(v=>syncSafeJSON(v,depth+1));
  return syncObject(value)&&Object.keys(value).every(k=>!syncForbidden.has(k)&&syncSafeJSON(value[k],depth+1));
}
export function validateChanges(changes) {
  return Array.isArray(changes)&&changes.length<=MAX_SYNC_CHANGES&&changes.every(change=>syncObject(change)
    &&Object.keys(change).every(key=>['path','before','after','materialize'].includes(key))
    &&Array.isArray(change.path)&&change.path.length>0&&change.path.length<=16&&syncRoots.has(change.path[0])
    &&change.path.every(part=>typeof part==='string'?!syncForbidden.has(part)&&part.length>0&&part.length<=160
      :syncObject(part)&&Object.keys(part).length===1&&syncId(part.id))
    &&(syncOwn(change,'before')||syncOwn(change,'after'))
    &&(!syncOwn(change,'before')||syncSafeJSON(change.before))&&(!syncOwn(change,'after')||syncSafeJSON(change.after))
    &&(!syncOwn(change,'materialize')||(change.path.length===2&&change.path[0]==='days'&&typeof change.path[1]==='string'
      &&/^\d{4}-\d{2}-\d{2}$/.test(change.path[1])&&syncKeyed(change.before)&&syncEqual(change.before,change.after)
      &&syncObject(change.materialize)&&syncSafeJSON(change.materialize))));
}
/** Arrays of records use ids; positional arrays (the seven weekdays) stay atomic. */
export function createChanges(base,next) {
  if(!syncObject(base)||!syncObject(next))throw new TypeError('初始化或恢复备份必须使用完整替换。');
  const changes=[],normalizedBase=syncNormalized(base),normalizedNext=syncNormalized(next);
  // Replay the default palette once, then diff the user's edits against that palette.
  if(Array.isArray(normalizedBase.tags) && normalizedBase.tagDefaultsVersion===undefined && normalizedNext.tagDefaultsVersion===1){
    changes.push({path:['tagDefaultsVersion'],after:1});
    upgradePlannerTagDefaults(normalizedBase);
  }
  // Two devices can both edit a virtual cycle occurrence for the first time.
  // Give that date a shared explicit baseline before generating field edits.
  for(const date of Object.keys(normalizedNext.days||{})){
    if(syncOwn(normalizedBase.days||{},date))continue;
    materializeDay(normalizedBase,date);
    changes.push({path:['days',date],before:syncCopy(normalizedBase.days[date]),after:syncCopy(normalizedBase.days[date]),materialize:syncCopy(normalizedBase.dayMeta[date])});
  }
  const visit=(before,after,path,hasBefore=true,hasAfter=true)=>{
    if(hasBefore===hasAfter&&syncEqual(before,after))return;
    // Changing the tag or filling a reservation must agree on the whole original slot.
    // Field-by-field merging could assign a task after a different device retagged it.
    if(hasBefore&&hasAfter&&!syncAtomic(path)&&!isTagSlot(before)&&!isTagSlot(after)){
      if(syncObject(before)&&syncObject(after)){
        for(const key of new Set([...Object.keys(before),...Object.keys(after)]))visit(before[key],after[key],[...path,key],syncOwn(before,key),syncOwn(after,key));
        return;
      }
      if(syncKeyed(before)&&syncKeyed(after)){
        const oldMap=new Map(before.map(v=>[v.id,v])),newMap=new Map(after.map(v=>[v.id,v]));
        const oldOrder=before.filter(v=>newMap.has(v.id)).map(v=>v.id),newOrder=after.filter(v=>oldMap.has(v.id)).map(v=>v.id);
        const firstAdded=after.findIndex(v=>!oldMap.has(v.id));
        const appendOnly=firstAdded<0||after.slice(firstAdded).every(v=>!oldMap.has(v.id));
        // Explicit reordering has meaning in task lists, so do not silently discard it.
        if(syncEqual(oldOrder,newOrder)&&appendOnly){
          for(const id of new Set([...oldMap.keys(),...newMap.keys()]))visit(oldMap.get(id),newMap.get(id),[...path,{id}],oldMap.has(id),newMap.has(id));
          return;
        }
      }
    }
    changes.push({path,...(hasBefore?{before:syncCopy(before)}:{}),...(hasAfter?{after:syncCopy(after)}:{})});
  };
  visit(normalizedBase,normalizedNext,[]);
  if(!validateChanges(changes))throw new TypeError('同步修改格式不正确或数量过多。');
  return changes;
}
function syncLocation(data,path) {
  let parent=data;
  for(const part of path.slice(0,-1)){
    if(typeof part==='string'){
      if(!syncObject(parent)||!syncOwn(parent,part))return null;
      parent=parent[part];
    }else{
      if(!Array.isArray(parent))return null;
      parent=parent.find(item=>syncObject(item)&&item.id===part.id);
      if(parent===undefined)return null;
    }
  }
  const last=path.at(-1);
  if(typeof last==='string')return syncObject(parent)?{parent,key:last,exists:syncOwn(parent,last),value:parent[last]}:null;
  if(!Array.isArray(parent))return null;
  const index=parent.findIndex(item=>syncObject(item)&&item.id===last.id);
  return {parent,key:index<0?parent.length:index,exists:index>=0,value:index<0?undefined:parent[index],id:last.id};
}
export function readChangeValue(data,path) {
  const location=syncLocation(syncNormalized(data),path);
  return location?.exists?{exists:true,value:syncCopy(location.value)}:{exists:false};
}
/** No input is mutated. A failed batch applies none of its edits. */
export function applyChanges(data,changes) {
  if(!validateChanges(changes))throw new TypeError('同步修改格式不正确。');
  const next=syncNormalized(data),conflicts=[];
  for(const change of changes){
    const location=syncLocation(next,change.path),hasBefore=syncOwn(change,'before'),hasAfter=syncOwn(change,'after');
    if(!location){conflicts.push(change.path);continue;}
    if(change.path.length===1 && change.path[0]==='tagDefaultsVersion' && !hasBefore && change.after===1 && Array.isArray(next.tags)){
      upgradePlannerTagDefaults(next);
      continue;
    }
    if(syncOwn(change,'materialize')){
      if(location.exists)continue;
      materializeDay(next,change.path[1]);
      if(!syncEqual(next.days[change.path[1]],change.before)||!syncEqual(next.dayMeta[change.path[1]],change.materialize))conflicts.push(change.path);
      continue;
    }
    const matchesBefore=location.exists===hasBefore&&(!hasBefore||syncEqual(location.value,change.before));
    const matchesAfter=location.exists===hasAfter&&(!hasAfter||syncEqual(location.value,change.after));
    if(!matchesBefore){
      // A missing reservation may already have been filled by a different device.
      if(matchesAfter&&!isTimerChange(change)&&!(isTagSlot(change.before)&&!hasAfter))continue;
      conflicts.push(change.path);continue;
    }
    if(hasAfter){
      if(location.id&&(!syncObject(change.after)||change.after.id!==location.id))throw new TypeError('记录编号不能改变。');
      location.parent[location.key]=syncCopy(change.after);
    }else if(location.exists){
      if(Array.isArray(location.parent))location.parent.splice(location.key,1);
      else delete location.parent[location.key];
    }
  }
  if(conflicts.length)throw new SyncConflictError(conflicts);
  return next;
}
/** Only called after an explicit user choice. Never force a stale timer/record edit. */
export function rebaseChanges(data,changes) {
  if(!validateChanges(changes))throw new TypeError('同步修改格式不正确。');
  const next=syncNormalized(data),rebased=[];
  for(const change of changes){
    const location=syncLocation(next,change.path);
    if(!location||change.path[0]==='tracking'||(syncOwn(change,'before')&&!location.exists))throw new SyncConflictError([change.path],'该内容已被删除或涉及执行计时，请先核对记录。');
    if(syncOwn(change,'materialize')){rebased.push(syncCopy(change));continue;}
    const item={path:syncCopy(change.path),...(location.exists?{before:syncCopy(location.value)}:{}),...(syncOwn(change,'after')?{after:syncCopy(change.after)}:{})};
    rebased.push(item);
    const applied=applyChanges(next,[item]);
    for(const key of Object.keys(next))delete next[key];Object.assign(next,applied);
  }
  return rebased;
}
