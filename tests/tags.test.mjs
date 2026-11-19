import test from 'node:test';
import assert from 'node:assert/strict';
import {seedData,validateData,migrateData,effectiveTagId,tagForItem,resolveDay} from '../lib/planner.mjs';
import {validateTracking,startTracking,pauseTracking,resumeTracking,stopTracking,actualSegments,summarizeTracking} from '../lib/tracking.mjs';
import {createChanges,applyChanges} from '../lib/sync.mjs';

const date='2026-11-16',instant=clock=>Date.parse(date+'T'+clock+'Z');
const block=(id='planned',extra={})=>({id,title:'项目任务',category:'work',start:600,duration:60,done:false,...extra});
const lists=data=>[data.tasks,...data.templates.map(t=>t.blocks),...Object.values(data.days),...data.weekTemplates.flatMap(t=>t.days.map(d=>d.blocks)),...data.cycle.days.map(d=>d.blocks)];
function legacyData(){
  const data=seedData();data.timezone='UTC';data.days[date]=[block()];
  delete data.tags;
  for(const items of lists(data))for(const item of items)delete item.tagId;
  data.tracking={sessions:[{id:'old-session',planDate:date,blockId:'planned',title:'项目任务',category:'work',startedAt:instant('10:00:00'),endedAt:instant('10:10:00')}],
    timer:{id:'old-timer',planDate:date,blockId:'planned',title:'项目任务',category:'work',startedAt:null}};
  return data;
}

test('legacy tag migration preserves every project and clock while independently tagging every schedule layer',()=>{
  const data=legacyData();data.groups.find(group=>group.id==='rest').countTowardsCompletion=false;
  const before=structuredClone(data),upgraded=migrateData(data);
  assert.equal(validateData(data),true);assert.equal(validateData(upgraded),true);assert.equal(upgraded.version,3);
  assert.deepEqual(upgraded.groups,before.groups);
  assert.deepEqual(upgraded.tags,before.groups.map(({id,name,color})=>({id,name,color})));
  for(const items of lists(upgraded))for(const item of items)assert.equal(item.tagId,item.category);
  assert.equal(upgraded.tracking.sessions[0].tagId,'work');assert.equal(upgraded.tracking.timer.tagId,'work');
  const stripAdded=structuredClone(upgraded);delete stripAdded.tags;
  for(const items of lists(stripAdded))for(const item of items)delete item.tagId;
  for(const item of [...stripAdded.tracking.sessions,stripAdded.tracking.timer])delete item.tagId;
  assert.deepEqual(stripAdded,before);assert.deepEqual(data,before);
  assert.deepEqual(migrateData(upgraded),upgraded,'repeated migration is idempotent');
  upgraded.tags[0].color='#123456';assert.notEqual(upgraded.groups[0].color,upgraded.tags[0].color);
  assert.equal(data.groups[0].color,before.groups[0].color);
});

test('new data exposes independent labels and missing tag ids keep legacy and custom-group fallback',()=>{
  const data=seedData();assert.ok(data.tags.length>0);assert.ok(data.tasks.every(task=>task.tagId));
  data.groups.push({id:'project-research',name:'研究项目',color:'#123456'});
  data.days[date]=[block('new',{category:'project-research'})];
  assert.equal(validateData(data),true);
  assert.equal(effectiveTagId(data,{category:'learn'}),'learn');
  assert.equal(effectiveTagId(data,{category:'project-research'}),data.tags[0].id);
  assert.equal(effectiveTagId(data,{category:'work',tagId:'rest'}),'rest');
  assert.equal(tagForItem(data,{category:'work',tagId:'rest'}).name,'休息');
  assert.equal(tagForItem(data,{category:'work',tagId:'removed-label'}),null);
  const migrated=migrateData(data);assert.equal(migrated.days[date][0].tagId,data.tags[0].id);
  const virtual=seedData();virtual.cycle.enabled=true;virtual.cycle.startDate=date;
  assert.ok(resolveDay(virtual,date).blocks.every(item=>item.tagId));
});

test('explicit invalid labels are rejected in each planned layer, without accepting malformed tag collections',()=>{
  const locations=[data=>data.tasks[0],data=>data.templates[0].blocks[0],data=>data.days[date][0],
    data=>data.weekTemplates[0].days[0].blocks[0],data=>data.cycle.days[0].blocks[0]];
  for(const locate of locations)for(const invalid of ['missing-tag','',null,0,'bad id']){
    const data=seedData();data.days[date]=[block()];locate(data).tagId=invalid;
    assert.equal(validateData(data),false);assert.throws(()=>migrateData(data));
  }
  for(const mutate of [data=>{data.tags=[];},data=>{data.tags=null;},data=>data.tags.push({...data.tags[0]}),
    data=>{data.tags[0].color='red';},data=>{data.tags[0].name=' ';},data=>{data.tags[0].countTowardsCompletion='false';}]){
    const data=seedData();mutate(data);assert.equal(validateData(data),false);
  }
});

