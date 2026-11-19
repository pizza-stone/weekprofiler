import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as planner from '../lib/planner.mjs';
import * as trackingModel from '../lib/tracking.mjs';
import { createTrackingUI } from '../web/tracking.js';
import { renderTimeShares } from '../web/time-shares.js';

const day='2026-11-09';
const instant=clock=>Date.parse(day+'T'+clock+'Z');
const copy=value=>JSON.parse(JSON.stringify(value));
const task=(id,category='project-a',tagId='focus')=>({id,title:id,duration:60,category,tagId,reusable:true,done:false});
const block=(id,start=540,category='project-a',tagId='focus')=>({id,title:id,start,duration:60,category,tagId,done:false});
const session=(id,category='project-a',tagId='focus')=>({id,planDate:day,blockId:'scheduled',title:'实际记录',category,tagId,startedAt:instant('09:00:00'),endedAt:instant('09:15:00')});

function harness(){
 const listeners={},modal={open:false,close(){this.open=false;}},error={textContent:''};
 const context=vm.createContext({
  ...planner,trackingModel,createTrackingUI,renderTimeShares,refreshPlanLinks(){},TextEncoder,Intl,Date,URL,Blob,Uint8Array,
  crypto:{randomUUID},FormData:class{constructor(form){this.values=form.values;}get(name){return this.values[name]??null;}},
  document:{addEventListener(type,fn){(listeners[type]??=[]).push(fn);},querySelector(selector){return selector==='#modal'?modal:selector==='#form-error'?error:null;},querySelectorAll(){return[];}},
  window:{addEventListener(){}},localStorage:{setItem(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){},
 });
 const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\nboot\(\);\s*$/,'');
 vm.runInContext(source+'\nrender=()=>{};cache=()=>{};updateStatus=()=>{};toast=()=>{};modal=(title,content)=>{globalThis.lastModal={title,content};};globalThis.api={state,commit,taskForm,blockForm,filteredTasks,taskCard,timeline,filters,tagFilters};',context);
 const h={...context.api,listeners,context,error};
 h.state.data=planner.seedData();h.state.ready=true;h.state.date=day;h.state.tab='tasks';
 h.state.data.groups.push({id:'project-a',name:'求职',color:'#112233'},{id:'project-b',name:'月任务',color:'#445566'});
 h.state.data.tags.push({id:'focus',name:'专注',color:'#C65476'},{id:'routine',name:'日常',color:'#477FCC'});
 h.submit=(id,values,dataset={})=>listeners.submit[0]({target:{id,values,dataset},preventDefault(){}});
 h.click=(action,id,attributes={})=>listeners.click[0]({target:{closest:()=>({dataset:{action,id,...attributes}})}});
 return h;
}

function fixture(h){
 const d=h.state.data;
 d.tasks=[task('pool-source'),task('pool-target','project-b','routine')];
 d.days[day]=[block('scheduled'),block('target',660,'project-b','routine')];
 d.templates=[{id:'day-template',name:'日模板',description:'',blocks:[block('template-source'),block('template-target',660,'project-b','routine')]}];
 d.weekTemplates=[{id:'week-template',name:'周模板',description:'',days:Array.from({length:7},(_,i)=>({templateId:null,templateName:'',blocks:i===0?[block('week-source')]:[]}))}];
 d.cycle.days=Array.from({length:7},(_,i)=>({templateId:null,templateName:'',blocks:i===0?[block('cycle-source')]:[]}));
 for(const blocks of [d.days[day],d.templates[0].blocks,d.weekTemplates[0].days[0].blocks,d.cycle.days[0].blocks])
  blocks.push(planner.createTagSlot('reservation','focus',1380,60));
 d.tracking={sessions:[session('old-session')],timer:{id:'old-timer',planDate:day,blockId:'scheduled',title:'运行中的计时',category:'project-a',tagId:'focus',startedAt:instant('10:00:00')}};
 assert.equal(planner.validateData(d),true);
}
function items(data){return [...data.tasks,...Object.values(data.days).flat(),...data.templates.flatMap(t=>t.blocks),...data.weekTemplates.flatMap(t=>t.days.flatMap(d=>d.blocks)),...data.cycle.days.flatMap(d=>d.blocks),...data.tracking.sessions,data.tracking.timer].filter(Boolean);}
function select(html,name){return html.match(new RegExp('<select[^>]*name="'+name+'"[^>]*>([\\s\\S]*?)<\\/select>'))?.[1];}

