import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as model from '../lib/tracking.mjs';
import {seedData,validateData,resolveDay,materializeDay,addDays,mondayOf,planningDate} from '../lib/planner.mjs';

const date='2026-11-15',instant=Date.parse(date+'T10:10:00Z');
const block={id:'study',title:'学习 <笔记>',category:'learn',start:600,duration:60,done:false};
function harness(){
  const data=seedData();data.timezone='UTC';data.days[date]=[{...block}];
  const state={data,date,tab:'day',viewMode:'plan',weekViewMode:'compare',weekFilter:'all'};
  let next=0,closed=0,renders=0,lastModal,lastToast,writes=0;
  const error={textContent:''},elapsed={textContent:''},metrics={innerHTML:'',dataset:{scope:'day'}},layer={innerHTML:'',dataset:{actualDate:date,actualKind:'day'},contains:()=>false};
  const context=vm.createContext({model,now:instant,localStorage:{setItem(){}},FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key];}},document:{activeElement:null,querySelector:s=>s==='#actual-error'||s==='#new-timer-error'?error:s==='#modal'?{open:false}:null,querySelectorAll:s=>s==='[data-timer-elapsed]'?[elapsed]:s==='[data-tracking-metrics]'?[metrics]:s==='[data-actual-date]'?[layer]:[]}});
  vm.runInContext('class Clock extends Date {constructor(...args){super(...(args.length?args:[globalThis.now]));}static now(){return globalThis.now;}};globalThis.Date=Clock;',context);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const h={getState:()=>state,resolveDay,materializeDay,addDays,mondayOf,planningDate,esc,icon:()=>'',uid:()=>`new-${++next}`,btn:(a,t,c='',attrs='')=>`<button class="${c}" data-action="${a}" ${attrs}>${t}</button>`,render:()=>renders++,close:()=>closed++,modal:(title,body)=>lastModal={title,body},toast:t=>lastToast=t,commit:fn=>{const old=structuredClone(state.data);try{fn(state.data);assert.equal(validateData(state.data),true);}catch(e){state.data=old;throw e;}writes++;return true;}};
  context.h=h;
  vm.runInContext(readFileSync(new URL('../web/tracking.js',import.meta.url),'utf8').replace(/^export /gm,'')+'\nglobalThis.ui=createTrackingUI(h,model);',context);
  return {state,context,ui:context.ui,error,elapsed,metrics,layer,get writes(){return writes;},get renders(){return renders;},get closed(){return closed;},get lastModal(){return lastModal;},get lastToast(){return lastToast;},action:(a,id='study',d=date)=>context.ui.action(a,id,{dataset:{date:d}}),form:(values,id='')=>({id:'actual-record-form',dataset:{id,date},values})};
}
test('weekly statistics can collapse while view, quick timer and manual-entry actions stay outside the folded content',()=>{
 const h=harness(),collapsed=h.ui.summary(true),contentAt=collapsed.indexOf('id="week-statistics-content"');
 assert.match(collapsed,/data-stats-expanded="false"/);
 assert.match(collapsed,/data-action="week-stats-toggle"[^>]*aria-expanded="false"/);
 for(const action of ['tracking-view','timer-new','actual-new'])assert.ok(collapsed.indexOf('data-action="'+action+'"')<contentAt,action);
 h.state.weekStatsExpanded=true;
 assert.match(h.ui.summary(true),/data-action="week-stats-toggle"[^>]*aria-expanded="true"/);
 assert.match(h.ui.summary(true),/data-tracking-metrics data-scope="week"/);
 assert.doesNotMatch(h.ui.summary(false),/week-stats-toggle|week-statistics-content/);
 assert.equal(h.writes,0);
});
test('timer UI persists pause segments, excludes breaks, refreshes live DOM without writes, and does not auto-complete',()=>{
  const h=harness();h.action('timer-start');h.context.now+=12000;h.ui.tick();
  assert.equal(h.elapsed.textContent,'00:00:12');assert.match(h.metrics.innerHTML,/0.2 分钟/);assert.match(h.layer.innerHTML,/actual-event/);assert.equal(h.writes,1);assert.equal(h.renders,0);
  h.action('timer-pause');h.context.now+=30000;h.ui.tick();assert.equal(h.elapsed.textContent,'00:00:12');
  h.action('timer-resume');h.context.now+=18000;h.action('timer-stop');
  assert.equal(h.state.data.tracking.sessions.length,2);assert.equal(h.state.data.tracking.timer,null);
  assert.equal(model.summarizeTracking(h.state.data.days[date],h.state.data.tracking.sessions,null,date).actualMinutes,.5);
  assert.equal(h.state.data.days[date][0].done,false);assert.match(h.lastModal.body,/标记完成/);
  h.action('timer-complete');assert.equal(h.state.data.days[date][0].done,true);
});
test('one active or paused timer blocks a second start and mode switching never changes data',()=>{
  const h=harness();h.action('timer-start');const timer=structuredClone(h.state.data.tracking.timer);
  h.action('timer-start');assert.match(h.lastToast,/先结束/);assert.deepEqual(h.state.data.tracking.timer,timer);
  h.context.now+=1000;h.action('timer-pause');h.action('timer-start');assert.equal(h.state.data.tracking.timer.startedAt,null);
  const before=JSON.stringify(h.state.data);h.action('tracking-view','compare');assert.equal(h.state.viewMode,'compare');assert.equal(JSON.stringify(h.state.data),before);
});
test('week and day view choices persist independently and label the execution lane consistently',()=>{
  const h=harness(),saved=new Map();
  h.context.localStorage.setItem=(key,value)=>saved.set(key,value);
  assert.match(h.ui.summary(true),/data-id="compare" aria-pressed="true">计划＋执行/);
  h.state.tab='week';h.action('tracking-view','actual');
  assert.equal(saved.get('weekprofiler-week-view-mode'),'actual');
  assert.equal(h.state.viewMode,'plan');
  h.state.tab='day';h.action('tracking-view','compare');
  assert.equal(saved.get('weekprofiler-view-mode'),'compare');
  assert.match(h.ui.summary(true),/data-id="actual" aria-pressed="true">执行/);
  assert.equal(h.state.weekViewMode,'actual');
});

