import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as trackingModel from '../lib/tracking.mjs';
import { createTrackingUI } from '../web/tracking.js';
import { renderTimeShares } from '../web/time-shares.js';
import { refreshPlanLinks } from '../web/plan-links.js';
test('new tasks inherit the active group while edited tasks retain their own group', () => {
 const h=harness();h.state.tab='tasks';h.state.filter='learn';
 h.taskForm();assert.match(h.context.lastModal.content, /value="learn" selected/);
 h.taskForm('task-focus');assert.match(h.context.lastModal.content, /value="work" selected/);
 h.state.tab='week';h.state.weekFilter='rest';h.taskForm();assert.match(h.context.lastModal.content, /value="rest" selected/);
 h.state.tab='templates';h.state.weekTemplateId=h.state.data.weekTemplates[0].id;h.taskForm();assert.match(h.context.lastModal.content, /value="rest" selected/);
});
test('next-day clock labels and calendar exports agree on the 04:00 end boundary',()=>{
 const h=harness();
 assert.equal(h.time(1440),'次日 00:00');assert.equal(h.time(1680),'次日 04:00');
 assert.equal(h.utcDate('2026-11-14',1650,'Asia/Shanghai'),'20261114T193000Z');
 assert.equal(h.utcDate('2026-11-14',1680,'Asia/Shanghai'),'20261114T200000Z');
});
import { readFileSync } from 'node:fs';
import { seedData, validateData, migrateData, resolveDay, materializeDay, snapshotWeek, mondayOf, addDays, MAX_STATE_BYTES, MAX_TEMPLATE_NOTES, DAY_START, DAY_END, planningDate, tagForItem, effectiveTagId } from '../lib/planner.mjs';

function harness(fetch) {
  const listeners = {};
  const modal = { open: false, close() { this.open=false; } };
  const context = vm.createContext({
    seedData, validateData, migrateData, resolveDay, materializeDay, snapshotWeek, mondayOf, addDays, MAX_STATE_BYTES, MAX_TEMPLATE_NOTES, DAY_START, DAY_END, planningDate, tagForItem, effectiveTagId, trackingModel, createTrackingUI, renderTimeShares, refreshPlanLinks, TextEncoder, Intl, Date, URL, Blob,
    FormData: class { constructor(form) { this.values=form.values; } get(key) { return this.values[key]??null; } },
    Uint8Array, crypto: { getRandomValues: array => crypto.getRandomValues(array) },
    document: {
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
      querySelector(selector) { return selector === '#modal' ? modal : null; },
      querySelectorAll() { return []; },
    },
    window: { addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {},
    localStorage: { setItem() {} }, fetch,
  });
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\nboot\(\);\s*$/, '');
  vm.runInContext(source + '\nglobalThis.renderCount=0;render=()=>{globalThis.renderCount++;};cache=()=>{};updateStatus=()=>{};toast=()=>{};blockForm=value=>{globalThis.lastForm=value;};modal=(title,content)=>{globalThis.lastModal={title,content};};globalThis.api={state,refresh,save,commit,uid,dropMinute,utcDate,taskForm,taskCard,timeline,time,saveTemplateNotes,templateNotesPanel};', context);
  context.api.state.data = seedData();
  context.api.state.ready = true;
  context.api.state.revision = 1;
  return { ...context.api, listeners, context, modal, dispatch(type,event){for(const listener of listeners[type]||[])listener(event);} };
}

test('weekly statistics and individual day details toggle without editing or saving planner data',()=>{
 const h=harness(),before=JSON.stringify(h.state.data);
 const click=(action,id)=>h.dispatch('click',{target:{closest:selector=>selector==='[data-action]'?{dataset:{action,id}}:null}});
 assert.equal(!!h.state.weekStatsExpanded,false);
 click('week-stats-toggle');assert.equal(h.state.weekStatsExpanded,true);
 click('week-stats-toggle');assert.equal(h.state.weekStatsExpanded,false);
 click('week-day-details','2026-11-16');
 click('week-day-details','2026-11-17');
 assert.deepEqual([...h.state.weekDetailDays],['2026-11-16','2026-11-17']);
 click('week-day-details','2026-11-16');
 assert.deepEqual([...h.state.weekDetailDays],['2026-11-17']);
 assert.equal(JSON.stringify(h.state.data),before);
 assert.equal(h.state.dirty,false);assert.equal(h.state.undo.length,0);
});

