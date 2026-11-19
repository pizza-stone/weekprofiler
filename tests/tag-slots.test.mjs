import test from 'node:test';
import assert from 'node:assert/strict';
import { assignTagSlot, createTagSlot, isTagSlot, migrateData, resolveDay, seedData, snapshotWeek, tagForItem, validateData } from '../lib/planner.mjs';
import { applyChanges, createChanges, SyncConflictError } from '../lib/sync.mjs';
import { validateAIContext, validateAIProposal } from '../lib/ai-planner.mjs';
import { startTracking, pauseTracking, resumeTracking, summarizeTracking, trackingRecordAssignments } from '../lib/tracking.mjs';

const date='2026-11-16',nextMonday='2026-11-23';
function withSlot(){
  const data=seedData(),slot=createTagSlot('study-time','learn',600,120);
  data.templates[0].blocks=[slot];
  data.weekTemplates[0].days[0].blocks=[structuredClone(slot)];
  data.cycle.startDate=date;
  data.cycle.enabled=true;
  data.cycle.days=structuredClone(data.weekTemplates[0].days);
  return data;
}

test('a V3 backup keeps tag-only slots in templates, recurring days and saved dates',()=>{
  const data=withSlot();
  data.days[date]=resolveDay(data,date).blocks;
  assert.deepEqual(migrateData(JSON.parse(JSON.stringify(data))),data);
  data.tags.find(t=>t.id==='learn').name='进修';
  assert.equal(tagForItem(data,resolveDay(data,date).blocks[0]).name,'进修');
  assert.equal(isTagSlot(snapshotWeek(data,date)[0].blocks[0]),true);
  for(const invalid of [{tagId:'missing'},{tagId:undefined},{category:'work'},{taskId:'task-focus'},{done:true},{duration:45}]){
    const copy=structuredClone(data);
    Object.assign(copy.templates[0].blocks[0],invalid);
    assert.equal(validateData(copy),false,JSON.stringify(invalid));
  }
});

test('partial fillings create independent task identities and produce only one dated exception',()=>{
  const data=withSlot(),id=resolveDay(data,date).blocks[0].id;
  const before=structuredClone(data),task=data.tasks.find(t=>t.id==='task-read');
  const newIds=['filled','remaining'];
  const assigned=assignTagSlot(data,date,id,task.id,60,()=>newIds.shift());
  assert.deepEqual(assigned,{id:'filled',start:600,duration:60,taskId:task.id,title:task.title,category:task.category,tagId:'learn',done:false});
  assert.deepEqual(data.days[date][1],createTagSlot('remaining','learn',660,60));
  assignTagSlot(data,date,'remaining','task-notes');
  assert.equal(data.days[date][1].duration,60);
  assert.equal(data.days[date][1].taskId,'task-notes');
  assert.equal(isTagSlot(resolveDay(data,nextMonday).blocks[0]),true);
  assert.deepEqual(data.templates,before.templates);
  assert.deepEqual(data.weekTemplates,before.weekTemplates);
  assert.deepEqual(data.cycle,before.cycle);
  assert.equal(validateData(data),true);
});

test('mismatched, stale or invalid assignments do not materialize a recurring day',()=>{
  const data=withSlot(),id=resolveDay(data,date).blocks[0].id;
  const finished=data.tasks.find(t=>t.id==='task-notes');
  finished.reusable=false;finished.done=true;
  const before=structuredClone(data);
  for(const args of [[id,'task-focus'],[id,finished.id],['gone','task-read'],[id,'task-read',150],[id,'task-read',45],[id,'task-read',30,()=>id]]){
    assert.throws(()=>assignTagSlot(data,date,...args));
    assert.deepEqual(data,before);
  }
  assignTagSlot(data,date,id,'task-read');
  assert.throws(()=>assignTagSlot(data,date,id,'task-read'));
});

test('cloud changes preserve a split slot and reject a conflicting choice or retagging',()=>{
  const base=withSlot(),id=resolveDay(base,date).blocks[0].id;
  const first=structuredClone(base),second=structuredClone(base);
  assignTagSlot(first,date,id,'task-read',60);
  assignTagSlot(second,date,id,'task-notes');
  const changes=createChanges(base,first),merged=applyChanges(base,changes);
  assert.deepEqual(merged.days,first.days);
  assert.equal(validateData(merged),true);
  assert.throws(()=>applyChanges(merged,createChanges(base,second)),SyncConflictError);
  base.days[date]=resolveDay(base,date).blocks;
  const retagged=structuredClone(base);retagged.days[date][0].tagId='work';
  assert.throws(()=>applyChanges(retagged,createChanges(base,first)),SyncConflictError);
});

test('refilling an undone slot keeps separate ownership across an offline device, old sessions and a running timer',()=>{
  const base=withSlot(),id=resolveDay(base,date).blocks[0].id;
  const desktop=structuredClone(base),phone=structuredClone(base);
  const reading=assignTagSlot(desktop,date,id,'task-read');
  const start=Date.parse(date+'T10:00:00+08:00'),halfHour=30*60000;
  startTracking(desktop,date,reading,start,'timer');
  pauseTracking(desktop,start+halfHour,'explicit');
  resumeTracking(desktop,start+halfHour);
  pauseTracking(desktop,start+2*halfHour,'legacy');
  delete desktop.tracking.sessions[1].planBinding;
  resumeTracking(desktop,start+2*halfHour);
  // The desktop undoes filling the reservation, keeping all recorded and live time.
  const undone=structuredClone(base);undone.tracking=structuredClone(desktop.tracking);
  // The offline phone has not seen those records yet.
  const notes=assignTagSlot(phone,date,id,'task-notes');
  for(const merged of [applyChanges(undone,createChanges(base,phone)),applyChanges(phone,createChanges(base,undone))]){
    assert.deepEqual(merged.tracking,desktop.tracking);
    const plans=resolveDay(merged,date).blocks,now=start+3*halfHour;
    assert.equal(plans[0].id,notes.id);
    assert.notEqual(notes.id,reading.id);
    assert.equal(trackingRecordAssignments(plans,merged.tracking.sessions,merged.tracking.timer,date,now).size,0);
    const stats=summarizeTracking(plans,merged.tracking.sessions,merged.tracking.timer,date,now);
    assert.equal(stats.actualMinutes,90);
    assert.equal(stats.items[0].actualMinutes,0);
  }
  const initial=structuredClone(undone);
  assert.throws(()=>assignTagSlot(undone,date,id,'task-notes',60,()=>reading.id));
  const ids=['valid-new',reading.id];
  assert.throws(()=>assignTagSlot(undone,date,id,'task-notes',60,()=>ids.shift()));
  assert.deepEqual(undone,initial);
});

test('AI scheduling treats a reserved tag interval as occupied',()=>{
  const data=withSlot(),task=data.tasks.find(t=>t.id==='task-read');
  const context={groups:data.groups,tasks:[task],days:[{date,blocks:resolveDay(data,date).blocks}],timezone:data.timezone,startDate:date,endDate:date};
  assert.equal(validateAIContext({messages:[{role:'user',content:'安排阅读'}],context}),true);
  const proposal={reply:'已安排',explanation:'',assignments:[{taskId:task.id,date,start:630,duration:60}],unscheduledTaskIds:[]};
  assert.equal(validateAIProposal(proposal,context),false);
  proposal.assignments[0].start=720;
  assert.equal(validateAIProposal(proposal,context),true);
});