test('manual actual record keeps precise minutes, blocks overlap/future intervals and displays nearest-half-hour cards',()=>{
  const h=harness();h.context.now=Date.parse(date+'T13:00:00Z');
  h.ui.submit(h.form({blockId:'study',startedAt:date+'T10:10:00',endedAt:date+'T10:50:00'}));
  assert.equal(h.state.data.tracking.sessions.length,1);assert.match(h.ui.summary(),/时长覆盖率<\/small><strong>66.7%/);
  const html=h.ui.renderActualEvents(date);assert.match(html,/top:313px;height:49px/);assert.match(html,/学习 &lt;笔记&gt;/);
  h.ui.submit(h.form({blockId:'study',startedAt:date+'T10:40:00',endedAt:date+'T11:00:00'}));assert.match(h.error.textContent,/重叠/);assert.equal(h.state.data.tracking.sessions.length,1);
  h.ui.submit(h.form({blockId:'study',startedAt:date+'T13:00:00',endedAt:date+'T14:00:00'}));assert.match(h.error.textContent,/当前时间/);
});
test('saving unchanged second-occurrence DST fields preserves exact epoch milliseconds',()=>{
  const h=harness();h.state.data.timezone='America/Los_Angeles';
  const session={id:'dst',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse('2026-11-01T09:10:00.123Z'),endedAt:Date.parse('2026-11-01T09:40:00.456Z')};
  h.state.data.tracking={sessions:[{...session}],timer:null};
  h.ui.submit(h.form({blockId:'study',startedAt:'2026-11-01T01:10:00',endedAt:'2026-11-01T01:40:00'},'dst'));
  assert.equal(h.error.textContent,'');assert.equal(h.state.data.tracking.sessions[0].startedAt,session.startedAt);assert.equal(h.state.data.tracking.sessions[0].endedAt,session.endedAt);
});
test('short sessions at the same rounded instant use separate clickable visual lanes',()=>{
  const h=harness();h.state.data.tracking={sessions:[{id:'a',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse(date+'T06:01:00Z'),endedAt:Date.parse(date+'T06:02:00Z')},{id:'b',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse(date+'T06:03:00Z'),endedAt:Date.parse(date+'T06:04:00Z')}],timer:null};
  const html=h.ui.renderActualEvents(date);assert.match(html,/left:calc\(0% \+ 4px\);width:calc\(50%/);assert.match(html,/left:calc\(50% \+ 4px\)/);
  assert.equal((html.match(/data-action="actual-edit"/g)||[]).length,2);
  assert.equal((html.match(/class="actual-event[^"]*is-point/g)||[]).length,2);
  assert.equal((html.match(/height:18px/g)||[]).length,2);
});

test('actual matching metadata keeps distinct exact starts when both cards round to the same half hour',()=>{
  const h=harness();h.state.data.days[date][0].taskId='task-read';
  h.state.data.tracking={sessions:[['a','06:01:03.125','06:02:00.000'],['b','06:03:04.875','06:04:00.000']].map(([id,start,end])=>({id,planDate:date,blockId:'study',title:'旧名称',category:'work',startedAt:Date.parse(date+'T'+start+'Z'),endedAt:Date.parse(date+'T'+end+'Z')})),timer:null};
  const before=JSON.stringify(h.state.data),html=h.ui.renderActualEvents(date);
  const starts=[...html.matchAll(/data-link-start="([^"]+)"/g)].map(match=>Number(match[1]));
  assert.equal((html.match(/top:105px/g)||[]).length,2,'both visible starts round to 06:00');
  assert.equal(starts.length,2);assert.ok(Math.abs(starts[0]-(361+3125/60000))<1e-9);assert.ok(Math.abs(starts[1]-(363+4875/60000))<1e-9);
  assert.equal((html.match(/data-link-date="2026-11-15"/g)||[]).length,2);
  assert.equal((html.match(/data-link-task="task-read"/g)||[]).length,2);
  assert.equal((html.match(/data-link-title="学习 &lt;笔记&gt;"/g)||[]).length,2);
  assert.equal((html.match(/data-link-category="learn"/g)||[]).length,2);
  assert.equal(JSON.stringify(h.state.data),before,'matching metadata is derived, never persisted');
});