test('old tracking adopts its source label while explicit historical deleted labels survive independently',()=>{
  const data=migrateData(legacyData());data.days[date][0].tagId='learn';
  delete data.tracking.sessions[0].tagId;delete data.tracking.timer.tagId;
  const restored=migrateData(data);
  assert.equal(restored.tracking.sessions[0].tagId,'learn');assert.equal(restored.tracking.timer.tagId,'learn');
  const temporary=structuredClone(data);temporary.tracking.sessions[0].unplanned=true;temporary.tracking.sessions[0].category='rest';
  assert.equal(migrateData(temporary).tracking.sessions[0].tagId,'rest','temporary tasks do not inherit a coincidentally matching plan id');
  restored.tracking.sessions[0].tagId='historical-label';restored.tracking.sessions[0].category='removed-project';
  assert.equal(validateData(restored),true);assert.equal(migrateData(restored).tracking.sessions[0].tagId,'historical-label');
  for(const invalid of ['',null,5,'bad id']){
    const changed=structuredClone(restored.tracking);changed.sessions[0].tagId=invalid;assert.equal(validateTracking(changed),false);
  }
});

test('timer pause, reload, resume and actual display retain a tag independently from the project',()=>{
  let data=seedData();data.timezone='UTC';const planned=block('planned',{tagId:'learn'});data.days[date]=[planned];
  startTracking(data,date,planned,instant('10:00:00'),'timer');assert.equal(data.tracking.timer.tagId,'learn');
  pauseTracking(data,instant('10:20:00'),'first');data=JSON.parse(JSON.stringify(data));
  resumeTracking(data,instant('10:30:00'));stopTracking(data,instant('10:40:00'),'second');
  assert.ok(data.tracking.sessions.every(record=>record.category==='work'&&record.tagId==='learn'));
  assert.ok(actualSegments(data,date).every(segment=>segment.category==='work'&&segment.tagId==='learn'));
  assert.equal(summarizeTracking(data.days[date],data.tracking.sessions,null,date).actualMinutes,30);
  const legacy=legacyData();legacy.days[date][0].tagId='rest';legacy.tags=seedData().tags;
  assert.equal(actualSegments(legacy,date)[0].tagId,'rest');
});

test('either project or tag can exclude completion while all exact elapsed and deficit minutes remain unchanged',()=>{
  const blocks=[block('work',{tagId:'learn',done:true}),block('rest',{tagId:'rest',done:true}),
    block('excluded-project',{category:'life',tagId:'learn',done:false})];
  const groups=[{id:'work'},{id:'life',countTowardsCompletion:false}],tags=[{id:'learn'},{id:'rest',countTowardsCompletion:false}];
  const records=[{id:'one',planDate:date,blockId:'rest',title:'项目任务',category:'work',tagId:'rest',startedAt:instant('10:00:00'),endedAt:instant('10:30:30')}];
  const all=summarizeTracking(blocks,records,null,date),filtered=summarizeTracking(blocks,records,null,date,instant('12:00:00'),groups,tags);
  assert.equal(filtered.count,1);assert.equal(filtered.done,1);assert.equal(filtered.completionRate,1);assert.equal(filtered.excludedCount,2);
  assert.deepEqual(filtered.items.map(item=>item.countsTowardsCompletion),[true,false,false]);
  for(const key of ['actualMinutes','plannedMinutes','deficitMinutes','deficitRate'])assert.equal(filtered[key],all[key]);
  const missing=block('legacy',{category:'rest',done:true});
  assert.equal(summarizeTracking([missing],[],null,date,instant('12:00:00'),[],tags).count,0);
});

test('backup import and guarded synchronization retain labels and project assignment as independent edits',()=>{
  const original=legacyData(),migrated=migrateData(original);
  const migration=createChanges(original,migrated);
  assert.ok(migration.some(change=>change.path[0]==='tags'));
  assert.deepEqual(migrateData(applyChanges(original,migration)),migrated);
  const phone=structuredClone(migrated),desktop=structuredClone(migrated);
  phone.tags.find(tag=>tag.id==='learn').color='#112233';phone.tasks[0].tagId='rest';
  desktop.groups.find(group=>group.id==='learn').name='课题项目';desktop.tasks[0].category='work';
  const merged=applyChanges(phone,createChanges(migrated,desktop));
  assert.equal(merged.tasks[0].category,'work');assert.equal(merged.tasks[0].tagId,'rest');
  assert.equal(merged.tags.find(tag=>tag.id==='learn').color,'#112233');
  assert.equal(merged.groups.find(group=>group.id==='learn').name,'课题项目');
  const exported=JSON.parse(JSON.stringify({app:'weekprofiler',data:merged}));
  assert.deepEqual(migrateData(exported.data),merged);assert.equal(validateData(merged),true);
});