function dragTrackedBlock(h,id,fromDate,toDate,minute){
  const column=date=>({dataset:{date,weekday:String((new Date(date+'T12:00:00Z').getUTCDay()+6)%7),gridStart:String(DAY_START)},
    getBoundingClientRect(){return {top:100,height:(DAY_END-DAY_START)/30*26};},querySelector(){return null;}});
  const source=column(fromDate),destination=column(toDate);
  const block={dataset:{block:id},closest(selector){return selector==='.week-day-column'?source:null;}};
  h.listeners.dragstart[0]({target:{closest(selector){return selector==='[data-block]'?block:null;}},dataTransfer:{setData(){}},preventDefault(){}});
  h.listeners.drop[0]({target:{closest(selector){return selector==='.week-day-column'?destination:null;}},
    clientY:100+(minute-DAY_START)/30*26+2,preventDefault(){}});
  vm.runInContext('suppressClickUntil=0;',h.context);
}
const moveBlock=(id,start=540)=>({id,title:'Tracked task',start,duration:30,category:'learn',done:false});
const moveInstant=time=>Date.parse('2026-11-09T'+time+'Z');
const moveSession=(id,date,blockId,start,end)=>({id,planDate:date,blockId,title:'Tracked task',category:'learn',startedAt:moveInstant(start),endedAt:moveInstant(end)});

test('cross-date drag and undo preserve existing and newly paused timer segments, including regenerated IDs',async()=>{
  const h=harness(),from='2026-11-09',to='2026-11-10';h.state.date=from;
  h.state.data.days[from]=[moveBlock('shared')];h.state.data.days[to]=[moveBlock('shared',720)];
  h.state.data.tracking={sessions:[moveSession('other',to,'shared','08:00:00','08:15:00'),moveSession('before',from,'shared','09:00:00','09:20:00')],timer:null};
  trackingModel.startTracking(h.state.data,from,h.state.data.days[from][0],moveInstant('09:30:00'),'running');
  dragTrackedBlock(h,'shared',from,to,600);
  const movedId=h.state.data.days[to][1].id;
  assert.notEqual(movedId,'shared');assert.equal(h.state.data.days[from].length,0);
  assert.equal(h.state.data.tracking.timer.planDate,to);assert.equal(h.state.data.tracking.timer.blockId,movedId);
  assert.equal(h.state.data.tracking.sessions[1].planDate,to);assert.equal(h.state.data.tracking.sessions[1].blockId,movedId);
  h.commit(d=>trackingModel.pauseTracking(d,moveInstant('10:00:00'),'after'),null,{recordUndo:false});
  const timestamps=JSON.stringify(h.state.data.tracking.sessions.map(s=>[s.id,s.startedAt,s.endedAt]));
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action:'undo'}})}});
  assert.equal(h.state.data.days[from][0].id,'shared');assert.equal(h.state.data.days[to].length,1);
  assert.equal(h.state.data.tracking.timer.startedAt,null,'undo must not restart the timer');
  assert.equal(h.state.data.tracking.timer.planDate,from);assert.equal(h.state.data.tracking.timer.blockId,'shared');
  assert.deepEqual(h.state.data.tracking.sessions.map(s=>[s.id,s.planDate,s.blockId]),[
    ['other',to,'shared'],['before',from,'shared'],['after',from,'shared'],
  ]);
  assert.equal(JSON.stringify(h.state.data.tracking.sessions.map(s=>[s.id,s.startedAt,s.endedAt])),timestamps);
  assert.equal(validateData(h.state.data),true);
});

