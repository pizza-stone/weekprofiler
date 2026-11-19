import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolveDay,mondayOf,addDays,DAY_START,DAY_END} from '../lib/planner.mjs';

const context=vm.createContext({resolveDay,mondayOf,addDays,DAY_START,DAY_END,Map});
const source=readFileSync(new URL('../web/week.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/,'').replace(/^export /gm,'');
vm.runInContext(source+'\nglobalThis.renderWeekly=renderWeekly;',context);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(action,label,cls='',attrs='')=>'<button class="'+cls+'" data-action="'+action+'" '+attrs+'>'+label+'</button>';
const block={id:'reading',title:'Read <daily>',start:600,duration:30,category:'learn',done:true};
function data(){return {groups:[{id:'learn',name:'Learning',color:'#7286B4'}],templates:[],days:{'2026-11-09':[{...block}]},dayMeta:{},weekTemplates:[],cycle:{enabled:false}};}
function render(mode,d=data()){
 const actualCalls=[];
 const html=context.renderWeekly({data:d,date:'2026-11-09',viewMode:mode}, {
  esc,btn,icon:()=>'<svg aria-hidden="true"></svg>',time:n=>String(n),duration:n=>n+'m',
  timerButton:(b,date)=>btn('timer-start','▶','timer-start','data-id="'+esc(b.id)+'" data-date="'+date+'" aria-label="开始计时 '+esc(b.title)+'"'),
  renderActualEvents:(date,layout)=>{actualCalls.push({date,layout});return date==='2026-11-09'?'<button class="actual-event" data-action="actual-edit" data-id="session-1">Recorded</button>':'';},
 });
 return {html,actualCalls};
}

test('weekly actual mode renders real records without any editable plan cells or selectors',()=>{
 const {html,actualCalls}=render('actual');
 assert.equal(actualCalls.length,7);
 assert.deepEqual(actualCalls[0],{date:'2026-11-09',layout:'week'});
 assert.equal(actualCalls[6].date,'2026-11-15');
 assert.equal((html.match(/class="week-actual-column" data-readonly="true"/g)||[]).length,7);
 assert.match(html,/data-action="actual-edit" data-id="session-1"/);
 for(const forbidden of ['data-action="new-week-block"','data-action="edit-week-block"','data-action="assign-day-template"','data-action="timer-start"','class="week-day-column"','data-block='])assert.equal(html.includes(forbidden),false,forbidden);
 assert.match(html,/计划时长 <b>30m<\/b>/);
 assert.doesNotMatch(html,/week-view-footer|每天 04:00 → 次日 04:00|显示按最近半小时取整/);
});

test('comparison keeps each plan and actual pair on one grid with editable plan bounds only',()=>{
 const {html,actualCalls}=render('compare');
 assert.equal(actualCalls.length,7);
 assert.match(html,/week-view-canvas is-compare/);
 assert.equal((html.match(/class="week-view-scroll"/g)||[]).length,1);
 assert.equal((html.match(/class="week-time-axis"/g)||[]).length,7);
 assert.equal((html.match(/class="week-day-pair"/g)||[]).length,7);
 assert.equal((html.match(/class="week-column-labels"><span>计划<\/span><span>实际<\/span>/g)||[]).length,7);
 assert.equal((html.match(/data-action="new-week-block"/g)||[]).length,336);
 assert.equal((html.match(/data-grid-start="240" data-grid-end="1680"/g)||[]).length,7);
 assert.match(html,/<div class="week-day-column" data-date="2026-11-09" data-weekday="0"/);
 assert.match(html,/<div class="week-actual-column" data-readonly="true" data-date="2026-11-09"/);
});

test('mobile day paging and the shared vertical timeline have separate scrollports in every mode',()=>{
 for(const mode of ['plan','actual','compare']){
  const {html}=render(mode);
  assert.match(html,/<div class="week-view-pager"><div class="week-view-strip"><div class="week-day-stops" aria-hidden="true">(?:<i><\/i>){7}<\/div><div class="week-view-scroll"/);
  assert.equal((html.match(/class="week-axis-head"/g)||[]).length,7);
  assert.equal((html.match(/class="week-time-axis"/g)||[]).length,7);
 }
});

test('a half-hour planned event provides independent completion and timer controls',()=>{
 const {html,actualCalls}=render('plan');
 assert.deepEqual(actualCalls,[]);
 assert.match(html,/<div role="button" tabindex="0" draggable="true" class="week-event short done"/);
 assert.match(html,/data-action="toggle-week"[^>]*data-id="reading"[^>]*data-date="2026-11-09"[^>]*aria-pressed="true"/);
 assert.match(html,/data-action="timer-start"[^>]*data-id="reading"[^>]*data-date="2026-11-09"/);
 assert.match(html,/Read &lt;daily&gt;/);
 assert.equal(html.includes('<button type="button" draggable="true" class="week-event'),false);
 assert.equal((html.match(/data-block="reading"/g)||[]).length,1);
});

test('weekly templates always edit planned blocks even when the current view preference is actual',()=>{
 const d=data();
 d.weekTemplates=[{id:'template-week',days:Array.from({length:7},(_,i)=>({templateId:null,templateName:'',blocks:i===0?[{...block}]:[]}))}];
 let actualCalls=0,timerCalls=0;
 const html=context.renderWeekly({data:d,date:'2026-11-09',editingWeekId:'template-week',viewMode:'actual'}, {
  esc,btn,icon:()=>'',time:String,duration:String,
  timerButton:()=>{timerCalls++;return'';},renderActualEvents:()=>{actualCalls++;return'';},
 });
 assert.equal(actualCalls,0);assert.equal(timerCalls,0);
 assert.match(html,/week-view-canvas is-plan/);
 assert.equal((html.match(/data-action="assign-week-template-day"/g)||[]).length,7);
 assert.equal((html.match(/data-action="new-week-block"/g)||[]).length,336);
 assert.equal(html.includes('data-action="toggle-week"'),false);
});

test('daily detail toggles retain date columns, comparison labels and editable template selectors',()=>{
 const h={esc,btn,time:String,duration:String},d=data();
 const html=context.renderWeekly({data:d,date:'2026-11-09',viewMode:'compare',statsExpanded:true,expandedDays:['2026-11-10']},h);
 assert.match(html,/class="panel weekly-panel" data-stats-expanded="true"/);
 assert.equal((html.match(/data-action="week-day-details"/g)||[]).length,7);
 assert.equal((html.match(/data-details-expanded="true"/g)||[]).length,1);
 assert.match(html,/data-id="2026-11-10"[^>]*aria-expanded="true"[^>]*aria-controls="week-day-details-1"/);
 assert.equal((html.match(/class="week-day-pair"/g)||[]).length,7);
 assert.equal((html.match(/class="week-column-labels"><span>计划<\/span><span>实际<\/span>/g)||[]).length,7);
 assert.equal((html.match(/data-action="assign-day-template"/g)||[]).length,7);
 assert.equal((html.match(/data-action="new-week-block"/g)||[]).length,336);
 assert.doesNotMatch(html,/week-view-footer|每天 04:00 → 次日 04:00|显示按最近半小时取整/);
});
