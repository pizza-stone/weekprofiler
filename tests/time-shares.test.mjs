import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyTaskShares,renderTimeShares} from '../web/time-shares.js';
import {actualSegments,parseTimeInput} from '../lib/tracking.mjs';
import {resolveDay} from '../lib/planner.mjs';

const date='2026-11-16';
const instant=value=>parseTimeInput(value,'Asia/Shanghai');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const helpers={esc,actualSegments,resolveDay};

test('planned tag reservations contribute to their tag and share a single reserved row until assigned',()=>{
  const d=data(),slots=[{id:'s1',kind:'tag-slot',tagId:'learn',duration:30},{id:'s2',kind:'tag-slot',tagId:'learn',duration:60}];
  const stats=dailyTaskShares({data:d,blocks:[...slots,block('reading',30)],date},helpers);
  assert.equal(stats.totalMinutes,120);
  assert.equal(stats.tags[0].share,1);
  assert.deepEqual(stats.items.map(row=>[row.title,row.minutes]),[['学习 · 预留',90],['阅读',30]]);
});
const block=(id,duration=60,extra={})=>({id,title:'阅读',category:'learn',start:600,duration,done:false,...extra});
const session=(id,start,end,extra={})=>({id,planDate:date,blockId:'reading',title:'阅读',category:'learn',startedAt:instant(start),endedAt:instant(end),...extra});
function data(sessions=[],timer=null){return {timezone:'Asia/Shanghai',groups:[{id:'learn',name:'学习',color:'#7286b4'},{id:'rest',name:'休息',color:'#b09062',countTowardsCompletion:false}],days:{},dayMeta:{},templates:[],weekTemplates:[],cycle:{enabled:false},tracking:{sessions,timer}};}

test('planned shares combine repeated tasks without treating blank time as occupied time',()=>{
  const d=data(),blocks=[block('first',30,{taskId:'read'}),block('second',60,{taskId:'read'}),block('break',30,{title:'休息',category:'rest'})];
  const stats=dailyTaskShares({data:d,blocks,date},helpers);
  assert.equal(stats.totalMinutes,120);assert.equal(stats.items.length,2);
  assert.equal(stats.items[0].minutes,90);assert.equal(stats.items[0].share,.75);
  assert.equal(stats.items[1].share,.25,'excluded completion groups still contribute to time shares');
  assert.equal(stats.items.reduce((sum,item)=>sum+item.share,0),1);
  assert.equal(stats.tags.reduce((sum,item)=>sum+item.share,0),1);
});

test('label shares combine different projects while one task can retain multiple label allocations',()=>{
  const d=data();d.tags=[{id:'focus',name:'专注',color:'#123456'},{id:'break',name:'休息',color:'#abcdef'}];
  const blocks=[block('first',30,{taskId:'read',tagId:'focus'}),block('second',60,{taskId:'read',tagId:'break'}),block('third',30,{category:'rest',tagId:'focus',title:'另一个项目'})];
  const stats=dailyTaskShares({data:d,blocks,date},helpers);
  assert.equal(stats.totalMinutes,120);assert.equal(stats.items.length,2);assert.equal(stats.tags.length,2);
  for(const tag of stats.tags){assert.equal(tag.minutes,60);assert.equal(tag.share,.5);}
  const repeated=stats.items.find(item=>item.key==='task:read');
  assert.equal(repeated.minutes,90);assert.equal(repeated.share,.75);assert.equal(repeated.mixedTags,true);assert.equal(repeated.color,'#8a958b');
  assert.equal(stats.items.reduce((sum,item)=>sum+item.share,0),1);assert.equal(stats.tags.reduce((sum,item)=>sum+item.share,0),1);
  const html=renderTimeShares({data:d,blocks,date},helpers);
  assert.match(html,/标签占比/);assert.match(html,/各任务占比/);assert.match(html,/多标签/);
});

test('actual shares combine separate sessions and use exact time rather than rounded display length',()=>{
  const d=data([session('a',date+'T10:10:00',date+'T10:20:00'),session('b',date+'T10:30:00',date+'T10:45:30'),session('c',date+'T11:00:00',date+'T11:08:30',{blockId:'quick',title:'临时休息',category:'rest',unplanned:true})]);
  d.days[date]=[block('reading',60)];
  const stats=dailyTaskShares({data:d,date,source:'actual'},helpers);
  assert.equal(stats.totalMinutes,34);assert.equal(stats.items.length,2);
  assert.equal(stats.items[0].minutes,25.5);assert.equal(stats.items[0].share,.75);
  assert.equal(stats.items[1].minutes,8.5);assert.equal(stats.items[1].share,.25);
});