test('actual matching uses the displayed 04:00 day while preserving its original plan reference',()=>{
  const h=harness();h.state.data.timezone='Asia/Shanghai';
  h.state.data.tracking={sessions:[{id:'cross-day',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse('2026-11-15T19:50:10.250Z'),endedAt:Date.parse('2026-11-15T20:10:00Z')}],timer:null};
  const previous=h.ui.renderActualEvents(date),next=h.ui.renderActualEvents('2026-11-16');
  assert.match(previous,/data-link-date="2026-11-15"/);assert.match(next,/data-link-date="2026-11-16"/);
  assert.match(previous,/data-plan-date="2026-11-15" data-plan-block="study"/);assert.match(next,/data-plan-date="2026-11-15" data-plan-block="study"/);
  assert.ok(Math.abs(Number(previous.match(/data-link-start="([^"]+)"/)[1])-(1670+10250/60000))<1e-9);
  assert.match(next,/data-link-start="240"/,'the new display day starts at its clipped 04:00 boundary');
});

test('cross-day pieces share one record identity and original instant for both sessions and live timers',()=>{
  for(const live of [false,true]){
    const h=harness();h.state.data.timezone='Asia/Shanghai';
    const startedAt=Date.parse('2026-11-15T19:50:10.250Z'),boundary=Date.parse('2026-11-15T20:00:00Z'),endedAt=boundary+600000;
    const record={id:'cross-day',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt};
    h.state.data.tracking={sessions:live?[]:[{...record,endedAt}],timer:live?record:null};h.context.now=endedAt;
    const pieces=[h.ui.renderActualEvents(date),h.ui.renderActualEvents('2026-11-16')];
    for(const html of pieces){
      assert.match(html,new RegExp('data-link-record="'+(live?'timer:':'session:')+'cross-day"'));
      assert.equal(Number(html.match(/data-link-instant="([^"]+)"/)[1]),startedAt);
    }
    assert.equal(Number(pieces[0].match(/data-link-segment="([^"]+)"/)[1]),startedAt);
    assert.equal(Number(pieces[1].match(/data-link-segment="([^"]+)"/)[1]),boundary);
  }
});

test('actual matching metadata escapes IDs and uses record fallback for missing plans and temporary tasks',()=>{
  const h=harness(),unsafe='id" <&\' task',taskId='task" <&\' id';
  h.state.data.days[date][0]={...block,id:unsafe,taskId,title:'任务 "<&\'',category:'group" <&\''};
  h.state.data.tracking={sessions:[{id:unsafe,planDate:date,blockId:unsafe,title:'记录旧名称',category:'work',startedAt:instant,endedAt:instant+60000}],timer:null};
  const linked=h.ui.renderActualEvents(date);
  assert.match(linked,/data-id="id&quot; &lt;&amp;&#39; task"/);assert.match(linked,/data-plan-block="id&quot; &lt;&amp;&#39; task"/);
  assert.match(linked,/data-link-record="session:id&quot; &lt;&amp;&#39; task"/);
  assert.match(linked,/data-link-task="task&quot; &lt;&amp;&#39; id"/);assert.match(linked,/data-link-title="任务 &quot;&lt;&amp;&#39;"/);assert.match(linked,/data-link-category="group&quot; &lt;&amp;&#39;"/);
  assert.match(linked,/data-link-origin="true"/);
  h.state.data.days[date]=[];
  const deleted=h.ui.renderActualEvents(date);assert.match(deleted,/data-link-origin="false"/);assert.doesNotMatch(deleted,/data-unplanned=/);
  h.state.data.tracking.sessions[0].unplanned=true;
  const temporary=h.ui.renderActualEvents(date);
  assert.match(temporary,/data-link-task=""/);assert.match(temporary,/data-link-origin="false"/);assert.match(temporary,/data-link-title="记录旧名称"/);assert.match(temporary,/data-link-category="work"/);assert.match(temporary,/data-unplanned="true"/);
});


test('card labels use rounded clocks while tooltip and editor retain precise clocks',()=>{
  const h=harness();h.state.data.tracking={sessions:[{id:'long',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse(date+'T06:20:00Z'),endedAt:Date.parse(date+'T07:40:00Z')}],timer:null};
  const html=h.ui.renderActualEvents(date);
  assert.match(html,/<small>06:30–07:30<\/small>/);
  assert.match(html,/title="[^"]*06:20:00[^"]*07:40:00/);
  assert.match(html,/top:131px;height:49px/);
  h.action('actual-edit','long');assert.match(h.lastModal.body,/value="2026-11-15T06:20:00"/);assert.match(h.lastModal.body,/value="2026-11-15T07:40:00"/);
  assert.equal(model.summarizeTracking(h.state.data.days[date],h.state.data.tracking.sessions,null,date).actualMinutes,80);
});

test('rounded markers at the ending 04:00 stay inside the visible timeline and remain editable',()=>{
  const h=harness();h.state.data.tracking={sessions:[{id:'boundary',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse('2026-11-16T03:50:00Z'),endedAt:Date.parse('2026-11-16T04:10:00Z')}],timer:null};
  for(const displayedDate of [date,'2026-11-16']){
    const html=h.ui.renderActualEvents(displayedDate),position=html.match(/top:([\d.]+)px;height:([\d.]+)px/);
    assert.match(html,/class="actual-event[^"]*is-point/);assert.match(html,/data-action="actual-edit" data-id="boundary"/);
    assert.ok(position);assert.ok(Number(position[1])>=0);assert.ok(Number(position[1])+Number(position[2])<=1248);
  }
});

const newTimerForm=(title='临时 <整理>',category='learn',tagId)=>({id:'new-timer-form',dataset:{},values:{title,category,...(tagId===undefined?{}:{tagId})}});

test('weekly quick timer adds only actual time, retaining its identity across pause, resume and stop',()=>{
  const h=harness();h.state.tab='week';
  const plans=JSON.stringify(h.state.data.days),tasks=JSON.stringify(h.state.data.tasks);
  assert.match(h.ui.summary(true),/data-action="timer-new"/);
  assert.doesNotMatch(h.ui.summary(false),/data-action="timer-new"/);
  h.state.weekFilter='learn';h.state.weekViewMode='plan';h.action('timer-new');
  assert.equal(h.lastModal.title,'新建并计时');assert.match(h.lastModal.body,/value="learn" selected/);
  assert.equal(h.writes,0,'opening the form must not start the timer');
  h.ui.submit(newTimerForm('  临时 <整理>  '));
  const timer=h.state.data.tracking.timer;
  assert.equal(timer.unplanned,true);assert.equal(timer.title,'临时 <整理>');assert.equal(timer.startedAt,instant);
  assert.equal(h.state.tab,'week');assert.equal(h.state.weekViewMode,'compare');assert.equal(h.state.viewMode,'plan');
  assert.match(h.ui.bar(),/临时 &lt;整理&gt;/);
  h.context.now+=12000;h.action('timer-pause');
  h.context.now+=30000;h.action('timer-resume');
  h.context.now+=18000;h.action('timer-stop');
  assert.equal(h.state.data.tracking.timer,null);
  assert.equal(h.state.data.tracking.sessions.length,2);
  for(const s of h.state.data.tracking.sessions){assert.equal(s.unplanned,true);assert.equal(s.blockId,timer.blockId);}
  assert.equal(h.state.data.tracking.sessions.reduce((n,s)=>n+s.endedAt-s.startedAt,0),30000);
  assert.equal(JSON.stringify(h.state.data.days),plans);assert.equal(JSON.stringify(h.state.data.tasks),tasks);
  assert.doesNotMatch(h.lastModal.body,/data-action="timer-complete"/,'an unplanned timer has no plan completion to toggle');
  const stats=model.summarizeTracking(h.state.data.days[date],h.state.data.tracking.sessions,null,date);
  assert.equal(stats.actualMinutes,.5);assert.equal(stats.plannedMinutes,60);assert.equal(stats.deficitMinutes,60);
});

test('quick timer from an old week uses the current timezone planning date and keeps actual mode',()=>{
  for(const [now,expected] of [['2026-11-15T19:59:59Z','2026-11-15'],['2026-11-15T20:00:00Z','2026-11-16']]){
    const h=harness();h.state.date='2026-10-01';h.state.tab='week';h.state.weekViewMode='actual';h.state.data.timezone='Asia/Shanghai';h.context.now=Date.parse(now);
    h.action('timer-new');assert.match(h.lastModal.body,new RegExp(expected));
    h.ui.submit(newTimerForm());
    assert.equal(h.state.data.tracking.timer.planDate,expected);assert.equal(h.state.date,expected);
    assert.equal(h.state.weekViewMode,'actual');assert.equal(h.state.data.tracking.timer.startedAt,Date.parse(now));
  }
});

test('quick timer blocks a running or paused timer, including stale form submissions',()=>{
  for(const paused of [false,true]){
    const h=harness();h.action('timer-start');
    if(paused){h.context.now+=1000;h.action('timer-pause');}
    const before=JSON.stringify(h.state.data),writes=h.writes;
    h.action('timer-new');assert.match(h.lastToast,/先结束/);
    h.ui.submit(newTimerForm());assert.match(h.error.textContent,/先结束/);
    assert.equal(JSON.stringify(h.state.data),before);assert.equal(h.writes,writes);
  }
});

test('invalid quick timer names and groups never change tasks, plans or tracking',()=>{
  for(const [title,category] of [['   ','learn'],['x'.repeat(101),'learn'],['学习','missing']]){
    const h=harness(),before=JSON.stringify(h.state.data);
    h.ui.submit(newTimerForm(title,category));
    assert.ok(h.error.textContent);assert.equal(h.writes,0);assert.equal(h.closed,0);assert.equal(JSON.stringify(h.state.data),before);
  }
});

test('editing an unplanned actual record retains its marker and precise timestamp',()=>{
  const h=harness();h.ui.submit(newTimerForm());h.context.now+=60000;h.action('timer-stop');
  const record=h.state.data.tracking.sessions[0];
  h.action('actual-edit',record.id);assert.match(h.lastModal.body,/临时任务/);assert.doesNotMatch(h.lastModal.body,/计划已移除/);
  h.ui.submit(h.form({blockId:record.blockId,startedAt:date+'T10:10:01',endedAt:date+'T10:10:59'},record.id));
  const edited=h.state.data.tracking.sessions[0];
  assert.equal(h.error.textContent,'');assert.equal(edited.unplanned,true);assert.equal(edited.blockId,record.blockId);
  assert.equal(edited.startedAt,instant+1000);assert.equal(edited.endedAt,instant+59000);
});

test('temporary timing selects an independent project and label, keeping that label through history edits',()=>{
  const h=harness();h.state.data.tags.push({id:'deep-focus',name:'深度 <专注>',color:'#123abc'});
  h.state.tab='week';h.state.weekFilter='learn';h.state.weekTagFilter='deep-focus';h.state.tagFilter='rest';h.action('timer-new');
  assert.match(h.lastModal.body,/项目分组/);assert.match(h.lastModal.body,/<select id="timer-category" name="category"/);
  assert.match(h.lastModal.body,/<select id="timer-tag" name="tagId"/);assert.match(h.lastModal.body,/value="deep-focus" selected/);
  h.ui.submit(newTimerForm('临时专注','learn','deep-focus'));
  assert.equal(h.state.data.tracking.timer.category,'learn');assert.equal(h.state.data.tracking.timer.tagId,'deep-focus');
  h.context.now+=60000;h.action('timer-stop');
  const record=h.state.data.tracking.sessions[0];assert.equal(record.tagId,'deep-focus');
  const html=h.ui.renderActualEvents(date);assert.match(html,/--actual-color:#123abc/);assert.match(html,/data-link-category="learn"/);assert.match(html,/深度 &lt;专注&gt; · 学习/);
  h.ui.submit(h.form({blockId:record.blockId,startedAt:date+'T10:10:01',endedAt:date+'T10:10:59'},record.id));
  assert.equal(h.error.textContent,'');assert.equal(h.state.data.tracking.sessions[0].tagId,'deep-focus');assert.equal(h.state.data.tracking.sessions[0].unplanned,true);
});

test('invalid temporary labels are rejected without modifying tracking or plans',()=>{
  for(const tagId of ['','missing']){
    const h=harness(),before=JSON.stringify(h.state.data);h.ui.submit(newTimerForm('临时专注','learn',tagId));
    assert.match(h.error.textContent,/有效标签/);assert.equal(h.writes,0);assert.equal(JSON.stringify(h.state.data),before);
  }
});

test('manual records copy the selected task label, preserve historical labels, and adopt a reassigned task label',()=>{
  const h=harness();h.context.now=Date.parse(date+'T13:00:00Z');
  h.state.data.days[date][0].tagId='rest';h.state.data.days[date].push({...block,id:'second',title:'另一项',start:720,tagId:'learn'});
  const fields={blockId:'study',startedAt:date+'T10:10:00',endedAt:date+'T10:50:00'};
  h.ui.submit(h.form(fields));const id=h.state.data.tracking.sessions[0].id;assert.equal(h.state.data.tracking.sessions[0].tagId,'rest');
  h.state.data.days[date][0].tagId='life';h.ui.submit(h.form(fields,id));assert.equal(h.state.data.tracking.sessions[0].tagId,'rest');
  h.ui.submit(h.form({...fields,blockId:'second'},id));assert.equal(h.error.textContent,'');assert.equal(h.state.data.tracking.sessions[0].tagId,'learn');
});

test('actual label colors and completion exclusions remain independent of project identity',()=>{
  const h=harness();h.state.data.days[date][0]={...block,taskId:'task-read',tagId:'learn',done:true};
  h.state.data.days[date].push({...block,id:'resting',start:720,tagId:'rest'});h.state.data.tags.find(tag=>tag.id==='rest').countTowardsCompletion=false;
  const summary=h.ui.summary();assert.match(summary,/<strong>100%<\/strong>/);assert.match(summary,/1 \/ 1 项完成 · 1 项不计入/);
  h.state.data.tracking={sessions:[{id:'record',planDate:date,blockId:'study',title:block.title,category:'learn',tagId:'rest',startedAt:instant,endedAt:instant+60000}],timer:null};
  const html=h.ui.renderActualEvents(date),rest=h.state.data.tags.find(tag=>tag.id==='rest');
  assert.match(html,new RegExp('--actual-color:'+rest.color));assert.match(html,/data-link-task="task-read"/);assert.match(html,/data-link-category="learn"/);
  h.state.data.tracking.sessions[0].tagId='deleted-label';const removed=h.ui.renderActualEvents(date);
  assert.match(removed,/已移除标签/);assert.match(removed,/--actual-color:#8a958b/);assert.match(removed,/data-link-category="learn"/);
});

test('weekly actual cards combine label and project filters without changing their recorded identity',()=>{
  const h=harness();h.state.tab='week';
  h.state.data.days[date]=[
    {...block,tagId:'learn'},
    {...block,id:'same-project',start:720,tagId:'rest'},
    {...block,id:'other-project',start:840,category:'rest',tagId:'learn'},
  ];
  h.state.data.tracking={sessions:h.state.data.days[date].map((item,index)=>({id:'record-'+index,planDate:date,blockId:item.id,title:item.title,category:item.category,tagId:item.tagId,startedAt:instant+index*120000,endedAt:instant+index*120000+60000})),timer:null};
  const before=JSON.stringify(h.state.data);
  const dimmed=()=>Object.fromEntries([...h.ui.renderActualEvents(date,'week').matchAll(/<button[^>]*class="([^"]+)"[^>]*data-id="([^"]+)"/g)].map(([,cls,id])=>[id,cls.includes('is-dimmed')]));
  h.state.weekFilter='all';h.state.weekTagFilter='learn';
  assert.deepEqual(dimmed(),{'record-0':false,'record-1':true,'record-2':false},'labels span projects but distinguish tasks inside one project');
  h.state.weekFilter='learn';assert.deepEqual(dimmed(),{'record-0':false,'record-1':true,'record-2':true});
  h.state.weekFilter='rest';h.state.weekTagFilter='all';assert.deepEqual(dimmed(),{'record-0':true,'record-1':true,'record-2':false});
  assert.doesNotMatch(h.ui.renderActualEvents(date,'day'),/is-dimmed/,'weekly filters do not leak into the day view');
  assert.equal(JSON.stringify(h.state.data),before);
});

test('manual recording keeps the specified date and occurrence among same-name tasks',()=>{
  const h=harness(),planDate='2026-11-14';
  h.state.data.days[planDate]=[{...block,id:'late',start:1410,duration:120},{...block,id:'early',start:540,duration:60}];
  h.action('actual-new','late',planDate);
  const body=h.lastModal.body;
  assert.match(body,/value="late" selected>23:30 · 学习 &lt;笔记&gt;/);
  assert.ok(body.indexOf('value="early"')<body.indexOf('value="late"'),'same-name choices are sorted by planned start');
  assert.match(body,/value="early">09:00 · 学习 &lt;笔记&gt;/);
  const startedAt=body.match(/id="actual-start"[^>]*value="([^"]+)"/)[1],endedAt=body.match(/id="actual-end"[^>]*value="([^"]+)"/)[1];
  assert.equal(startedAt,'2026-11-14T23:30:00');assert.equal(endedAt,'2026-11-15T01:30:00');
  h.ui.submit({id:'actual-record-form',dataset:{id:'',date:planDate},values:{blockId:'late',startedAt,endedAt}});
  assert.equal(h.error.textContent,'');assert.equal(h.state.data.tracking.sessions[0].planDate,planDate);assert.equal(h.state.data.tracking.sessions[0].blockId,'late');
  assert.equal(h.state.data.tracking.sessions[0].endedAt-h.state.data.tracking.sessions[0].startedAt,120*60000);
});

test('new actual defaults use complete local planned intervals including next-day starts and the 04:00 end',()=>{
  for(const [start,duration,expectedStart,expectedEnd] of [
    [600,60,'2026-11-15T10:00:00','2026-11-15T11:00:00'],
    [1500,120,'2026-11-16T01:00:00','2026-11-16T03:00:00'],
    [1650,30,'2026-11-16T03:30:00','2026-11-16T04:00:00'],
  ]){
    const h=harness();h.state.data.timezone='Asia/Shanghai';h.state.data.days[date]=[{...block,start,duration}];
    const before=JSON.stringify(h.state.data);h.action('actual-new','');
    const body=h.lastModal.body;assert.match(body,/value="study" selected/);
    assert.equal(body.match(/id="actual-start"[^>]*value="([^"]+)"/)[1],expectedStart);
    assert.equal(body.match(/id="actual-end"[^>]*value="([^"]+)"/)[1],expectedEnd);
    if(start>=1440)assert.match(body,/selected>次日 /);
    assert.equal(JSON.stringify(h.state.data),before,'opening defaults does not materialize or alter plans');
  }
});

test('editing actual records retains exact seconds and clearly labels orphan or temporary entries with no plan time',()=>{
  const h=harness(),session={id:'old',planDate:date,blockId:'study',title:block.title,category:'learn',startedAt:Date.parse(date+'T10:10:25.123Z'),endedAt:Date.parse(date+'T10:39:43.456Z')};
  h.state.data.tracking={sessions:[{...session}],timer:null};h.state.data.days[date][0].start=720;
  h.action('actual-edit','old');assert.match(h.lastModal.body,/id="actual-start"[^>]*value="2026-11-15T10:10:25"/);assert.match(h.lastModal.body,/id="actual-end"[^>]*value="2026-11-15T10:39:43"/);
  h.state.data.days[date]=[];h.action('actual-edit','old');assert.match(h.lastModal.body,/无计划时间 · 学习 &lt;笔记&gt;/);assert.match(h.lastModal.body,/（计划已移除）/);
  h.state.data.tracking.sessions[0].unplanned=true;h.action('actual-edit','old');assert.match(h.lastModal.body,/无计划时间 · 学习 &lt;笔记&gt;/);assert.match(h.lastModal.body,/（临时任务）/);
  assert.equal(h.state.data.tracking.sessions[0].startedAt,session.startedAt);assert.equal(h.state.data.tracking.sessions[0].endedAt,session.endedAt);
});

function repeatedDayHarness(){
  const h=harness(),planDate='2026-11-16';h.state.date=planDate;h.state.data.timezone='Asia/Shanghai';
  const local=clock=>model.parseTimeInput(planDate+'T'+clock,h.state.data.timezone);
  h.context.now=local('20:00:00');
  h.state.data.days[planDate]=[
    {...block,id:'morning',taskId:'task-read',start:540,tagId:'learn'},
    {...block,id:'afternoon',taskId:'task-read',start:900,tagId:'life'},
  ];
  h.state.data.tracking={sessions:[
    {id:'morning-record',planDate,blockId:'morning',title:block.title,category:'learn',tagId:'learn',startedAt:local('09:05:12')+123,endedAt:local('10:05:12')+123},
    {id:'afternoon-record',planDate,blockId:'morning',title:block.title,category:'learn',tagId:'rest',startedAt:local('15:12:34')+567,endedAt:local('16:12:34')+567},
  ],timer:null};
  return {h,planDate};
}

test('coverage weights days by planned minutes and skips an unfilled tag slot in all tracking entry points',()=>{
  const h=harness(),slot={kind:'tag-slot',id:'later',tagId:'learn',start:720,duration:60};
  h.state.data.days[date].push(slot);
  h.state.data.days[addDays(date,-1)]=[{...block,id:'yesterday',duration:120}];
  h.state.data.tracking={sessions:[{id:'record',planDate:date,blockId:block.id,title:block.title,category:block.category,
    startedAt:instant-90*60000,endedAt:instant}],timer:null};
  assert.match(h.ui.summary(),/时长覆盖率<\/small><strong>100%/);
  assert.match(h.ui.summary(true),/时长覆盖率<\/small><strong>33.3%/);
  h.action('tracking-details');
  assert.match(h.lastModal.body,/<th>时长覆盖率<\/th>/);
  assert.match(h.lastModal.body,/<td>90 分钟<\/td><td>100%/);
  assert.equal(h.ui.timerButton(slot,date),'');
  assert.equal(h.ui.blockTools(slot,date),'');
  h.action('timer-start',slot.id);h.action('toggle-week',slot.id);
  assert.equal(h.writes,0);
  h.action('actual-new');
  assert.doesNotMatch(h.lastModal.body,/value="later"/);
  h.state.data.days[date]=[slot];
  assert.match(h.ui.summary(),/时长覆盖率<\/small><strong>—/);
  h.action('actual-new');
  assert.match(h.lastToast,/请先为这一天安排任务/);
});
function shownRecordValues(body){return {
  blockId:body.match(/<option value="([^"]+)" selected>/)[1],
  startedAt:body.match(/id="actual-start"[^>]*value="([^"]+)"/)[1],
  endedAt:body.match(/id="actual-end"[^>]*value="([^"]+)"/)[1],
};}

test('repeated same-task legacy records agree across per-plan totals, history, editor and visible link owner',()=>{
  const {h,planDate}=repeatedDayHarness(),before=JSON.stringify(h.state.data);
  for(const planned of h.state.data.days[planDate]){
    const tools=h.ui.blockTools(planned,planDate);assert.match(tools,/<strong>执行 60 分钟<\/strong>/);assert.match(tools,/已覆盖 60 分钟 · 覆盖率 100%/);
  }
  assert.match(h.ui.summary(),/<strong>120 分钟<\/strong>/);assert.match(h.ui.summary(),/已覆盖 120 分钟/);
  h.action('actual-history','afternoon',planDate);
  assert.match(h.lastModal.body,/data-id="afternoon-record"/);assert.doesNotMatch(h.lastModal.body,/data-id="morning-record"/);
  h.action('actual-history','morning',planDate);
  assert.match(h.lastModal.body,/data-id="morning-record"/);assert.doesNotMatch(h.lastModal.body,/data-id="afternoon-record"/);
  h.action('actual-edit','afternoon-record',planDate);
  assert.equal(shownRecordValues(h.lastModal.body).blockId,'afternoon');assert.match(h.lastModal.body,/selected>15:00 · 学习 &lt;笔记&gt;/);
  const cards=h.ui.renderActualEvents(planDate,'week');
  assert.match(cards,/data-id="afternoon-record"[^>]*data-link-owner="afternoon"/);
  assert.match(cards,/data-id="morning-record"[^>]*data-link-owner="morning"/);
  assert.equal(JSON.stringify(h.state.data),before,'reading the effective owner does not rewrite legacy references');
});

test('saving an effective default owner preserves exact historical time and label, and an explicit reassignment is respected',()=>{
  const {h,planDate}=repeatedDayHarness(),original={...h.state.data.tracking.sessions[1]};
  h.action('actual-edit',original.id,planDate);const values=shownRecordValues(h.lastModal.body);
  assert.equal(values.blockId,'afternoon');
  h.ui.submit({id:'actual-record-form',dataset:{id:original.id,date:planDate},values});
  assert.equal(h.error.textContent,'');
  let saved=h.state.data.tracking.sessions.find(item=>item.id===original.id);
  assert.equal(saved.blockId,'afternoon');assert.equal(saved.planBinding,'explicit');assert.equal(saved.tagId,'rest');
  assert.equal(saved.startedAt,original.startedAt);assert.equal(saved.endedAt,original.endedAt);
  h.action('actual-edit',original.id,planDate);assert.equal(shownRecordValues(h.lastModal.body).blockId,'afternoon');
  h.ui.submit({id:'actual-record-form',dataset:{id:original.id,date:planDate},values:{...values,blockId:'morning'}});
  assert.equal(h.error.textContent,'');saved=h.state.data.tracking.sessions.find(item=>item.id===original.id);
  assert.equal(saved.blockId,'morning');assert.equal(saved.planBinding,'explicit');assert.equal(saved.tagId,'learn');
  assert.equal(saved.startedAt,original.startedAt);assert.equal(saved.endedAt,original.endedAt);
  h.action('actual-edit',original.id,planDate);assert.equal(shownRecordValues(h.lastModal.body).blockId,'morning');
  h.action('actual-history','morning',planDate);assert.match(h.lastModal.body,/data-id="afternoon-record"/);
  h.action('actual-history','afternoon',planDate);assert.doesNotMatch(h.lastModal.body,/data-id="afternoon-record"/);
});

test('manually recording a cycle occurrence fixes that day before later cycle edits can change its reference',()=>{
  const h=harness(),planDate='2026-11-16';h.state.date=planDate;h.context.now=Date.parse(planDate+'T20:00:00Z');
  delete h.state.data.days[planDate];
  h.state.data.cycle={enabled:true,startDate:planDate,endDate:null,sourceWeekTemplateId:null,days:Array.from({length:7},(_,index)=>({templateId:null,templateName:'测试周循环',blocks:index===0?[{...block,id:'cycle-reading',taskId:'task-read',start:540,tagId:'learn'}]:[]}))};
  const planned=resolveDay(h.state.data,planDate).blocks[0];assert.equal(Object.hasOwn(h.state.data.days,planDate),false);
  h.action('actual-new',planned.id,planDate);const values=shownRecordValues(h.lastModal.body);
  assert.equal(Object.hasOwn(h.state.data.days,planDate),false,'opening the existing form must not save a day');
  h.ui.submit({id:'actual-record-form',dataset:{id:'',date:planDate},values});assert.equal(h.error.textContent,'');
  const saved=h.state.data.tracking.sessions[0];
  assert.equal(saved.blockId,planned.id);assert.equal(saved.planBinding,'explicit');assert.equal(saved.endedAt-saved.startedAt,60*60000);
  assert.equal(h.state.data.days[planDate][0].id,planned.id);
  h.state.data.cycle.days[0].blocks=[];
  const stillPlanned=resolveDay(h.state.data,planDate).blocks[0];assert.equal(stillPlanned.id,planned.id);
  assert.match(h.ui.blockTools(stillPlanned,planDate),/<strong>执行 60 分钟<\/strong>/);
  assert.match(h.ui.summary(),/时长覆盖率<\/small><strong>100%<\/strong><span>已覆盖 60 分钟/);
  h.action('actual-history',planned.id,planDate);assert.match(h.lastModal.body,new RegExp('data-id="'+saved.id+'"'));
});
