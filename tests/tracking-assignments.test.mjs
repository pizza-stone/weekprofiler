import test from 'node:test';
import assert from 'node:assert/strict';
import {pairPlanLinks} from '../lib/plan-matching.mjs';
import {actualSegments,parseTimeInput,pauseTracking,resumeTracking,startTracking,stopTracking,summarizeTracking,trackingRecordAssignments,validateTracking} from '../lib/tracking.mjs';
import {migrateData,seedData,validateData} from '../lib/planner.mjs';

const day='2026-11-16',now=Date.parse(day+'T20:00:00Z');
const instant=(clock,date=day)=>Date.parse(date+'T'+clock+'Z');
const plan=(id,start,extra={})=>({id,taskId:'read',title:'阅读',category:'learn',tagId:'learn',start,duration:30,done:false,...extra});
const session=(id,start,end,extra={})=>({id,planDate:day,blockId:'morning',title:'阅读',category:'learn',tagId:'learn',startedAt:instant(start),endedAt:instant(end),...extra});
const owners=(blocks,records,timer=null,date=day,timezone='UTC')=>trackingRecordAssignments(blocks,records,timer,date,now,timezone);
const summary=(blocks,records,timer=null,date=day,timezone='UTC')=>summarizeTracking(blocks,records,timer,date,now,[],[],timezone);
const cards=(blocks,records)=>[
  ...blocks.map(block=>({role:'plan',planDate:day,blockId:block.id,title:block.title,taskId:block.taskId,category:block.category,startAt:instant('00:00:00')+block.start*60000})),
  ...records.map(record=>({role:'actual',planDate:record.planDate,blockId:record.blockId,title:record.title,taskId:'read',category:record.category,startAt:record.startedAt,recordId:'session:'+record.id,binding:record.planBinding,hasOrigin:blocks.some(block=>block.id===record.blockId)})),
];

test('legacy near-time ownership supplies the same morning and afternoon totals as the links without rewriting history',()=>{
  const blocks=[plan('morning',540),plan('afternoon',840)];
  const records=[session('first','09:10:13','09:40:14'),session('second','14:10:11','14:40:12')];
  const before=structuredClone({blocks,records}),assigned=owners(blocks,records),stats=summary(blocks,records);
  assert.deepEqual([...assigned],[['session:first','morning'],['session:second','afternoon']]);
  assert.deepEqual(stats.items.map(item=>item.actualMinutes),[30+1/60,30+1/60]);
  assert.equal(stats.deficitMinutes,0);
  for(const group of pairPlanLinks(cards(blocks,records)).groups)assert.equal(assigned.get(group.actuals[0].recordId),group.plan.blockId);
  assert.deepEqual({blocks,records},before,'derivation retains original block IDs, timestamps and labels');
});

test('additional pause segments retain their original owner and every elapsed minute is counted once',()=>{
  const blocks=[plan('morning',540),plan('afternoon',840)];
  const records=[session('first','09:00:00','09:10:00'),session('resume','09:20:00','09:30:00'),session('second','14:00:00','14:30:00')];
  const assigned=owners(blocks,records),stats=summary(blocks,records);
  assert.deepEqual([...assigned],[['session:first','morning'],['session:resume','morning'],['session:second','afternoon']]);
  assert.deepEqual(stats.items.map(item=>item.actualMinutes),[20,30]);
  assert.equal(stats.actualMinutes,50);assert.equal(stats.items.reduce((sum,item)=>sum+item.actualMinutes,0),stats.actualMinutes);
  assert.equal(pairPlanLinks(cards(blocks,records)).groups.length,2,'one displayed link per plan even when multiple segments accumulate');
});

test('explicit selection stays attached to its plan and reserves that plan before legacy matching',()=>{
  const blocks=[plan('morning',540),plan('afternoon',840)];
  const records=[session('legacy','09:00:00','09:30:00'),session('chosen','14:00:00','14:30:00',{planBinding:'explicit'})];
  assert.deepEqual([...owners(blocks,records)],[['session:legacy','afternoon'],['session:chosen','morning']]);
  const result=pairPlanLinks(cards(blocks,records));
  assert.deepEqual(result.groups.map(group=>[group.plan.blockId,group.actuals[0].recordId]),[['morning','session:chosen'],['afternoon','session:legacy']]);
  assert.deepEqual(summary(blocks,records).items.map(item=>item.actualMinutes),[30,30]);
});

test('several explicitly bound recordings all accumulate but only their nearest representative receives a line',()=>{
  const blocks=[plan('morning',540),plan('afternoon',840)];
  const records=[session('first','09:00:01','09:10:01',{planBinding:'explicit'}),session('second','14:00:00','14:30:00',{planBinding:'explicit'})];
  assert.deepEqual([...owners(blocks,records)],[['session:first','morning'],['session:second','morning']]);
  assert.deepEqual(summary(blocks,records).items.map(item=>item.actualMinutes),[40,0]);
  const result=pairPlanLinks(cards(blocks,records));
  assert.equal(result.groups.length,1);assert.equal(result.groups[0].actuals[0].recordId,'session:first');
  assert.equal(result.unmatched[0].reason,'additional');
});