test('actual label shares retain record labels independently of the current plan and exact elapsed time',()=>{
  const d=data([
    session('a',date+'T10:10:00',date+'T10:20:30',{tagId:'focus'}),
    session('b',date+'T10:30:00',date+'T10:50:15',{tagId:'break'}),
    session('c',date+'T11:00:00',date+'T11:11:15',{tagId:'focus',category:'rest',blockId:'quick',title:'临时任务',unplanned:true}),
  ]);
  d.tags=[{id:'focus',name:'专注',color:'#123456'},{id:'break',name:'休息',color:'#abcdef'}];
  d.days[date]=[block('reading',60,{taskId:'read',tagId:'break'})];
  const stats=dailyTaskShares({data:d,date,source:'actual'},helpers);
  assert.equal(stats.totalMinutes,42);
  const labels=Object.fromEntries(stats.tags.map(item=>[item.key,item]));
  assert.equal(labels.focus.minutes,21.75);assert.equal(labels.break.minutes,20.25);
  assert.equal(labels.focus.share,21.75/42);assert.equal(labels.break.share,20.25/42);
  assert.equal(stats.items.find(item=>item.key==='task:read').minutes,30.75);assert.equal(stats.items.find(item=>item.key==='task:read').mixedTags,true);
  assert.ok(Math.abs(stats.tags.reduce((sum,item)=>sum+item.share,0)-1)<1e-12);
  assert.ok(Math.abs(stats.items.reduce((sum,item)=>sum+item.share,0)-1)<1e-12);
});

test('missing tag references use legacy category fallback while explicit removed labels stay separate',()=>{
  const d=data();d.tags=[{id:'learn',name:'学习 <&>',color:'#123456'},{id:'rest',name:'休息',color:'#abcdef'}];
  const blocks=[block('legacy'),block('removed',30,{tagId:'old-label'})];
  const stats=dailyTaskShares({data:d,blocks,date},helpers);
  assert.equal(stats.tags.find(item=>item.key==='learn').minutes,60);
  assert.equal(stats.tags.find(item=>item.key==='old-label').title,'已移除标签');assert.equal(stats.tags.find(item=>item.key==='old-label').color,'#8a958b');
  const html=renderTimeShares({data:d,blocks,date},helpers);assert.match(html,/学习 &lt;&amp;&gt;/);assert.doesNotMatch(html,/学习 <&>/);
});

test('actual shares clip at local 04:00 even when the source plan belongs to another date',()=>{
  const d=data([session('overnight','2026-11-16T03:45:00','2026-11-16T04:15:00',{planDate:'2026-11-15'})]);
  const before=dailyTaskShares({data:d,date:'2026-11-15',source:'actual'},helpers);
  const after=dailyTaskShares({data:d,date:'2026-11-16',source:'actual'},helpers);
  assert.equal(before.totalMinutes,15);assert.equal(after.totalMinutes,15);
  assert.equal(before.items[0].share,1);assert.equal(after.items[0].share,1);
});

test('live timer contributes only elapsed time in the visible day and paused timers contribute none',()=>{
  const timer={id:'live',planDate:date,blockId:'quick',title:'临时',category:'rest',startedAt:instant(date+'T23:50:00'),unplanned:true};
  const d=data([],timer),now=instant('2026-11-17T04:10:00');
  assert.equal(dailyTaskShares({data:d,date,source:'actual',now},helpers).totalMinutes,250);
  assert.equal(dailyTaskShares({data:d,date:'2026-11-17',source:'actual',now},helpers).totalMinutes,10);
  timer.startedAt=null;assert.equal(dailyTaskShares({data:d,date,source:'actual',now},helpers).totalMinutes,0);
});

test('empty days yield zero totals and readable empty states without invalid percentages',()=>{
  const d=data();assert.deepEqual(dailyTaskShares({data:d,date},helpers),{source:'plan',totalMinutes:0,items:[],tags:[]});
  const html=renderTimeShares({data:d,date,viewMode:'compare'},helpers);
  assert.match(html,/当天还没有安排任务/);assert.match(html,/当天还没有执行记录/);
  assert.equal(/NaN|Infinity|undefined/.test(html),false);
});

test('rendered rows escape titles, retain every task and distinguish plan and actual shares',()=>{
  const d=data(),blocks=Array.from({length:12},(_,i)=>block('task-'+i,30,{title:'任务 '+i+' <script>'}));
  const html=renderTimeShares({data:d,blocks,date,viewMode:'compare',compact:true},helpers);
  assert.match(html,/计划耗时占比/);assert.match(html,/执行耗时占比/);
  assert.equal((html.match(/data-shares-breakdown="tasks">([\s\S]*?)<\/ol>/)[1].match(/<li>/g)||[]).length,12);
  assert.equal((html.match(/data-shares-breakdown="tags">([\s\S]*?)<\/ol>/)[1].match(/<li>/g)||[]).length,1);
  assert.match(html,/任务 11 &lt;script&gt;/);assert.equal(html.includes('<script>'),false);
  assert.match(html,/8.3%/);assert.match(html,/不含空白时间/);
  assert.equal(html.includes(' open'),false,'weekly headers start compact');
});

test('templates always show planned shares and never read actual records',()=>{
  let actualReads=0;
  const html=renderTimeShares({data:data(),blocks:[block('reading')],date,viewMode:'actual',template:true},{...helpers,actualSegments:()=>{actualReads++;return[];}});
  assert.equal(actualReads,0);assert.match(html,/计划耗时占比/);assert.match(html,/100%/);
  assert.equal(html.includes('执行耗时占比'),false);assert.match(html,/data-shares-template="true"/);
});