test('undoing a move retains a timer first started at the destination and maps it back to its task',async()=>{
  const h=harness(),from='2026-11-09',to='2026-11-10';h.state.date=from;
  h.state.data.days[from]=[moveBlock('later')];h.state.data.days[to]=[];
  dragTrackedBlock(h,'later',from,to,600);
  h.commit(d=>trackingModel.startTracking(d,to,d.days[to][0],moveInstant('10:00:00'),'new-timer'),null,{recordUndo:false});
  h.commit(d=>trackingModel.pauseTracking(d,moveInstant('10:25:00'),'new-session'),null,{recordUndo:false});
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action:'undo'}})}});
  assert.equal(h.state.data.tracking.sessions.length,1);assert.equal(h.state.data.tracking.timer.startedAt,null);
  assert.equal(h.state.data.tracking.sessions[0].planDate,from);assert.equal(h.state.data.tracking.timer.planDate,from);
  assert.equal(h.state.data.tracking.sessions[0].endedAt-h.state.data.tracking.sessions[0].startedAt,25*60000);
  assert.equal(trackingModel.summarizeTracking(h.state.data.days[from],h.state.data.tracking.sessions,h.state.data.tracking.timer,from).actualMinutes,25);
});

test('cross-date moves do not adopt orphan records with the same destination block ID',async()=>{
  const h=harness(),from='2026-11-09',to='2026-11-10';h.state.date=from;
  h.state.data.days[from]=[moveBlock('reused')];h.state.data.days[to]=[];
  h.state.data.tracking={sessions:[moveSession('orphan',to,'reused','08:00:00','08:15:00'),moveSession('own',from,'reused','09:00:00','09:20:00')],timer:null};
  dragTrackedBlock(h,'reused',from,to,600);
  const movedId=h.state.data.days[to][0].id;
  assert.notEqual(movedId,'reused');
  assert.equal(h.state.data.tracking.sessions[0].blockId,'reused');assert.equal(h.state.data.tracking.sessions[1].blockId,movedId);
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action:'undo'}})}});
  assert.equal(h.state.data.tracking.sessions[0].planDate,to);assert.equal(h.state.data.tracking.sessions[1].planDate,from);
});

test('same-day and week-template moves leave actual record references untouched',()=>{
  const h=harness(),from='2026-11-09',to='2026-11-10';h.state.date=from;
  h.state.data.days[from]=[moveBlock('same')];
  h.state.data.tracking={sessions:[moveSession('record',from,'same','09:00:00','09:20:00')],timer:null};
  const before=JSON.stringify(h.state.data.tracking);
  dragTrackedBlock(h,'same',from,from,600);
  assert.equal(h.state.data.days[from][0].start,600);assert.equal(JSON.stringify(h.state.data.tracking),before);
  const template=h.state.data.weekTemplates[0];
  template.days=Array.from({length:7},()=>({templateId:null,templateName:'',blocks:[]}));
  template.days[0].blocks=[moveBlock('same')];h.state.weekTemplateId=template.id;
  dragTrackedBlock(h,'same',from,to,600);
  assert.equal(template.days[0].blocks.length,0);assert.equal(template.days[1].blocks[0].id,'same');
  assert.equal(JSON.stringify(h.state.data.tracking),before);
});