test('deleted, temporary and other-day records cannot acquire a replacement plan merely by sharing its task name',()=>{
  const blocks=[plan('morning',540),plan('afternoon',840)];
  const records=[session('removed','09:00:00','09:10:00',{blockId:'deleted'}),session('quick','09:20:00','09:30:00',{unplanned:true}),
    session('tomorrow','14:00:00','14:30:00',{planDate:'2026-11-17'})];
  assert.deepEqual([...owners(blocks,records)],[]);
  const stats=summary(blocks,records);assert.equal(stats.actualMinutes,20);assert.deepEqual(stats.items.map(item=>item.actualMinutes),[0,0]);
});

test('project and task identities isolate same-name plans while source block metadata tolerates renamed history',()=>{
  const blocks=[plan('morning',540),plan('other-project',840,{category:'work'}),plan('other-task',840,{taskId:'write'})];
  const records=[session('late','14:00:00','14:30:00',{title:'更名前的阅读',category:'old-project'})];
  assert.equal(owners(blocks,records).get('session:late'),'morning');
  assert.deepEqual(summary(blocks,records).items.map(item=>item.actualMinutes),[30,0,0]);
});

test('the chosen timezone and precise timestamps determine ownership instead of rounded display minutes',()=>{
  const blocks=[plan('morning',600),plan('afternoon',660)];
  const records=[session('half','02:30:00','02:45:00'),session('after-half','02:30:00.001','02:45:00.001')];
  assert.equal(owners(blocks,[records[0]],null,day,'Asia/Shanghai').get('session:half'),'morning','exact tie respects source reference');
  assert.equal(owners(blocks,[records[1]],null,day,'Asia/Shanghai').get('session:after-half'),'afternoon','one precise millisecond breaks the tie');
  assert.equal(owners(blocks,[records[1]],null,day,'UTC').get('session:after-half'),'morning');
  assert.deepEqual(summary(blocks,[records[1]],null,day,'Asia/Shanghai').items.map(item=>item.actualMinutes),[0,15]);
});

test('after-midnight plans and records keep the original plan date despite their calendar date',()=>{
  const blocks=[plan('morning',1440),plan('night',1500)];
  const records=[session('after-midnight','01:05:00','01:35:00',{startedAt:instant('01:05:00','2026-11-17'),endedAt:instant('01:35:00','2026-11-17')})];
  assert.equal(owners(blocks,records).get('session:after-midnight'),'night');
  assert.deepEqual(summary(blocks,records).items.map(item=>item.actualMinutes),[0,30]);
  assert.equal(summary(blocks,records,null,'2026-11-17').actualMinutes,0);
  const dstBlocks=[plan('morning',90),plan('later',210)];
  const dstRecord={...records[0],planDate:'2026-11-01',startedAt:parseTimeInput('2026-11-01T03:20:00','America/New_York'),endedAt:parseTimeInput('2026-11-01T03:40:00','America/New_York')};
  assert.equal(owners(dstBlocks,[dstRecord],null,'2026-11-01','America/New_York').get('session:after-midnight'),'later');
});

test('timer and saved session keys remain independent even when IDs coincide; paused timers add no elapsed time',()=>{
  const blocks=[plan('morning',540),plan('afternoon',1140)],records=[session('same','09:00:00','09:10:00')];
  const timer={...records[0],id:'same',startedAt:instant('19:45:00')};delete timer.endedAt;
  assert.deepEqual([...owners(blocks,records,timer)],[['session:same','morning'],['timer:same','afternoon']]);
  assert.deepEqual(summary(blocks,records,timer).items.map(item=>item.actualMinutes),[10,15]);
  timer.startedAt=null;
  assert.equal(owners(blocks,records,timer).get('timer:same'),'morning');
  assert.deepEqual(summary(blocks,records,timer).items.map(item=>item.actualMinutes),[10,0]);
});

test('planned timer association survives pause, resume, backup migration and every display segment',()=>{
  let data=seedData();data.timezone='UTC';data.days[day]=[plan('morning',540),plan('afternoon',840)];
  startTracking(data,day,data.days[day][0],instant('14:00:00'),'timer');
  assert.equal(data.tracking.timer.planBinding,'explicit');
  pauseTracking(data,instant('14:10:00'),'first');
  data=migrateData(JSON.parse(JSON.stringify(data)));assert.equal(validateData(data),true);
  resumeTracking(data,instant('14:20:00'));stopTracking(data,instant('14:40:00'),'second');
  assert.deepEqual(data.tracking.sessions.map(record=>record.planBinding),['explicit','explicit']);
  assert.ok(actualSegments(data,day).every(segment=>segment.planBinding==='explicit'));
  assert.deepEqual(summary(data.days[day],data.tracking.sessions).items.map(item=>item.actualMinutes),[30,0]);
  startTracking(data,day,{...data.days[day][0],unplanned:true},instant('15:00:00'),'quick');
  assert.equal(Object.hasOwn(data.tracking.timer,'planBinding'),false);
});

test('tracking accepts legacy or explicit associations and rejects malformed association markers',()=>{
  const record=session('one','09:00:00','09:30:00');
  for(const planBinding of [undefined,'explicit'])assert.equal(validateTracking({sessions:[{...record,planBinding}],timer:null}),true);
  for(const planBinding of [null,true,'nearest','']){
    assert.equal(validateTracking({sessions:[{...record,planBinding}],timer:null}),false);
    assert.equal(validateTracking({sessions:[],timer:{...record,planBinding}}),false);
  }
});
