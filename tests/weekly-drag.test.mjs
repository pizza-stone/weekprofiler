import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {seedData,resolveDay,materializeDay,validateData,DAY_START,DAY_END} from '../lib/planner.mjs';

function harness(){
 const listeners={},notifications=[];
 const state={data:seedData(),date:'2026-11-09',templateId:null,weekTemplateId:null};
 const context=vm.createContext({
  state,resolveDay,materializeDay,DAY_START,DAY_END,Date,Number,
  document:{addEventListener(name,fn){listeners[name]=fn;},querySelectorAll(){return[];}},
  uid:()=>crypto.randomUUID(),time:value=>String(value),toast:value=>notifications.push(value),
  collision:(list,start,len,ignore)=>list.some(b=>b.id!==ignore&&b.start<start+len&&start<b.start+b.duration),
  commit(fn){fn(state.data);assert.equal(validateData(state.data),true);},
 });
 const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
 const section=app.slice(app.indexOf('function dragContainer('),app.indexOf('let resize=null;'));
 vm.runInContext('let drag=null,resize=null,suppressClickUntil=0;\n'+section+'\nglobalThis.dragApi={dropMinute};',context);
 function column(date,index,start=480){return{dataset:{date,weekday:String(index),gridStart:String(start)},getBoundingClientRect(){return{top:100,height:(DAY_END-start)/30*26};},querySelector(){return null;}};}
 function sourceBlock(id,col=null){return{dataset:{block:id},closest(sel){return sel==='.week-day-column'?col:null;}};}
 function startBlock(id,col=null){
  const block=sourceBlock(id,col);
  listeners.dragstart({target:{closest(sel){return sel==='[data-block]'?block:null;}},dataTransfer:{setData(){}},preventDefault(){}});
 }
 function startTask(id){listeners.dragstart({target:{closest(sel){return sel==='[data-task]'?{dataset:{task:id}}:null;}},dataTransfer:{setData(){}},preventDefault(){}});}
 function drop(col,minute){listeners.drop({target:{closest(sel){return sel==='.week-day-column'?col:null;}},clientY:100+(minute-Number(col.dataset.gridStart))/30*26+2,preventDefault(){}});}
 return{state,notifications,listeners,column,startBlock,startTask,drop,context};
}
function block(id,start=540){return{id,title:'安排',start,duration:30,category:'learn',done:true};}

test('weekly move between saved dates preserves identity, completion, and group',()=>{
 const h=harness();h.state.data.days['2026-11-09']=[block('keep-id')];h.state.data.days['2026-11-10']=[];
 h.startBlock('keep-id',h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),600);
 assert.equal(h.state.data.days['2026-11-09'].length,0);
 assert.deepEqual(JSON.parse(JSON.stringify(h.state.data.days['2026-11-10'][0])),block('keep-id',600));
});

test('moving a generated recurring event creates date exceptions without editing the cycle',()=>{
 const h=harness();h.state.data.cycle.enabled=true;h.state.data.cycle.startDate='2026-11-01';h.state.data.cycle.endDate=null;
 h.state.data.cycle.days=Array.from({length:7},()=>({templateId:null,templateName:'',blocks:[]}));
 h.state.data.cycle.days[0].blocks=[block('cycle-source')];
 const before=JSON.stringify(h.state.data.cycle),virtual=resolveDay(h.state.data,'2026-11-09').blocks[0];
 h.startBlock(virtual.id,h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),660);
 assert.equal(h.state.data.days['2026-11-09'].length,0);
 assert.equal(h.state.data.days['2026-11-10'][0].id,virtual.id);
 assert.equal(h.state.data.days['2026-11-10'][0].start,660);
 assert.equal(JSON.stringify(h.state.data.cycle),before);
 assert.equal(resolveDay(h.state.data,'2026-11-16').blocks.length,1);
});

test('weekly collision preserves the source, while duplicate IDs are regenerated for a free destination',()=>{
 const h=harness();h.state.data.days['2026-11-09']=[block('source')];h.state.data.days['2026-11-10']=[block('busy',600)];
 h.startBlock('source',h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),600);
 assert.equal(h.state.data.days['2026-11-09'].length,1);assert.equal(h.state.data.days['2026-11-10'].length,1);
 h.state.data.days['2026-11-10']=[block('source',720)];
 h.startBlock('source',h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),600);
 assert.equal(h.state.data.days['2026-11-09'].length,0);
 assert.equal(h.state.data.days['2026-11-10'][0].start,720);
 const moved=h.state.data.days['2026-11-10'][1];
 assert.notEqual(moved.id,'source');
 assert.deepEqual(JSON.parse(JSON.stringify({...moved,id:'source'})),block('source',600));
});

test('repeated day templates can move an event across weekdays without duplicate IDs',()=>{
 const h=harness(),template=h.state.data.weekTemplates[0];
 template.days=Array.from({length:7},()=>({templateId:null,templateName:'',blocks:[]}));
 template.days[0].blocks=[block('repeated')];template.days[1].blocks=[block('repeated',720)];
 h.state.weekTemplateId=template.id;
 h.startBlock('repeated',h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),600);
 assert.equal(template.days[0].blocks.length,0);assert.equal(template.days[1].blocks.length,2);
 assert.equal(new Set(template.days[1].blocks.map(b=>b.id)).size,2);
 assert.equal(template.days[1].blocks[1].done,true);assert.equal(template.days[1].blocks[1].category,'learn');
 assert.equal(template.days[1].blocks[1].start,600);
});

test('week-template dragging edits only that weekly snapshot and task drops create new events',()=>{
 const h=harness(),template=h.state.data.weekTemplates[0];
 template.days=Array.from({length:7},()=>({templateId:null,templateName:'',blocks:[]}));
 template.days[0].blocks=[block('week-event')];h.state.weekTemplateId=template.id;
 const cycle=JSON.stringify(h.state.data.cycle),daily=JSON.stringify(h.state.data.templates);
 h.startBlock('week-event',h.column('2026-11-09',0));h.drop(h.column('2026-11-10',1),630);
 assert.equal(template.days[0].blocks.length,0);assert.equal(template.days[1].blocks[0].start,630);
 const task=h.state.data.tasks[0];h.startTask(task.id);h.drop(h.column('2026-11-11',2),540);
 assert.equal(template.days[2].blocks[0].taskId,task.id);assert.notEqual(template.days[2].blocks[0].id,task.id);
 assert.equal(JSON.stringify(h.state.data.cycle),cycle);assert.equal(JSON.stringify(h.state.data.templates),daily);
 assert.deepEqual(h.state.data.days,{});
});

test('single-day dragging still resolves full-day minutes and moves same-day events',()=>{
 const h=harness();h.state.data.days['2026-11-09']=[block('single')];
 const timeline={getBoundingClientRect(){return{top:-200,height:1248};},querySelector(){return null;}};
 const target={closest(sel){return sel==='.timeline'?timeline:null;}};
 assert.equal(h.context.dragApi.dropMinute({target,clientY:294}),810);
 h.startBlock('single');h.listeners.drop({target,clientY:-200+(570-DAY_START)/30*26+2,preventDefault(){}});
 assert.equal(h.state.data.days['2026-11-09'][0].start,570);
});
