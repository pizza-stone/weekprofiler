import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTracking,startTracking,pauseTracking,resumeTracking,stopTracking,summarizeTracking,actualSegments,timeInputValue,parseTimeInput} from '../lib/tracking.mjs';

const day='2026-11-15',instant=clock=>Date.parse(day+'T'+clock+'Z');
const block=(id='reading',duration=60,done=false)=>({id,title:'阅读',category:'learn',start:600,duration,done});
const session=(id,start,end,extra={})=>({id,planDate:day,blockId:'reading',title:'阅读',category:'learn',startedAt:instant(start),endedAt:instant(end),...extra});
const dataWith=(sessions=[],timer=null)=>({timezone:'UTC',tracking:{sessions,timer}});

test('timer supports pause, reload, resume and multiple sessions without counting the gap',()=>{
  let data={timezone:'UTC'};
  startTracking(data,day,block(),instant('10:10:00'),'timer-1');
  assert.equal(validateTracking(data.tracking),true);
  pauseTracking(data,instant('10:25:30'),'part-1');
  assert.equal(data.tracking.timer.startedAt,null);
  data=JSON.parse(JSON.stringify(data));
  resumeTracking(data,instant('10:40:00'));
  const during=summarizeTracking([block()],data.tracking.sessions,data.tracking.timer,day,instant('11:00:00'));
  assert.equal(during.actualMinutes,35.5);
  stopTracking(data,instant('11:10:00'),'part-2');
  assert.equal(data.tracking.timer,null);
  assert.deepEqual(data.tracking.sessions.map(item=>(item.endedAt-item.startedAt)/60000),[15.5,30]);
  assert.equal(summarizeTracking([block()],data.tracking.sessions,null,day).actualMinutes,45.5);
  startTracking(data,day,block(),instant('11:20:00'),'timer-2');
  stopTracking(data,instant('11:40:00'),'part-3');
  const final=summarizeTracking([block()],data.tracking.sessions,null,day);
  assert.equal(final.actualMinutes,65.5);assert.equal(final.deficitMinutes,0);assert.equal(final.deficitRate,0);
  assert.equal(final.coveredMinutes,60);assert.equal(final.coverageRate,1);
  assert.equal(final.completionRate,0,'elapsed time does not mark a task complete');
});

test('invalid timer transitions, backwards clocks and duplicate IDs do not mutate data',()=>{
  const data={timezone:'UTC'};
  assert.throws(()=>resumeTracking(data,instant('10:00:00')),/没有暂停/);
  assert.throws(()=>stopTracking(data,instant('10:00:00'),'first'),/没有正在/);
  startTracking(data,day,block(),instant('10:10:00'),'timer');
  let before=structuredClone(data);
  assert.throws(()=>startTracking(data,day,block(),instant('10:20:00'),'another'),/先结束/);
  assert.throws(()=>resumeTracking(data,instant('10:20:00')),/进行中/);
  assert.throws(()=>pauseTracking(data,instant('10:00:00'),'first'),/不能早于/);
  assert.throws(()=>stopTracking(data,instant('10:20:00'),'bad id'),/记录无效/);
  assert.deepEqual(data,before);
  pauseTracking(data,instant('10:20:00'),'first');
  before=structuredClone(data);
  assert.throws(()=>pauseTracking(data,instant('10:30:00'),'second'),/已经暂停/);
  assert.throws(()=>resumeTracking(data,instant('10:19:00')),/不能早于/);
  assert.deepEqual(data,before);
  resumeTracking(data,instant('10:30:00'));before=structuredClone(data);
  assert.throws(()=>stopTracking(data,instant('10:40:00'),'first'),/记录无效/);
  assert.deepEqual(data,before);
});

test('zero elapsed intervals are not stored and stopping a paused timer preserves existing segments',()=>{
  const data={timezone:'UTC'};
  startTracking(data,day,block(),instant('10:00:00'),'timer');
  pauseTracking(data,instant('10:00:00'),'empty');
  assert.deepEqual(data.tracking.sessions,[]);
  resumeTracking(data,instant('10:10:00'));
  pauseTracking(data,instant('10:20:00'),'record');
  stopTracking(data,instant('12:00:00'),'unused');
  assert.equal(data.tracking.sessions.length,1);assert.equal(data.tracking.timer,null);
});