test('task completion can be toggled, saved, reopened, and undone without opening the editor', async () => {
  const writes=[];
  const h=harness(async (path,options)=>{
    writes.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({revision:2})};
  });
  h.state.tab='tasks';
  const task=h.state.data.tasks.find(t=>!t.done);
  const beforeSchedules=JSON.stringify([h.state.data.days,h.state.data.templates,h.state.data.cycle]);
  const click=action=>h.listeners.click[0]({target:{closest:()=>({dataset:{action,id:task.id}})}});
  await click('toggle-task');
  assert.equal(task.done,true);
  assert.equal(h.state.dirty,true);
  assert.equal(h.state.undo.length,1);
  assert.equal(h.context.lastModal,undefined);
  assert.match(h.taskCard(task),/aria-pressed="true"/);
  assert.match(h.taskCard(task),/<svg[^>]*[\s\S]*M5 12/);
  assert.equal(JSON.stringify([h.state.data.days,h.state.data.templates,h.state.data.cycle]),beforeSchedules);
  await h.save();
  assert.equal(writes[0].data.tasks.find(t=>t.id===task.id).done,true);
  assert.equal(h.state.dirty,false);
  await click('toggle-task');
  assert.equal(task.done,false);
  assert.match(h.taskCard(task),/aria-pressed="false"/);
  await click('undo');
  assert.equal(h.state.data.tasks.find(t=>t.id===task.id).done,true);
  assert.equal(h.state.dirty,true);
});

test('completing a scheduled one-off task exposes its checkmark and updates the task pool', async () => {
  const h=harness();
  h.state.date='2026-11-15';
  const task=h.state.data.tasks[0];task.reusable=false;task.done=false;
  h.state.data.days[h.state.date]=[{id:'completion-block',title:task.title,category:task.category,taskId:task.id,start:540,duration:30,done:false}];
  const click=()=>h.listeners.click[0]({target:{closest:()=>({dataset:{action:'toggle',id:'completion-block'}})}});
  await click();
  assert.equal(task.done,true);
  assert.equal(h.state.data.days[h.state.date][0].done,true);
  assert.match(h.timeline(),/data-action="toggle"[^>]*aria-pressed="true"[^>]*><svg/);
  await click();
  assert.equal(task.done,false);
  assert.match(h.timeline(),/data-action="toggle"[^>]*aria-pressed="false"[^>]*><\/button>/);
});

test('a delayed cloud read cannot erase a local edit made while it was in flight', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.refresh();
  h.commit(data => { data.tasks[0].title = 'New local edit'; });
  const remote = seedData();
  remote.tasks[0].title = 'Remote update';
  resolve({ ok: true, json: async () => ({ data: remote, revision: 2 }) });
  await pending;
  assert.equal(h.state.data.tasks[0].title, 'New local edit');
  assert.equal(h.state.revision, 1);
  assert.equal(h.state.dirty, true);
});

test('a cloud refresh does not replace the data underneath an open editor', async () => {
  let calls = 0;
  const h = harness(() => { calls++; throw Error('Should not fetch'); });
  h.modal.open = true;
  await h.refresh();
  assert.equal(calls, 0);
});

test('next-day midnight slot opens at 1440, not the default 09:00', async () => {
  const h = harness();
  const element = { dataset: { action: 'new-block', minute: '1440' } };
  await h.listeners.click[0]({ target: { closest() { return element; } } });
  assert.equal(h.context.lastForm.start, 1440);
});

test('dragging over an event overlay resolves the underlying 30-minute slot', () => {
  const h = harness();
  const timeline = { getBoundingClientRect() { return { top: -200 }; } };
  const eventOverlay = { closest(selector) { return selector === '.timeline' ? timeline : null; } };
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: 294 }), 810);
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: -201 }), null);
  assert.equal(h.dropMinute({ target: eventOverlay, clientY: 1048 }), null);
});

