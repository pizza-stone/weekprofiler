import test from 'node:test';
import assert from 'node:assert/strict';
import { assignTagSlot, installStarterTemplates, isTagSlot, legacySeedData, migrateData, seedData, validateData } from '../lib/planner.mjs';
import { applyChanges, createChanges } from '../lib/sync.mjs';

test('a fresh planner offers fillable study and creative reservations on day and week templates',()=>{
  const data=seedData(),pristine=structuredClone(data),date='2026-11-17';
  assert.ok(validateData(data));assert.deepEqual(data.days,{});assert.equal(data.cycle.enabled,false);
  assert.equal(data.tracking?.sessions.length||0,0);
  for(const [dayId,weekId,weekday,tagId] of [
    ['template-workday','week-standard',0,'learn'],['template-creative-day','week-creative',1,'creative'],
  ]){
    const day=data.templates.find(item=>item.id===dayId);
    const week=data.weekTemplates.find(item=>item.id===weekId);
    assert.deepEqual(week.days[weekday].blocks,day.blocks);
    assert.ok(day.blocks.some(block=>!isTagSlot(block)));
    const slot=day.blocks.find(isTagSlot);
    assert.equal(slot.tagId,tagId);assert.equal(slot.duration,90);
    const tasks=data.tasks.filter(task=>task.tagId===tagId && task.reusable);
    const short=tasks.find(task=>task.duration===30),long=tasks.find(task=>task.duration===60);
    assert.ok(short && long);
    data.days[date]=structuredClone(week.days[weekday].blocks);
    assignTagSlot(data,date,slot.id,short.id,30);
    const remainder=data.days[date].find(isTagSlot);
    assert.equal(remainder.start,slot.start+30);assert.equal(remainder.duration,60);
    assignTagSlot(data,date,remainder.id,long.id,60);
    assert.ok(data.days[date].some(block=>block.taskId===long.id && block.start===slot.start+30));
    assert.ok(!data.days[date].some(isTagSlot));
    assert.ok(validateData(data));
  }
  assert.deepEqual(data.templates,pristine.templates);assert.deepEqual(data.weekTemplates,pristine.weekTemplates);
});

test('optional examples preserve existing projects, user-named templates, actual time and active schedules',()=>{
  const data=migrateData(legacySeedData());
  data.tags.find(tag=>tag.name==='创作').color='#123456';
  data.cycle.enabled=true;
  data.days['2026-11-16']=structuredClone(data.templates[0].blocks);
  data.tracking={timer:null,sessions:[]};
  data.templates.push({id:'template-creative-day',name:'创作日',description:'自己设计的模板',blocks:[]});
  data.weekTemplates.push({...structuredClone(data.weekTemplates[1]),id:'week-creative',name:'创作周'});
  data.tasks.push({...data.tasks[0],id:'sample-creative-sketch',title:'勾勒作品草图'});
  const before=structuredClone(data),installed=installStarterTemplates(data);
  assert.ok(installed.changed);assert.notEqual(installed.dayTemplateId,'template-creative-day');
  assert.notEqual(installed.weekTemplateId,'week-creative');
  assert.deepEqual(data.templates.slice(0,-1),before.templates);assert.deepEqual(data.weekTemplates.slice(0,-1),before.weekTemplates);
  assert.deepEqual(data.tasks.slice(0,-2),before.tasks);
  for(const key of ['tags','groups','days','dayMeta','cycle','tracking'])assert.deepEqual(data[key],before[key]);
  assert.equal(data.tasks.find(task=>task.starterExample==='creative-sketch').title,'勾勒作品草图（示例）');
  assert.equal(data.templates.at(-1).name,'创作日（示例）');
  assert.equal(data.weekTemplates.at(-1).days[1].templateId,installed.dayTemplateId);
  const mirror=structuredClone(before);installStarterTemplates(mirror);
  assert.deepEqual(applyChanges(mirror,createChanges(before,data)),data);
  data.templates.at(-1).name='我改了名字';
  const next=structuredClone(data);
  assert.deepEqual(installStarterTemplates(data),{...installed,changed:false});assert.deepEqual(data,next);
  assert.deepEqual(migrateData(before),before,'normal upgrades opt out of sample installation');
});

test('example installation respects historical tag ids and applies all additions atomically',()=>{
  const data=migrateData(legacySeedData());
  data.tags=data.tags.filter(tag=>tag.name!=='创作');
  data.tracking={sessions:[{id:'removed',title:'历史记录',blockId:'removed',planDate:'2026-11-16',
    category:'work',tagId:'creative',startedAt:1000,endedAt:2000}],timer:null};
  const full=structuredClone(data);
  while(full.weekTemplates.length<100)full.weekTemplates.push({...structuredClone(full.weekTemplates[0]),id:'full-'+full.weekTemplates.length});
  const before=structuredClone(full);
  assert.throws(()=>installStarterTemplates(full),/容量/);assert.deepEqual(full,before);
  assert.ok(installStarterTemplates(data).changed);
  const tag=data.tags.find(item=>item.name==='创作');
  assert.equal(tag.id,'creative-2');assert.equal(data.tracking.sessions[0].tagId,'creative');
  assert.equal(data.templates.at(-1).blocks.find(isTagSlot).tagId,tag.id);assert.ok(validateData(data));
});