test('task and schedule forms select and save project and tag independently',()=>{
 const h=harness();fixture(h);
 h.state.filter='project-b';h.state.tagFilter='focus';
 h.taskForm();
 assert.match(select(h.context.lastModal.content,'category'),/value="project-b" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="focus" selected/);
 h.taskForm('pool-source');
 assert.match(select(h.context.lastModal.content,'category'),/value="project-a" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="focus" selected/);
 h.submit('task-form',{title:'保存任务',duration:'90',category:'project-b',tagId:'focus',reusable:'on'},{id:'pool-source'});
 const saved=h.state.data.tasks.find(t=>t.id==='pool-source');
 assert.equal(saved.category,'project-b');assert.equal(saved.tagId,'focus');assert.equal(saved.duration,90);
 h.blockForm({taskId:saved.id,start:900});
 assert.match(select(h.context.lastModal.content,'category'),/value="project-b" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="focus" selected/);
 h.submit('block-form',{title:'保存安排',start:'900',duration:'90',category:'project-a',tagId:'routine'},{task:saved.id});
 const scheduled=h.state.data.days[day].find(b=>b.title==='保存安排');
 assert.equal(scheduled.category,'project-a');assert.equal(scheduled.tagId,'routine');assert.equal(scheduled.taskId,saved.id);
 h.blockForm({id:scheduled.id});
 assert.match(select(h.context.lastModal.content,'category'),/value="project-a" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="routine" selected/);
 assert.equal(planner.validateData(h.state.data),true);
});

for(const scope of ['day','week']){
 test(scope+' template editor saves a tag reservation without a task or project, and can edit it',async()=>{
   const h=harness();fixture(h);
   const d=h.state.data,template=scope==='day'?d.templates[0]:d.weekTemplates[0];
   if(scope==='day'){h.state.templateId=template.id;h.blockForm({start:900});}
   else{h.state.weekTemplateId=template.id;await h.click('new-week-block',undefined,{weekday:'4',date:'2026-11-13',minute:'900'});}
   let html=h.context.lastModal.content;
   assert.match(html,/按标签预留/);assert.match(html,/data-block-fields="tag-slot" hidden disabled/);
   h.submit('block-form',{slotTag:'focus',start:'900',duration:'90'},{kind:'tag-slot',task:'pool-source'});
   const list=scope==='day'?template.blocks:template.days[4].blocks,slot=list.find(b=>b.start===900);
   assert.equal(slot.kind,'tag-slot');assert.equal(slot.tagId,'focus');assert.equal(slot.duration,90);
   assert.equal(slot.category,undefined);assert.equal(slot.taskId,undefined);
   if(scope==='day')h.blockForm({id:slot.id});else await h.click('edit-week-block',slot.id,{weekday:'4',date:'2026-11-13'});
   html=h.context.lastModal.content;
   assert.match(html,/data-block-fields="task" hidden disabled/);assert.match(select(html,'slotTag'),/value="focus" selected/);
   h.submit('block-form',{slotTag:'routine',start:'930',duration:'60'},{kind:'tag-slot',id:slot.id});
   const changed=list.find(b=>b.id===slot.id);
   assert.equal(changed.start,930);assert.equal(changed.tagId,'routine');assert.equal(changed.duration,60);
   assert.equal(planner.validateData(d),true);
 });
}

