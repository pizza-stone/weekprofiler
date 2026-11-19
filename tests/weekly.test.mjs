import test from 'node:test';
import assert from 'node:assert/strict';
import {seedData,validateData,migrateData,addDays,weekdayIndex,mondayOf,resolveDay,materializeDay,snapshotWeek} from '../lib/planner.mjs';

function enabledCycle() {
  const data=seedData();
  data.cycle.enabled=true;
  data.cycle.startDate='2026-11-16';
  data.cycle.endDate=null;
  data.cycle.sourceWeekTemplateId=data.weekTemplates[0].id;
  return data;
}

function legacyFixture() {
  const v2=seedData();
  const data={version:1,timezone:v2.timezone,tasks:v2.tasks,templates:v2.templates,days:{}};
  data.days['2026-11-14']=[{id:'existing-dated-event',taskId:'task-read',title:'保留的日程',start:600,duration:60,category:'learn',done:true}];
  return data;
}

test('V1 daytime backups migrate losslessly to independent V3 records, without enabling a cycle',()=>{
  const original=legacyFixture(),before=structuredClone(original),upgraded=migrateData(original);
  assert.equal(upgraded.version,3);
  assert.equal(validateData(upgraded),true);
  assert.equal(validateData(original),true);
  assert.deepEqual(upgraded.tasks,original.tasks);
  assert.deepEqual(upgraded.templates,original.templates);
  assert.deepEqual(upgraded.days,original.days);
  assert.equal(upgraded.cycle.enabled,false);
  assert.deepEqual(upgraded.groups.map(group=>group.id),['work','learn','life','rest']);
  assert.equal(upgraded.weekTemplates.length,2);
  assert.equal(upgraded.dayMeta['2026-11-14'].templateId,null);
  upgraded.tasks[0].title='Changed only in upgraded record';
  assert.deepEqual(original,before);
  const second=migrateData(upgraded);
  second.groups[0].name='Independent group';
  assert.notEqual(upgraded.groups[0].name,second.groups[0].name);
});

test('custom group IDs work across tasks, daily schedules, week templates and cycles',()=>{
  const data=seedData();
  data.groups.push({id:'group-personal-project',name:'个人项目',color:'#536F89'});
  const group='group-personal-project';
  data.tasks[0].category=group;
  data.templates[0].blocks[0].category=group;
  data.days['2026-11-14']=[{id:'saved',title:'个人项目',start:480,duration:60,category:group,done:false}];
  data.weekTemplates[0].days[0].blocks[0].category=group;
  data.cycle.days[0].blocks[0].category=group;
  assert.equal(validateData(data),true);
  data.groups=data.groups.filter(item=>item.id!==group);
  assert.equal(validateData(data),false);
});

test('seeded and migrated weekly templates keep independent block snapshots',()=>{
  for(const data of [seedData(),migrateData(legacyFixture())]){
    const standard=data.weekTemplates[0],light=data.weekTemplates[1];
    const lightBefore=structuredClone(light),cycleBefore=structuredClone(data.cycle);
    const dailyBefore=structuredClone(data.templates),tuesdayBefore=structuredClone(standard.days[1]);
    standard.days[0].blocks[0].start=480;
    standard.days[0].blocks[0].title='Only this standard Monday changes';
    assert.deepEqual(light,lightBefore);
    assert.deepEqual(data.cycle,cycleBefore);
    assert.deepEqual(data.templates,dailyBefore);
    assert.deepEqual(standard.days[1],tuesdayBefore);
    light.days[0].blocks[0].start=510;
    assert.equal(standard.days[0].blocks[0].start,480);
    assert.equal(validateData(data),true);
  }
});

test('group validation rejects dangling references independently in every schedule layer',()=>{
  const mutations=[
    data=>{data.tasks[0].category='missing';},
    data=>{data.templates[0].blocks[0].category='missing';},
    data=>{data.days['2026-11-14']=[{id:'x',title:'x',start:0,duration:30,category:'missing',done:false}];},
    data=>{data.weekTemplates[0].days[0].blocks[0].category='missing';},
    data=>{data.cycle.days[0].blocks[0].category='missing';},
    data=>{data.groups[0].color='red";color:transparent';},
    data=>{data.groups[0].name=' ';},
    data=>{data.groups.push({...data.groups[0]});},
  ];
  for(const mutation of mutations){const data=seedData();mutation(data);assert.equal(validateData(data),false);}
});

test('week arithmetic uses Monday first and remains correct over years, leap days and DST',()=>{
  assert.equal(weekdayIndex('2026-11-16'),0);
  assert.equal(weekdayIndex('2026-11-22'),6);
  assert.equal(mondayOf('2027-01-01'),'2026-12-28');
  assert.equal(addDays('2028-02-28',1),'2028-02-29');
  assert.equal(addDays('2028-02-29',1),'2028-03-01');
  assert.equal(addDays('2027-03-14',1),'2027-03-15');
  assert.throws(()=>addDays('2026-02-30',1));
  assert.throws(()=>weekdayIndex('not-a-date'));
  assert.throws(()=>addDays('2026-11-14',1.5));
  const data=enabledCycle();
  data.timezone='America/Los_Angeles';
  assert.equal(resolveDay(data,'2027-03-15').templateId,'template-workday');
  assert.equal(resolveDay(data,'2027-03-14').templateId,'template-weekend');
});