test('unplanned timer survives serialized reload and retains its marker on every actual segment',()=>{
  let data={timezone:'UTC'};
  startTracking(data,day,{id:'quick',title:'临时任务',category:'learn',unplanned:true},instant('10:00:00'),'quick-timer');
  assert.equal(data.tracking.timer.unplanned,true);assert.equal(validateTracking(data.tracking),true);
  pauseTracking(data,instant('10:05:00'),'quick-first');
  data=JSON.parse(JSON.stringify(data));
  resumeTracking(data,instant('10:20:00'));stopTracking(data,instant('10:30:00'),'quick-second');
  assert.equal(data.tracking.timer,null);
  assert.deepEqual(data.tracking.sessions.map(s=>[s.blockId,s.unplanned]),[['quick',true],['quick',true]]);
  assert.ok(actualSegments(data,day).every(segment=>segment.unplanned===true),'display segments retain the temporary-task marker');
  assert.equal(validateTracking(data.tracking),true);
  const stats=summarizeTracking([],data.tracking.sessions,null,day);
  assert.equal(stats.actualMinutes,15);assert.equal(stats.plannedMinutes,0);assert.equal(stats.deficitRate,null);assert.equal(stats.completionRate,null);
  const invalid=structuredClone(data.tracking);invalid.sessions[0].unplanned='true';
  assert.equal(validateTracking(invalid),false,'the optional backup marker must be a boolean');
});

test('tracking validation accepts old backups and rejects malformed or overlapping records',()=>{
  assert.equal(validateTracking(undefined),true);
  assert.equal(validateTracking({sessions:[],timer:null}),true);
  const first=session('first','10:00:00','10:30:00');
  const next=session('next','10:30:00','11:00:00');
  assert.equal(validateTracking({sessions:[next,first],timer:null}),true);
  for(const invalid of [null,{}, {sessions:[]},
    {sessions:[first,{...next,id:'first'}],timer:null},
    {sessions:[first,{...next,startedAt:instant('10:29:59')}],timer:null},
    {sessions:[{...first,endedAt:first.startedAt}],timer:null},
    {sessions:[{...first,startedAt:Infinity}],timer:null},
    {sessions:[{...first,planDate:'2026-02-30'}],timer:null},
    {sessions:[{...first,title:' '}],timer:null},
    {sessions:[first],timer:{...first,id:'timer',startedAt:instant('10:20:00')}},
    {sessions:[],timer:{...first,id:'timer',startedAt:'now'}},
  ])assert.equal(validateTracking(invalid),false);
  assert.equal(validateTracking({sessions:[first],timer:{...first,id:'timer',startedAt:first.endedAt}}),true);
  assert.equal(validateTracking({sessions:[first],timer:{...first,id:'timer',startedAt:null}}),true);
});

test('duration coverage credits precise elapsed time up to each task’s current plan',()=>{
  const blocks=[block('reading',60,true),block('writing',60,false)];
  const records=[session('late','10:30:00','12:00:00'),session('short','12:00:00','12:20:00',{blockId:'writing'})];
  const stats=summarizeTracking(blocks,records,null,day);
  assert.equal(stats.actualMinutes,110);assert.equal(stats.plannedMinutes,120);
  assert.deepEqual(stats.items.map(item=>item.coveredMinutes),[60,20]);
  assert.deepEqual(stats.items.map(item=>item.coverageRate),[1,1/3]);
  assert.equal(stats.coveredMinutes,80);assert.equal(stats.coverageRate,2/3);
  assert.deepEqual(stats.items.map(item=>item.deficitMinutes),[0,40]);
  assert.equal(stats.deficitMinutes,40);assert.equal(stats.deficitRate,1/3);
  assert.equal(stats.completionRate,.5);assert.equal(stats.count,2);assert.equal(stats.done,1);
  const shifted=summarizeTracking([block()], [session('same-length','10:30:00','11:30:00')],null,day);
  assert.equal(shifted.deficitRate,0);
  const edited=summarizeTracking([block('reading',120)],records,null,day);
  assert.equal(edited.items[0].deficitMinutes,30,'uses current plan duration, with no baseline');
});