test('clicking a dated weekly reservation filters by tag and fills only that occurrence',async()=>{
 const h=harness();fixture(h);
 const d=h.state.data,date='2026-11-13';
 d.tasks.push({...task('finished'),reusable:false,done:true},{...task('short','project-b'),duration:30});
 d.cycle.enabled=true;d.cycle.startDate=day;d.cycle.days[4].blocks=[planner.createTagSlot('cycle-slot','focus',900,90)];
 const block=planner.resolveDay(d,date).blocks[0],cycle=copy(d.cycle);
 await h.click('edit-week-block',block.id,{weekday:'4',date});
 const html=h.context.lastModal.content;
 assert.match(html,/id="fill-tag-slot-form"/);assert.match(html,/value="short"/);assert.match(html,/value="pool-source"/);
 assert.doesNotMatch(html,/value="pool-target"|value="finished"|value="120"/);
 assert.match(html,/data-date="2026-11-13"/);
 h.submit('fill-tag-slot-form',{taskId:'pool-target',minutes:'30'},{date,id:block.id});
 assert.equal(d.days[date],undefined);assert.match(h.error.textContent,/标签/);
 h.submit('fill-tag-slot-form',{taskId:'short',minutes:'30'},{date,id:block.id});
 const dayBlocks=h.state.data.days[date];
 const assigned=dayBlocks.find(b=>b.taskId==='short'),remaining=dayBlocks.find(b=>b.kind==='tag-slot');
 assert.ok(dayBlocks.every(b=>b.id!==block.id));
 assert.equal(assigned.taskId,'short');assert.equal(assigned.start,900);assert.equal(assigned.duration,30);
 assert.equal(remaining.start,930);assert.equal(remaining.duration,60);
 assert.deepEqual(copy(h.state.data.cycle),cycle);assert.equal(h.state.undo.length,1);
});

test('a reservation with an empty task pool can still be adjusted or removed on the selected day',async()=>{
 const h=harness();fixture(h);
 const slot=planner.createTagSlot('empty','focus',900,90);
 h.state.data.days[day]=[slot];h.state.data.tasks=[];
 await h.click('edit-block',slot.id);
 assert.match(h.context.lastModal.content,/没有可选任务/);assert.doesNotMatch(h.context.lastModal.content,/id="fill-tag-slot-form"/);
 await h.click('edit-slot-time',slot.id);
 const html=h.context.lastModal.content;
 assert.match(html,/data-kind="tag-slot"/);assert.match(html,/data-action="delete-block"/);
 assert.doesNotMatch(html,/id="title"|data-action="block-kind"/);
 h.submit('block-form',{slotTag:'routine',start:'930',duration:'60'},{id:slot.id,kind:'tag-slot'});
 assert.equal(h.state.data.days[day][0].tagId,'routine');assert.equal(h.state.data.days[day][0].start,930);
});