test('cycles use inclusive date boundaries and disabled cycles do not create appointments',()=>{
  const data=enabledCycle();
  data.cycle.endDate='2026-11-22';
  assert.equal(resolveDay(data,'2026-11-15').source,'empty');
  assert.equal(resolveDay(data,'2026-11-16').source,'cycle');
  assert.equal(resolveDay(data,'2026-11-22').source,'cycle');
  assert.equal(resolveDay(data,'2026-11-23').source,'empty');
  data.cycle.enabled=false;
  assert.deepEqual(resolveDay(data,'2026-11-16'),{blocks:[],templateId:null,templateName:'',source:'empty'});
  assert.deepEqual(data.days,{});
});

test('explicitly saved empty days override the cycle and reset when the exception is removed',()=>{
  const data=enabledCycle();
  data.days['2026-11-16']=[];
  data.dayMeta['2026-11-16']={templateId:null,templateName:'休假'};
  const day=resolveDay(data,'2026-11-16');
  assert.equal(day.source,'saved');
  assert.equal(day.templateName,'休假');
  assert.deepEqual(day.blocks,[]);
  delete data.days['2026-11-16'];
  delete data.dayMeta['2026-11-16'];
  assert.equal(resolveDay(data,'2026-11-16').source,'cycle');
});

test('cycle instances have stable date-specific IDs and reading cannot mutate stored snapshots',()=>{
  const data=enabledCycle(),before=structuredClone(data);
  const first=resolveDay(data,'2026-11-16'),again=resolveDay(data,'2026-11-16'),next=resolveDay(data,'2026-11-23');
  assert.deepEqual(first,again);
  assert.notEqual(first.blocks[0].id,next.blocks[0].id);
  first.blocks[0].title='Changed detached view';
  assert.deepEqual(data,before);
  assert.notEqual(resolveDay(data,'2026-11-16').blocks[0].title,first.blocks[0].title);
  data.cycle.days[0].blocks[0].id='a'.repeat(128);
  const longId=resolveDay(data,'2026-11-16').blocks[0].id;
  assert.ok(longId.length<=128);
  assert.equal(longId,resolveDay(data,'2026-11-16').blocks[0].id);
  assert.notEqual(longId,resolveDay(data,'2026-11-23').blocks[0].id);
});

test('materializing a cycle day makes an editable independent exception with source metadata',()=>{
  const data=enabledCycle();
  const result=materializeDay(data,'2026-11-16');
  assert.equal(result,data.days['2026-11-16']);
  assert.equal(data.dayMeta['2026-11-16'].weekTemplateId,'week-standard');
  result[0].done=true;
  result[0].title='Edited this Monday';
  assert.equal(resolveDay(data,'2026-11-16').source,'saved');
  assert.equal(resolveDay(data,'2026-11-16').blocks[0].done,true);
  assert.equal(resolveDay(data,'2026-11-23').blocks[0].done,false);
  assert.notEqual(resolveDay(data,'2026-11-23').blocks[0].title,result[0].title);
  assert.equal(materializeDay(data,'2026-11-16'),result);
  assert.equal(validateData(data),true);
});

test('week snapshots reset completion and remain detached from all source templates',()=>{
  const data=enabledCycle();
  materializeDay(data,'2026-11-17')[0].done=true;
  const snap=snapshotWeek(data,'2026-11-18');
  assert.equal(snap.length,7);
  assert.equal(snap[0].templateId,'template-workday');
  assert.equal(snap[6].templateId,'template-weekend');
  assert.equal(snap[1].blocks[0].done,false);
  const frozen=structuredClone(snap);
  data.templates[0].blocks[0].title='Change daily template';
  data.cycle.days[0].blocks[0].title='Change active cycle';
  data.days['2026-11-17'][0].title='Change saved Tuesday';
  assert.deepEqual(snap,frozen);
  snap[0].blocks[0].title='Change week copy';
  assert.notEqual(data.weekTemplates[0].days[0].blocks[0].title,snap[0].blocks[0].title);
});

test('weekly structures reject invalid cycles and overlaps but permit historical source labels',()=>{
  const mutations=[
    data=>{data.cycle.endDate='2026-02-30';},
    data=>{data.cycle.endDate='2000-01-01';},
    data=>{data.cycle.days.pop();},
    data=>{data.weekTemplates[0].days[0].blocks[1].start=data.weekTemplates[0].days[0].blocks[0].start;},
    data=>{data.cycle.days[0].blocks[1].start=data.cycle.days[0].blocks[0].start;},
    data=>{data.dayMeta['bad-date']={templateId:null,templateName:'test'};},
  ];
  for(const mutation of mutations){const data=seedData();mutation(data);assert.equal(validateData(data),false);}
  const historical=seedData();
  historical.templates=[];
  assert.equal(validateData(historical),true);
  historical.weekTemplates=[];
  historical.cycle.sourceWeekTemplateId='deleted-week-template';
  assert.equal(validateData(historical),true);
});