test('UUID fallback works without crypto.randomUUID on older browsers', () => {
  const h = harness();
  const ids = Array.from({ length: 100 }, () => h.uid());
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('invalid local edits cannot poison the synchronization queue', () => {
  const h = harness();
  h.commit(data => { data.tasks[0].duration = 45; });
  assert.equal(h.state.data.tasks[0].duration, 60);
  assert.equal(h.state.dirty, false);
  assert.equal(h.state.undo.length, 0);
});

test('calendar exports preserve Beijing times and reject nonexistent DST times', () => {
  const h = harness();
  assert.equal(h.utcDate('2026-11-14',540,'Asia/Shanghai'),'20261114T010000Z');
  assert.equal(h.utcDate('2026-11-14',1440,'Asia/Shanghai'),'20261114T160000Z');
  assert.throws(()=>h.utcDate('2027-03-14',150,'America/Los_Angeles'));
});


test('template notes autosave without repainting and group typing into one undo step', async () => {
 for(const [kind,key] of [['day','templates'],['week','weekTemplates']]){
  const writes=[];
  const h=harness(async(path,options)=>{writes.push(JSON.parse(options.body));return {ok:true,json:async()=>({revision:2})};});
  const template=h.state.data[key][0],before=JSON.stringify(h.state.data.cycle),description=template.description;
  const input={id:'template-notes',dataset:{kind,id:template.id},value:'第一条反馈'};
  assert.equal(h.saveTemplateNotes(input),true);
  input.value+='\n下一次：多留 30 分钟';assert.equal(h.saveTemplateNotes(input),true);
  assert.equal(template.notes,input.value);
  assert.equal(template.description,description);
  assert.equal(h.context.renderCount,0);
  assert.equal(h.state.undo.length,1);
  assert.equal(JSON.stringify(h.state.data.cycle),before);
  await h.save();
  assert.equal(writes[0].data[key][0].notes,input.value);
  h.dispatch('focusout',{target:input});
  input.value='';assert.equal(h.saveTemplateNotes(input),true);
  assert.equal(h.state.data[key][0].notes,'');
  assert.equal(h.state.undo.length,2);
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action:'undo'}})}});
  assert.equal(h.state.data[key][0].notes,writes[0].data[key][0].notes);
  input.value='x'.repeat(MAX_TEMPLATE_NOTES+1);
  assert.equal(h.saveTemplateNotes(input),false);
  assert.equal(h.state.data[key][0].notes,writes[0].data[key][0].notes);
 }
});

test('day and week template deletion requires confirmation, retains applied schedules, and is undoable', async () => {
 for(const [kind,key,action] of [['day','templates','delete-template'],['week','weekTemplates','delete-week-template']]){
  const h=harness(),template=h.state.data[key][0];template.notes='保留这条复盘记录';
  const savedTemplate=JSON.stringify(template);
  h.state.data.cycle.enabled=true;
  h.state.data.cycle.sourceWeekTemplateId=h.state.data.weekTemplates[0].id;
  h.state.data.days['2026-11-15']=structuredClone(h.state.data.templates[0].blocks);
  const schedules=JSON.stringify([h.state.data.days,h.state.data.templates.map(t=>t.blocks),h.state.data.cycle.days]);
  const appliedDay=JSON.stringify(h.state.data.days),cycleDays=JSON.stringify(h.state.data.cycle.days);
  const click=a=>h.listeners.click[0]({target:{closest:()=>({dataset:{action:a,id:template.id}})}});
  await click(action);
  assert.equal(h.state.data[key].some(t=>t.id===template.id),true);
  assert.equal(h.state.dirty,false);
  assert.match(h.context.lastModal.content,/确认删除/);
  await click('close');
  assert.equal(JSON.stringify([h.state.data.days,h.state.data.templates.map(t=>t.blocks),h.state.data.cycle.days]),schedules);
  await click(action);await click('confirm-'+action);
  assert.equal(h.state.data[key].some(t=>t.id===template.id),false);
  assert.equal(JSON.stringify(h.state.data.days),appliedDay);
  assert.equal(JSON.stringify(h.state.data.cycle.days),cycleDays);
  assert.equal(h.state.data.cycle.enabled,true);
  assert.equal(h.state.tab,'templates');assert.equal(h.state.templateKind,kind);
  await click('undo');
  assert.equal(JSON.stringify(h.state.data[key].find(t=>t.id===template.id)),savedTemplate);
 }
});