test('project and tag filters intersect on task pages and in weekly template task pickers',async()=>{
 const h=harness();
 h.state.data.tasks=[task('match'),task('other-project','project-b'),task('other-tag','project-a','routine')];
 await h.click('filter','project-a');await h.click('task-tag-filter','focus');
 assert.deepEqual(h.filteredTasks().map(t=>t.id),['match']);
 await h.click('filter','all');
 assert.deepEqual(h.filteredTasks().map(t=>t.id),['match','other-project']);
 h.state.weekTemplateId=h.state.data.weekTemplates[0].id;
 await h.click('template-task-group','project-a');await h.click('template-task-tag','routine');
 assert.deepEqual(h.filteredTasks().map(t=>t.id),['other-tag']);
 assert.equal(h.state.weekFilter,'project-a');assert.equal(h.state.weekTagFilter,'routine');
 assert.equal(h.filters().includes('category-dot'),false);
 assert.match(h.tagFilters(),/background:#C65476/);
});

test('new tasks and custom schedule blocks inherit independent weekly project and tag selections',()=>{
 const h=harness();
 h.state.tab='week';h.state.weekFilter='project-b';h.state.weekTagFilter='focus';
 h.state.filter='project-a';h.state.tagFilter='routine';
 h.taskForm();
 assert.match(select(h.context.lastModal.content,'category'),/value="project-b" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="focus" selected/);
 h.blockForm({start:900});
 assert.match(select(h.context.lastModal.content,'category'),/value="project-b" selected/);
 assert.match(select(h.context.lastModal.content,'tagId'),/value="focus" selected/);
});

test('day schedule and task cards use independent tag colors across projects',()=>{
 const h=harness();
 h.state.data.days[day]=[block('same-tag-a'),block('same-tag-b',660,'project-b'),block('other-tag',780,'project-a','routine')];
 const html=h.timeline();
 const event=id=>html.match(new RegExp('<div[^>]*data-block="'+id+'"[^>]*>'))?.[0];
 assert.match(event('same-tag-a'),/--event-accent:#C65476;/);
 assert.match(event('same-tag-b'),/--event-accent:#C65476;/);
 assert.match(event('other-tag'),/--event-accent:#477FCC;/);
 assert.equal(html.includes('--event-accent:#112233'),false);
 const card=h.taskCard(task('tag-card','project-b'));
 assert.match(card,/background:#C65476/);assert.match(card,/专注/);assert.match(card,/月任务/);
});

for(const [kind,field,from,to] of [['group','category','project-a','project-b'],['tag','tagId','focus','routine']]){
 test(`deleting a ${kind} migrates tasks, every template scope, actual sessions and timer without changing the other taxonomy`,()=>{
  const h=harness();fixture(h);
  const before=copy(items(h.state.data));
  h.submit('delete-'+kind+'-form',{target:to},{id:from});
  const after=copy(items(h.state.data));
  assert.deepEqual(after,before.map(item=>item[field]===from?{...item,[field]:to}:item));
  assert.equal((kind==='tag'?h.state.data.tags:h.state.data.groups).some(item=>item.id===from),false);
  assert.equal(h.state.undo.length,1);assert.equal(planner.validateData(h.state.data),true);
 });

 test(`undoing ${kind} deletion restores original record taxonomy and retains later actual records, edits and paused status`,async()=>{
  const h=harness();fixture(h);
  h.submit('delete-'+kind+'-form',{target:to},{id:from});
  h.commit(d=>{
   d.tracking.sessions[0].endedAt=instant('09:20:00');
   trackingModel.pauseTracking(d,instant('10:25:00'),'later-session');
  },null,{recordUndo:false});
  const before=copy(h.state.data.tracking);
  await h.click('undo');
  const expected=copy(before);expected.sessions[0][field]=from;expected.timer[field]=from;
  assert.deepEqual(copy(h.state.data.tracking),expected);
  assert.equal(h.state.data.tracking.sessions[1][field],to,'records created after deletion retain their chosen taxonomy');
  assert.equal(h.state.data.tracking.timer.startedAt,null,'undo cannot resume the paused timer');
  assert.equal((kind==='tag'?h.state.data.tags:h.state.data.groups).some(item=>item.id===from),true);
  assert.equal(planner.validateData(h.state.data),true);
 });

 test(`undoing ${kind} deletion does not overwrite a replacement timer created afterward`,async()=>{
  const h=harness();fixture(h);
  h.submit('delete-'+kind+'-form',{target:to},{id:from});
  h.commit(d=>{
   trackingModel.stopTracking(d,instant('10:25:00'),'later-session');
   trackingModel.startTracking(d,day,{...block('new-task',900,'project-b','routine'),unplanned:true},instant('11:00:00'),'new-timer');
  },null,{recordUndo:false});
  const timer=copy(h.state.data.tracking.timer);
  await h.click('undo');
  assert.deepEqual(copy(h.state.data.tracking.timer),timer);
  assert.equal(h.state.data.tracking.sessions[0][field],from);
  assert.equal(h.state.data.tracking.sessions[1][field],to);
  assert.equal(planner.validateData(h.state.data),true);
 });
}

test('undoing deletion restores effective tags on valid legacy actual records that omit tagId',async()=>{
 const h=harness();fixture(h);
 const record=h.state.data.tracking.sessions[0];record.category='learn';delete record.tagId;
 const timer=h.state.data.tracking.timer;timer.category='learn';delete timer.tagId;
 assert.equal(planner.validateData(h.state.data),true);
 assert.equal(planner.effectiveTagId(h.state.data,record),'learn');
 h.submit('delete-tag-form',{target:'routine'},{id:'learn'});
 assert.equal(h.state.data.tracking.sessions[0].tagId,'routine');
 await h.click('undo');
 assert.equal(planner.effectiveTagId(h.state.data,h.state.data.tracking.sessions[0]),'learn');
 assert.equal(planner.effectiveTagId(h.state.data,h.state.data.tracking.timer),'learn');
 assert.equal(planner.validateData(h.state.data),true);
});
