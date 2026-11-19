import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolveDay,mondayOf,addDays} from '../lib/planner.mjs';

// Test the view against the agreed 04:00–next 04:00 model boundary.
const DAY_START=240,DAY_END=1680;
const viewContext=vm.createContext({resolveDay,mondayOf,addDays,DAY_START,DAY_END,Map});
const source=readFileSync(new URL('../web/week.js',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/,'').replace(/^export /gm,'');
vm.runInContext(source+'\nglobalThis.viewApi={renderWeekly,renderWeekTemplateCards,dayFlow,windowMinutes};',viewContext);
const api=viewContext.viewApi;
const helpers={
 esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 btn:(action,label,cls='',attrs='')=>'<button class="'+cls+'" data-action="'+action+'" '+attrs+'>'+label+'</button>',
 icon:()=>'',duration:minutes=>minutes+'m',
 time:minutes=>(minutes>=1440?'次日 ':'')+String(Math.floor(minutes%1440/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0'),
};
function data(){
 return{
  groups:[{id:'g-learn',name:'学习',color:'#7286B4'},{id:'g-life',name:'生活',color:'#B09062'}],
  templates:[],days:{},dayMeta:{},weekTemplates:[],cycle:{enabled:false},
 };
}
function block(id,start,duration,category='g-learn'){return{id,title:'安排 '+id,start,duration,category,done:false};}
function render(d,extra={}){return api.renderWeekly({data:d,date:'2026-11-09',groupFilter:'all',...extra},helpers);}

test('weekly view has a fixed complete 04:00–next 04:00 grid even with no events',()=>{
 const html=render(data());
 assert.equal((html.match(/data-action="new-week-block"/g)||[]).length,7*48);
 assert.equal((html.match(/data-grid-start="240"/g)||[]).length,7);
 assert.equal((html.match(/data-grid-end="1680"/g)||[]).length,7);
 assert.equal((html.match(/data-minute="240"/g)||[]).length,7);
 assert.equal((html.match(/data-minute="1650"/g)||[]).length,7);
 assert.equal(html.includes('data-minute="1680"'),false);
 assert.match(html,/次日 00:00/);
 assert.match(html,/week-axis-end"><span>次日 04:00/);
 assert.match(html,/空闲 <b>10080m<\/b>/);
});

test('cross-midnight events remain in their planning-day column and count toward 24-hour totals',()=>{
 const d=data();d.days['2026-11-09']=[block('morning',240,60),block('night',1410,120)];
 const html=render(d);
 assert.match(html,/忙碌 <b>180m<\/b>/);
 assert.match(html,/空闲 <b>9900m<\/b>/);
 assert.match(html,/空闲 21h/);
 const night=html.match(/<button[^>]*data-block="night"[^>]*>[\s\S]*?<\/button>/)?.[0];
 assert.ok(night);
 assert.match(night,/data-date="2026-11-09"/);
 assert.match(night,/top:1015px;height:101px/);
 assert.match(night,/23:30–次日 01:30/);
 assert.equal((html.match(/data-block="night"/g)||[]).length,1);
});

test('the last half-hour and the ending 04:00 boundary are rendered without extending the day',()=>{
 const d=data();d.days['2026-11-09']=[block('late',1650,30)];
 const html=render(d);
 const late=html.match(/<button[^>]*data-block="late"[^>]*>[\s\S]*?<\/button>/)?.[0];
 assert.match(late,/top:1223px;height:23px/);
 assert.match(late,/次日 03:30–次日 04:00/);
 assert.match(html,/height:1248px/);
});

test('category flow includes early morning, late night, and all remaining free minutes',()=>{
 const d=data(),day={blocks:[block('early',240,60),block('late',1500,180,'g-life')]};
 const html=api.dayFlow(day,d,helpers.esc,'all');
 const spans=[...html.matchAll(/style="flex:(\d+)/g)].map(match=>Number(match[1]));
 assert.equal(spans.reduce((n,value)=>n+value,0),1440);
 assert.equal((html.match(/week-flow-busy/g)||[]).length,2);
 assert.match(html,/flex:60;background:#7286B4/);
 assert.match(html,/flex:180;background:#B09062/);
 assert.equal(api.windowMinutes(block('crossing',1410,180)),180);
});

test('weekly template editing uses the same day boundary and preserves escaped custom-group content',()=>{
 const d=data();d.groups[0].name='<b>自定义</b>';
 d.weekTemplates=[{id:'w1',name:'每周',description:'',days:Array.from({length:7},(_,i)=>({templateId:null,templateName:'',blocks:i===0?[block('after-midnight',1500,60)]:[]}))}];
 const html=render(d,{editingWeekId:'w1',groupFilter:'g-life'});
 assert.equal((html.match(/data-action="assign-week-template-day"/g)||[]).length,7);
 assert.equal((html.match(/data-grid-end="1680"/g)||[]).length,7);
 assert.match(html,/is-dimmed/);
 assert.equal(html.includes('<b>自定义</b>'),false);
 assert.match(html,/&lt;b&gt;自定义&lt;\/b&gt;/);
 assert.match(html,/次日 01:00–次日 02:00/);
});