test('copied day and week templates retain independent notes and escape editor markup', async () => {
 for(const [kind,key,action] of [['day','templates','copy-template'],['week','weekTemplates','copy-week-template']]){
  const h=harness(),template=h.state.data[key][0];template.notes='</textarea><script>example</script>\n复盘';
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action,id:template.id}})}});
  const copy=h.state.data[key].at(-1);
  assert.notEqual(copy.id,template.id);assert.equal(copy.notes,template.notes);
  assert.equal(h.saveTemplateNotes({dataset:{kind,id:copy.id},value:'仅修改副本'}),true);
  assert.match(template.notes,/<script>/);
  const html=h.templateNotesPanel(kind,template);
  assert.match(html,/&lt;\/textarea&gt;&lt;script&gt;/);
  assert.equal(html.includes('<script>'),false);
 }
});

test('background refresh leaves a focused template note editor alone', async () => {
 let calls=0;const h=harness(()=>{calls++;throw Error('Unexpected refresh');});
 h.context.document.activeElement={id:'template-notes'};
 await h.refresh();assert.equal(calls,0);
});

test('day and week template descriptions remain editable without changing inline names, notes or saved schedules',async()=>{
 for(const [collection,action,formId,mode] of [['templates','rename-template','template-form','rename'],['weekTemplates','week-template-meta','week-template-form','meta']]){
  const h=harness(),template=h.state.data[collection][0];template.notes='继续保留这条复盘';
  const before=JSON.stringify([template.blocks||template.days,h.state.data.days,h.state.data.cycle]),name=template.name;
  h.state.tab='templates';h.state.templateId=null;h.state.weekTemplateId=null;
  await h.listeners.click[0]({target:{closest:()=>({dataset:{action,id:template.id}})}});
  assert.match(h.context.lastModal.content,new RegExp('data-id="'+template.id+'"'));
  assert.equal(h.context.lastModal.content.includes('name="name"'),false,'the description dialog no longer duplicates inline renaming');
  const form={id:formId,dataset:{id:template.id,mode},values:{name:'不应采用这个隐藏名称',description:'  新的描述  '}};
  await h.listeners.submit[0]({target:form,preventDefault(){}});
  assert.equal(template.name,name);assert.equal(template.description,'新的描述');assert.equal(template.notes,'继续保留这条复盘');
  assert.equal(JSON.stringify([template.blocks||template.days,h.state.data.days,h.state.data.cycle]),before);
  assert.equal(h.state.templateId,null);assert.equal(h.state.weekTemplateId,null);
 }
});

test('editing a group saves the completion toggle and immediately changes the daily completion summary',async()=>{
 const h=harness();h.state.date='2026-11-16';h.state.data.days[h.state.date]=[
  {id:'work',title:'工作',category:'work',start:540,duration:60,done:true},
  {id:'life',title:'生活',category:'life',start:600,duration:60,done:false},
 ];
 const form={id:'group-form',dataset:{id:'life'},values:{name:'生活',color:'#638b73'}};
 await h.listeners.submit[0]({target:form,preventDefault(){}});
 assert.equal(h.state.data.groups.find(g=>g.id==='life').countTowardsCompletion,false);
 assert.match(h.timeline(),/1 \/ 1 项计入完成度/);
 form.values.countTowardsCompletion='on';await h.listeners.submit[0]({target:form,preventDefault(){}});
 assert.match(h.timeline(),/1 \/ 2 项计入完成度/);
});


test('a save conflict preserves the focused notes input and defers its banner until blur', async () => {
 const h=harness(async()=>({status:409}));
 const input={id:'template-notes',dataset:{kind:'day',id:h.state.data.templates[0].id},value:'正在复盘，保留光标'};
 h.context.document.activeElement=input;
 h.saveTemplateNotes(input);await h.save();
 assert.equal(h.state.conflict,true);
 assert.equal(h.context.renderCount,0);
 assert.equal(h.state.data.templates[0].notes,input.value);
 const callbacks=[];h.context.setTimeout=fn=>callbacks.push(fn);
 h.dispatch('focusout',{target:input});
 h.context.document.activeElement=null;
 callbacks.forEach(fn=>fn());
 assert.equal(h.context.renderCount,1);
 assert.equal(h.state.data.templates[0].notes,input.value);
});
