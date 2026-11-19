import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {seedData,resolveDay,materializeDay,mondayOf,addDays,validateData} from '../lib/planner.mjs';
import {validateAIContext,validateAIProposal} from '../lib/ai-planner.mjs';
const source=readFileSync(new URL('../web/ai.js',import.meta.url),'utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const ctx=vm.createContext({resolveDay,materializeDay,mondayOf,addDays,validateData,validateAIContext,validateAIProposal});
vm.runInContext(source+'\nglobalThis.api={aiContextFor,aiApplyCandidate};',ctx);
const {aiContextFor,aiApplyCandidate}=ctx.api;
const clone=v=>JSON.parse(JSON.stringify(v));
test('AI context selects only requested group and dates, and excludes completed or scheduled one-off tasks',()=>{
 const data=seedData();data.days['2026-11-16']=[{id:'existing',taskId:'once',title:'已经安排',category:'learn',start:600,duration:30,done:false}];
 data.tasks.push({id:'once',title:'已经安排',duration:30,category:'learn',done:false,reusable:false},{id:'done',title:'已完成',duration:30,category:'learn',done:true,reusable:false});
 data.days['2026-11-30']=[{id:'private',title:'范围之外',category:'work',start:600,duration:30,done:false}];
 const c=aiContextFor(data,'2026-11-18','week','learn');
 assert.equal(c.startDate,'2026-11-16');assert.equal(c.endDate,'2026-11-22');assert.equal(c.days.length,7);
 assert.equal(c.tasks.every(t=>t.category==='learn'&&!['once','done'].includes(t.id)),true);
 assert.equal(JSON.stringify(c).includes('范围之外'),false);
});
test('confirming an AI proposal is atomic and preserves cycles, task pool, templates and prior dates',()=>{
 const data=seedData();data.cycle.enabled=true;data.cycle.startDate='2026-11-01';
 const before=JSON.stringify(data),c=aiContextFor(data,'2026-11-16','day','learn'),task=c.tasks[0];
 const proposal={reply:'草案',explanation:'',assignments:[{taskId:task.id,date:'2026-11-16',start:1440,duration:task.duration}],unscheduledTaskIds:c.tasks.filter(t=>t.id!==task.id).map(t=>t.id)};
 const next=aiApplyCandidate(data,proposal,c,()=> 'ai-confirmed');
 assert.equal(JSON.stringify(data),before);assert.deepEqual(clone(next.cycle),data.cycle);assert.deepEqual(clone(next.templates),data.templates);assert.deepEqual(clone(next.tasks),data.tasks);
 assert.equal(next.days['2026-11-16'].at(-1).start,1440);assert.equal(next.days['2026-11-16'].at(-1).title,task.title);assert.equal(validateData(next),true);
 assert.equal(resolveDay(next,'2026-11-23').blocks.some(b=>b.id==='ai-confirmed'),false);
});
test('stale or conflicting AI confirmations never modify original data',()=>{
 const data=seedData(),c=aiContextFor(data,'2026-11-16','day','learn'),task=c.tasks[0];
 const p={reply:'草案',explanation:'',assignments:[{taskId:task.id,date:'2026-11-16',start:600,duration:task.duration}],unscheduledTaskIds:c.tasks.filter(t=>t.id!==task.id).map(t=>t.id)};
 data.days['2026-11-16']=[{id:'busy',title:'后来新增',category:'work',start:600,duration:30,done:false}];
 const before=JSON.stringify(data);assert.throws(()=>aiApplyCandidate(data,p,aiContextFor(data,'2026-11-16','day','learn'),()=> 'new'));
 assert.equal(JSON.stringify(data),before);
});

test('AI scheduling preserves the task tag independently of its project group',()=>{
 const data=seedData(),task=data.tasks.find(t=>t.category==='learn');task.tagId='work';
 const context=aiContextFor(data,'2026-11-16','day','learn');
 const proposal={reply:'草案',explanation:'',assignments:[{taskId:task.id,date:'2026-11-16',start:600,duration:task.duration}],unscheduledTaskIds:context.tasks.filter(t=>t.id!==task.id).map(t=>t.id)};
 const next=aiApplyCandidate(data,proposal,context,()=> 'ai-tagged');
 assert.equal(next.days['2026-11-16'][0].category,'learn');
 assert.equal(next.days['2026-11-16'][0].tagId,'work');
 assert.equal(validateData(next),true);
});