test('group exclusions remove completed and unfinished tasks only from completion counts',()=>{
  const blocks=[block('reading',60,true),block('writing',60,false),
    {...block('lunch',30,true),category:'life'}, {...block('rest',30,false),category:'rest'}];
  const records=[session('read','10:00:00','10:30:00'),
    session('lunch','11:00:00','11:20:00',{blockId:'lunch',category:'life'}),
    session('rest','11:20:00','11:30:00',{blockId:'rest',category:'rest'})];
  const groups=[{id:'learn'},{id:'life',countTowardsCompletion:false},{id:'rest',countTowardsCompletion:false}];
  const before=structuredClone({blocks,records,groups});
  const all=summarizeTracking(blocks,records,null,day);
  const filtered=summarizeTracking(blocks,records,null,day,instant('12:00:00'),groups);
  assert.equal(filtered.count,2);assert.equal(filtered.done,1);assert.equal(filtered.excludedCount,2);
  assert.equal(filtered.completionRate,.5);
  assert.deepEqual(filtered.items.map(item=>item.countsTowardsCompletion),[true,true,false,false]);
  for(const key of ['plannedMinutes','actualMinutes','coveredMinutes','coverageRate','deficitMinutes','deficitRate'])assert.equal(filtered[key],all[key]);
  assert.deepEqual({blocks,records,groups},before);
  groups.find(group=>group.id==='life').countTowardsCompletion=true;
  const restored=summarizeTracking(blocks,records,null,day,instant('12:00:00'),groups);
  assert.equal(restored.count,3);assert.equal(restored.done,2);assert.equal(restored.excludedCount,1);
  assert.equal(restored.completionRate,2/3);
});

test('all-excluded days have no completion denominator while legacy and unknown groups count normally',()=>{
  const blocks=[block('reading',60,true)],groups=[{id:'learn',countTowardsCompletion:false}];
  const excluded=summarizeTracking(blocks,[],null,day,instant('12:00:00'),groups);
  assert.equal(excluded.count,0);assert.equal(excluded.done,0);assert.equal(excluded.completionRate,null);
  assert.equal(excluded.excludedCount,1);assert.equal(excluded.plannedMinutes,60);assert.equal(excluded.deficitRate,1);
  for(const settings of [[],[{id:'learn'}],[{id:'learn',countTowardsCompletion:true}],[{id:'unrelated',countTowardsCompletion:false}]]){
    const stats=summarizeTracking(blocks,[],null,day,instant('12:00:00'),settings);
    assert.equal(stats.completionRate,1);assert.equal(stats.count,1);assert.equal(stats.excludedCount,0);
  }
});

test('statistics keep occurrence dates separate and retain actual records after removing a plan task',()=>{
  const records=[session('own','10:00:00','10:40:00'),session('other','11:00:00','12:00:00',{planDate:'2026-11-16'})];
  const summary=summarizeTracking([block()],records,null,day);
  assert.equal(summary.actualMinutes,40);assert.equal(summary.deficitMinutes,20);
  const removed=summarizeTracking([],records,null,day);
  assert.equal(removed.actualMinutes,40);assert.equal(removed.completionRate,null);assert.equal(removed.deficitRate,null);
  const paused={id:'timer',planDate:day,blockId:'reading',title:'阅读',category:'learn',startedAt:null};
  assert.equal(summarizeTracking([block()],records,paused,day).actualMinutes,40);
});

test('actual display rounds to the nearest half hour while precise records retain seconds',()=>{
  const records=[session('nearest','10:10:00','10:50:00'),session('exact','11:00:00','11:30:00'),
    session('seconds','11:30:00','11:30:01'),session('short','12:10:00','12:15:00')];
  const data=dataWith(records),before=structuredClone(data);
  const rendered=actualSegments(data,day);
  assert.deepEqual(rendered.map(item=>[item.id,item.start,item.duration]),[
    ['nearest',600,60],['exact',660,30],['seconds',690,0],['short',720,30],
  ]);
  assert.equal(rendered[0].exactStart,instant('10:10:00'));assert.equal(rendered[0].exactEnd,instant('10:50:00'));
  assert.equal(rendered[2].exactEnd-rendered[2].exactStart,1000);
  assert.deepEqual(data,before);
  assert.equal(summarizeTracking([block()],records,null,day).actualMinutes,75+1/60);
});

test('nearby short sessions and a running timer remain visible when rounded endpoints coincide',()=>{
  const data=dataWith([session('first','10:10:00','10:20:00'),session('second','10:20:00','10:40:00')]);
  assert.deepEqual(actualSegments(data,day).map(item=>[item.start,item.duration]),[[600,30],[630,0]]);
  startTracking(data,day,block(),instant('10:50:00'),'running');
  let segment=actualSegments(data,day,instant('11:10:00')).find(item=>item.live);
  assert.equal(segment.start,660);assert.equal(segment.duration,0);assert.equal(segment.exactEnd,instant('11:10:00'));
  const reloaded=JSON.parse(JSON.stringify(data));
  segment=actualSegments(reloaded,day,instant('11:35:00')).find(item=>item.live);
  assert.equal(segment.duration,30);
});

test('actual records split at 04:00, keep midnight in the same planning day and never get reassigned by planDate',()=>{
  const sessions=[{...session('overnight','23:50:00','23:59:00'),endedAt:Date.parse('2026-11-16T00:10:00Z')},
    {...session('boundary','23:50:00','23:59:00'),startedAt:Date.parse('2026-11-16T03:50:00Z'),endedAt:Date.parse('2026-11-16T04:10:00Z')}];
  const data=dataWith(sessions);
  const current=actualSegments(data,day),next=actualSegments(data,'2026-11-16');
  assert.deepEqual(current.map(item=>[item.id,item.start,item.duration]),[['overnight',1440,0],['boundary',1680,0]]);
  assert.deepEqual(next.map(item=>[item.id,item.start,item.duration]),[['boundary',240,0]]);
  assert.equal(current[1].exactEnd,next[0].exactStart);
  assert.equal(next[0].planDate,day);
  assert.equal(summarizeTracking([block()],sessions,null,day).actualMinutes,40);
  assert.deepEqual(actualSegments(data,'2026-11-17'),[]);
});

test('manual timestamp conversion uses the selected timezone and rejects invalid or nonexistent times',()=>{
  const t=Date.parse('2026-11-15T02:10:25Z');
  assert.equal(timeInputValue(t,'Asia/Shanghai'),'2026-11-15T10:10:25');
  assert.equal(parseTimeInput('2026-11-15T10:10:25','Asia/Shanghai'),t);
  assert.equal(parseTimeInput('2026-11-15T10:10','Asia/Shanghai'),t-25000);
  assert.equal(parseTimeInput('2027-11-07T01:30:00','America/Los_Angeles'),Date.parse('2027-11-07T08:30:00Z'));
  assert.throws(()=>parseTimeInput('2027-03-14T02:30:00','America/Los_Angeles'),/不存在/);
  for(const value of ['invalid','2026-02-30T10:00','2026-11-15T25:00','2026-11-15T10:60','2026-11-15'])assert.throws(()=>parseTimeInput(value,'UTC'));
});

test('DST fallback produces separate wall-clock sections without losing real elapsed time',()=>{
  const date='2027-11-06',record={id:'fall',planDate:date,blockId:'reading',title:'Reading',category:'learn',
    startedAt:Date.parse('2027-11-07T08:50:00Z'),endedAt:Date.parse('2027-11-07T09:10:00Z')};
  const data={timezone:'America/Los_Angeles',tracking:{sessions:[record],timer:null}};
  const segments=actualSegments(data,date);
  assert.deepEqual(segments.map(item=>[item.start,item.duration]),[[1500,0],[1560,0]]);
  assert.equal(segments.reduce((sum,item)=>sum+item.exactEnd-item.exactStart,0),1200000);
  assert.equal(summarizeTracking([block()],data.tracking.sessions,null,date).actualMinutes,20);
});


test('both endpoints use a strict 15-minute half-up threshold, including milliseconds',()=>{
  const cases=[['06:10:00',360],['06:14:59.999',360],['06:15:00',390],['06:20:00',390],['06:44:59.999',390],['06:45:00',420]];
  for(const [clock,rounded] of cases){
    const startRecord=session('start',clock,'07:30:00'),endRecord=session('end','05:30:00',clock);
    const startData=dataWith([startRecord]),endData=dataWith([endRecord]);
    const beforeStart=structuredClone(startData),beforeEnd=structuredClone(endData);
    const [startSegment]=actualSegments(startData,day),[endSegment]=actualSegments(endData,day);
    assert.equal(startSegment.start,rounded,clock+' start');
    assert.equal(startSegment.start+startSegment.duration,450);
    assert.equal(endSegment.start+endSegment.duration,rounded,clock+' end');
    assert.equal(startSegment.exactStart,startRecord.startedAt);assert.equal(endSegment.exactEnd,endRecord.endedAt);
    assert.deepEqual(startData,beforeStart);assert.deepEqual(endData,beforeEnd);
    assert.equal(summarizeTracking([block()],endData.tracking.sessions,null,day).actualMinutes,(endRecord.endedAt-endRecord.startedAt)/60000);
  }
});

test('positive short intervals retain zero-length rounded markers with their exact duration',()=>{
  const records=[session('early','06:01:00','06:10:00'),session('middle','06:20:00','06:40:00'),session('second','07:00:00','07:00:01')];
  const segments=actualSegments(dataWith(records),day);
  assert.deepEqual(segments.map(s=>[s.id,s.start,s.duration]),[['early',360,0],['middle',390,0],['second',420,0]]);
  assert.deepEqual(segments.map(s=>s.exactEnd-s.exactStart),[540000,1200000,1000]);
  assert.equal(summarizeTracking([block()],records,null,day).actualMinutes,29+1/60);
});
