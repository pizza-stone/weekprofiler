import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as planner from '../lib/planner.mjs';
import * as trackingModel from '../lib/tracking.mjs';
import {createTrackingUI} from '../web/tracking.js';
import {refreshPlanLinks} from '../web/plan-links.js';

const task=(id,duration,extra={})=>({id,title:'阅读 '+duration,duration,category:'learn',reusable:false,done:false,...extra});
function harness(){
  const listeners={},nodes=new Map(),modalNode={open:false,close(){this.open=false;}},activity={render:0,modal:0,cache:0,save:0};
  const document={activeElement:null,addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    querySelector(selector){return selector==='#modal'?modalNode:(nodes.get(selector)||[])[0]||null;},
    querySelectorAll(selector){return nodes.get(selector)||[];}};
  const context=vm.createContext({...planner,trackingModel,createTrackingUI,refreshPlanLinks,TextEncoder,Intl,Date,URL,Blob,Uint8Array,crypto,
    document,window:{addEventListener(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){},localStorage:{setItem(){activity.cache++;}},activity});
  const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\nboot\(\);\s*$/,'');
  vm.runInContext(source+`
    render=()=>activity.render++;
    modal=(title,content)=>{activity.modal++;globalThis.lastModal={title,content};};
    cache=()=>activity.cache++;
    queueSave=()=>activity.save++;
    toast=()=>{};
    globalThis.api={state,isTemplateEditing,taskDurationLimit,filteredTasks,availableTasks,taskDurationFilter,setTaskDurationBound,updateTaskSources,taskChoiceOptions,taskChoice,pickTask,durationRangePointerDown,durationRangePointerMove,durationRangePointerEnd,getDurationRangeDrag:()=>durationRangeDrag};
  `,context);
  const api=context.api;
  api.state.data=planner.seedData();api.state.ready=true;api.state.tab='templates';api.state.templateId=api.state.data.templates[0].id;
  api.state.data.tasks=[task('read30',30),task('read60',60),task('read90',90),
    task('work60',60,{category:'work'}),task('write60',60,{title:'写作'}),
    task('completed60',60,{done:true}),task('repeat60',60,{done:true,reusable:true})];
  return {...api,context,document,nodes,listeners,activity};
}
const ids=tasks=>Array.from(tasks,t=>t.id);
function makePanel(h,{left=100,width=210,centers={min:100,max:310}}={}){
  const elements=new Map(),captures=new Set(),properties=new Map();
  const panel={querySelector:selector=>elements.get(selector)};
  const track={style:{setProperty:(name,value)=>properties.set(name,value)},properties,
    querySelector:selector=>elements.get(selector),
    closest:selector=>selector==='[data-duration-filter]'?panel:selector==='[data-duration-slider]'?track:null,
    getBoundingClientRect:()=>({left,width}),
    setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
  elements.set('[data-duration-slider]',track);
  for(const bound of ['min','max']){
    const input={dataset:{durationBound:bound},value:bound==='min'?'30':'240',attributes:{},
      setAttribute(name,value){this.attributes[name]=value;},focus(){h.document.activeElement=this;}};
    const handle={dataset:{durationHandle:bound},getBoundingClientRect:()=>({left:centers[bound]-10,width:20}),
      closest:selector=>selector==='[data-duration-handle]'?handle:track.closest(selector)};
    elements.set('[data-duration-bound="'+bound+'"]',input);
    elements.set('[data-duration-handle="'+bound+'"]',handle);
    elements.set('[data-duration-value="'+bound+'"]',{textContent:''});
  }
  elements.set('[data-duration-summary]',{textContent:''});elements.set('[data-action="duration-reset"]',{disabled:true});
  for(const node of [panel,track])Object.defineProperty(node,'innerHTML',{set(){throw Error('Filtering must retain the slider DOM');}});
  return panel;
}
const pointer=(target,clientX,pointerId=1,extra={})=>({target,clientX,pointerId,button:0,isPrimary:true,preventDefault(){this.defaultPrevented=true;},...extra});

test('template task ranges include both bounds and combine with search, group, and status eligibility',()=>{
  const h=harness();h.state.filter='learn';h.state.search='阅读';
  h.setTaskDurationBound('min',30);h.setTaskDurationBound('max',60);
  assert.deepEqual(ids(h.availableTasks()),['read30','read60','repeat60']);
  assert.ok(ids(h.filteredTasks()).includes('completed60'),'status eligibility remains distinct from text/group/range filtering');
  h.setTaskDurationBound('min',60);
  assert.deepEqual(ids(h.availableTasks()),['read60','repeat60']);
  h.state.search='不存在的任务';assert.deepEqual(ids(h.availableTasks()),[]);
});

test('week template filtering follows its group selection and duration filtering does not leak outside editors',()=>{
  const h=harness();h.state.templateId=null;h.state.weekTemplateId=h.state.data.weekTemplates[0].id;
  h.state.filter='learn';h.state.weekFilter='work';h.state.search='阅读';
  h.setTaskDurationBound('min',60);h.setTaskDurationBound('max',60);
  assert.equal(h.isTemplateEditing(),true);assert.deepEqual(ids(h.availableTasks()),['work60']);
  h.state.weekTemplateId=null;h.state.tab='tasks';
  assert.equal(h.isTemplateEditing(),false);assert.deepEqual(ids(h.availableTasks()),['read30','read60','read90','repeat60']);
  assert.equal(h.taskDurationFilter(),'');
  h.state.tab='day';assert.deepEqual(ids(h.availableTasks()),['read30','read60','read90','repeat60']);
});

test('crossed handles clamp only the moving endpoint, allow equality, and the upper endpoint can be unlimited',()=>{
  const h=harness();const before=JSON.stringify(h.state.data),undo=h.state.undo;
  h.setTaskDurationBound('max',60);h.setTaskDurationBound('min',90);
  assert.equal(h.state.taskDurationMin,60);assert.equal(h.state.taskDurationMax,60);
  h.setTaskDurationBound('max',30);
  assert.equal(h.state.taskDurationMin,60);assert.equal(h.state.taskDurationMax,60);
  h.setTaskDurationBound('min',30);h.setTaskDurationBound('max',30);
  assert.equal(h.state.taskDurationMin,30);assert.equal(h.state.taskDurationMax,30);
  h.setTaskDurationBound('max',h.taskDurationLimit());
  assert.equal(h.state.taskDurationMax,null);
  assert.equal(JSON.stringify(h.state.data),before);assert.equal(h.state.dirty,false);assert.equal(h.state.undo,undo);assert.equal(h.state.undo.length,0);
  assert.deepEqual(h.activity,{render:0,modal:0,cache:0,save:0});
});

test('range limits cover full-day tasks and preserve an active range if tasks are removed',()=>{
  const h=harness();assert.ok(h.taskDurationLimit()>=240);
  h.state.data.tasks.push(task('long',1440));assert.equal(h.taskDurationLimit(),1440);
  h.setTaskDurationBound('min',1440);h.setTaskDurationBound('max',1440);
  assert.deepEqual(ids(h.availableTasks()),['long']);assert.equal(h.state.taskDurationMax,null);
  h.state.data.tasks=h.state.data.tasks.filter(t=>t.id!=='long');
  assert.ok(h.taskDurationLimit()>=h.state.taskDurationMin);assert.deepEqual(ids(h.availableTasks()),[]);
});

test('task options retain an excluded selection without admitting other excluded tasks and escape task text',()=>{
  const h=harness();h.state.data.tasks.find(t=>t.id==='read90').title='<img src=x onerror=alert(1)> & "已选"';
  h.setTaskDurationBound('max',30);
  const html=h.taskChoiceOptions('read90');
  assert.match(html,/value="read90"[^>]*selected/);
  assert.equal((html.match(/value="read90"/g)||[]).length,1);
  assert.match(html,/value="read30"/);assert.doesNotMatch(html,/value="read60"/);
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;已选&quot;/);assert.doesNotMatch(html,/<img/);
});

test('one shared track has two labelled keyboard ranges and two separate visual handles in every task picker',()=>{
  const h=harness();h.setTaskDurationBound('max',60);
  const controls=h.taskDurationFilter(),inputs=controls.match(/<input\b[^>]*type="range"[^>]*>/g)||[];
  assert.equal(inputs.length,2);
  for(const input of inputs){assert.match(input,/step="30"/);assert.match(input,/min="30"/);assert.match(input,/aria-label="[^"]+"/);}
  assert.equal((controls.match(/data-duration-slider\b/g)||[]).length,1);
  assert.match(inputs[0],/data-duration-bound="min"/);assert.match(inputs[0],/max="60"/);
  assert.match(inputs[1],/data-duration-bound="max"/);assert.match(inputs[1],new RegExp('max="'+h.taskDurationLimit()+'"'));
  for(const bound of ['min','max'])assert.match(controls,new RegExp('<span[^>]*data-duration-handle="'+bound+'"[^>]*aria-hidden="true"'));
  for(const input of inputs)assert.doesNotMatch(input,/disabled|tabindex="-1"|aria-hidden="true"/);
  assert.doesNotMatch(controls,/duration-range-row/);
  const buttons=controls.match(/<button\b[^>]*>/g)||[];assert.ok(buttons.length);
  for(const button of buttons)assert.match(button,/type="button"/);
  h.pickTask();assert.match(h.context.lastModal.content,/type="range"/);
  h.state.templateId=null;h.state.weekTemplateId=h.state.data.weekTemplates[0].id;h.state.editWeekday=0;
  assert.match(h.taskChoice('read60'),/type="range"/);
});

test('equal bounds can be expanded from either separated handle without a jump at the grab point',()=>{
  for(const bound of ['min','max']){
    const h=harness();h.setTaskDurationBound('min',90);h.setTaskDurationBound('max',90);
    const centers={min:150,max:170},panel=makePanel(h,{centers}),other=makePanel(h);
    h.nodes.set('[data-duration-filter]',[panel,other]);h.updateTaskSources();
    const track=panel.querySelector('[data-duration-slider]'),handle=panel.querySelector('[data-duration-handle="'+bound+'"]');
    const input=panel.querySelector('[data-duration-bound="'+bound+'"]'),grabX=centers[bound]+5;
    h.durationRangePointerDown(pointer(handle,grabX));
    assert.equal(h.document.activeElement,input);assert.equal(track.hasPointerCapture(1),true);
    assert.equal(h.state.taskDurationMin,90);assert.equal(h.state.taskDurationMax,90);
    h.durationRangePointerMove(pointer(track,grabX));
    assert.equal(h.state.taskDurationMin,90);assert.equal(h.state.taskDurationMax,90);
    h.durationRangePointerMove(pointer(track,grabX+(bound==='min'?-30:30)));
    assert.equal(h.state.taskDurationMin,bound==='min'?60:90);assert.equal(h.state.taskDurationMax,bound==='max'?120:90);
    assert.equal(other.querySelector('[data-duration-bound="'+bound+'"]').value,bound==='min'?'60':'120');
    assert.equal(h.document.activeElement,input);assert.equal(panel.querySelector('[data-duration-slider]'),track);
    h.durationRangePointerEnd(pointer(track,grabX));assert.equal(h.getDurationRangeDrag(),null);assert.equal(track.hasPointerCapture(1),false);
    assert.deepEqual(h.activity,{render:0,modal:0,cache:0,save:0});
  }
});

test('track clicks select the nearest painted handle and clamp dragging to the available range',()=>{
  const h=harness();h.setTaskDurationBound('min',60);h.setTaskDurationBound('max',150);
  const panel=makePanel(h,{centers:{min:130,max:220}}),track=panel.querySelector('[data-duration-slider]');
  h.nodes.set('[data-duration-filter]',[panel]);h.updateTaskSources();
  h.durationRangePointerDown(pointer(track,250));
  assert.equal(h.getDurationRangeDrag().bound,'max');assert.equal(h.state.taskDurationMin,60);assert.equal(h.state.taskDurationMax,180);
  assert.equal(h.document.activeElement,panel.querySelector('[data-duration-bound="max"]'));
  h.durationRangePointerMove(pointer(track,500));assert.equal(h.state.taskDurationMax,null);
  h.durationRangePointerEnd(pointer(track,500));
  h.durationRangePointerDown(pointer(track,145));
  assert.equal(h.getDurationRangeDrag().bound,'min');assert.equal(h.state.taskDurationMin,90);
  h.durationRangePointerMove(pointer(track,-100));assert.equal(h.state.taskDurationMin,30);
  h.durationRangePointerEnd(pointer(track,-100));
});

test('pointer cancellation and capture loss stop dragging, while unrelated pointers cannot move or end it',()=>{
  const h=harness(),panel=makePanel(h),track=panel.querySelector('[data-duration-slider]'),handle=panel.querySelector('[data-duration-handle="min"]');
  h.nodes.set('[data-duration-filter]',[panel]);
  for(const extra of [{button:2},{isPrimary:false}])h.durationRangePointerDown(pointer(handle,100,1,extra));
  assert.equal(h.getDurationRangeDrag(),null);
  h.durationRangePointerDown(pointer(handle,100,7));
  h.durationRangePointerMove(pointer(track,190,8));h.durationRangePointerEnd(pointer(track,190,8));
  assert.equal(h.state.taskDurationMin,30);assert.equal(h.getDurationRangeDrag().pointerId,7);assert.equal(track.hasPointerCapture(7),true);
  for(const listener of h.listeners.pointercancel)listener(pointer(track,100,7));
  assert.equal(h.getDurationRangeDrag(),null);assert.equal(track.hasPointerCapture(7),false);
  h.durationRangePointerMove(pointer(track,190,7));assert.equal(h.state.taskDurationMin,30);
  h.durationRangePointerDown(pointer(handle,100,9));
  for(const listener of h.listeners.lostpointercapture)listener(pointer(track,100,9));
  assert.equal(h.getDurationRangeDrag(),null);assert.equal(track.hasPointerCapture(9),false);
});

test('keyboard input events retain focus, synchronize endpoint constraints and update the shared selection',()=>{
  const h=harness();h.setTaskDurationBound('min',90);h.setTaskDurationBound('max',90);
  const panels=[makePanel(h),makePanel(h)];h.nodes.set('[data-duration-filter]',panels);h.updateTaskSources();
  const min=panels[0].querySelector('[data-duration-bound="min"]'),max=panels[0].querySelector('[data-duration-bound="max"]');
  assert.equal(min.min,'30');assert.equal(min.max,'90');assert.equal(max.min,'90');assert.equal(max.max,'240');
  // Browser range inputs supply the default Arrow/Home/End behavior. App handlers must leave it intact.
  for(const key of ['ArrowLeft','ArrowRight','Home','End']){
    for(const listener of h.listeners.keydown)listener({key,target:min,preventDefault(){assert.fail('Native range keys must not be intercepted');}});
  }
  for(const [input,value] of [[min,'60'],[max,'120']]){
    input.focus();input.value=value;
    for(const listener of h.listeners.input)listener({target:input});
    assert.equal(h.document.activeElement,input);
  }
  for(const panel of panels){
    const track=panel.querySelector('[data-duration-slider]');
    assert.equal(panel.querySelector('[data-duration-bound="min"]').max,'120');
    assert.equal(panel.querySelector('[data-duration-bound="max"]').min,'60');
    assert.equal(panel.querySelector('[data-duration-bound="max"]').attributes['aria-valuetext'],'2 小时');
    assert.ok(Math.abs(parseFloat(track.properties.get('--range-start'))-100/7)<1e-9);
    assert.ok(Math.abs(parseFloat(track.properties.get('--range-end'))-300/7)<1e-9);
    assert.ok(Math.abs(parseFloat(track.properties.get('--range-mid'))-200/7)<1e-9);
  }
  assert.equal(h.getDurationRangeDrag(),null);assert.deepEqual(h.activity,{render:0,modal:0,cache:0,save:0});
});

test('live slider and search updates preserve focused controls, selected tasks, and unsaved form edits',async()=>{
  const h=harness();h.state.filter='learn';h.state.search='阅读';
  const panels=[makePanel(h),makePanel(h)],lists=[{innerHTML:''},{innerHTML:''}],counts=[{textContent:''},{textContent:''}];
  const picker={value:'read90',innerHTML:''},form={dataset:{task:'read90'}},title={value:'尚未保存的自定义标题'},duration={value:'120'};
  Object.defineProperty(form,'innerHTML',{set(){throw Error('The block form must not be replaced during filtering');}});
  const searches=[{id:'task-search',value:'阅读'},{id:'picker-task-search',value:'阅读'}];
  h.nodes.set('[data-task-results]',lists);h.nodes.set('[data-task-count]',counts);h.nodes.set('[data-task-search]',searches);
  h.nodes.set('[data-duration-filter]',panels);h.nodes.set('#block-task-picker',[picker]);h.nodes.set('#block-form',[form]);h.nodes.set('#title',[title]);h.nodes.set('#duration',[duration]);
  const slider=panels[1].querySelector('[data-duration-bound="max"]');slider.value='60';h.document.activeElement=slider;
  const before=JSON.stringify(h.state.data);
  for(const listener of h.listeners.input)listener({target:slider});
  assert.equal(h.state.taskDurationMax,60);assert.equal(h.document.activeElement,slider);
  for(const list of lists){assert.match(list.innerHTML,/data-task="read30"/);assert.match(list.innerHTML,/data-task="read60"/);assert.doesNotMatch(list.innerHTML,/data-task="read90"/);}
  for(const count of counts)assert.equal(count.textContent,'3');
  assert.match(picker.innerHTML,/value="read90"[^>]*selected/);assert.equal(picker.value,'read90');assert.equal(form.dataset.task,'read90');
  for(const panel of panels){const input=panel.querySelector('[data-duration-bound="max"]');assert.equal(input.value,'60');assert.equal(input.attributes['aria-valuetext'],'1 小时');}
  assert.equal(title.value,'尚未保存的自定义标题');assert.equal(duration.value,'120');

  searches[1].value='不存在';h.document.activeElement=searches[1];
  for(const listener of h.listeners.input)listener({target:searches[1]});
  assert.equal(h.document.activeElement,searches[1]);assert.equal(searches[0].value,'不存在');
  for(const list of lists)assert.match(list.innerHTML,/没有符合筛选条件的任务/);
  for(const count of counts)assert.equal(count.textContent,'0');
  const reset={dataset:{action:'reset-task-filters'}};
  for(const listener of h.listeners.click)await listener({target:{closest:()=>reset}});
  assert.equal(h.state.taskDurationMin,30);assert.equal(h.state.taskDurationMax,null);assert.equal(h.state.search,'');assert.equal(h.state.filter,'all');
  for(const count of counts)assert.equal(count.textContent,'6');
  for(const panel of panels)assert.equal(panel.querySelector('[data-action="duration-reset"]').disabled,true);
  assert.equal(JSON.stringify(h.state.data),before);assert.equal(h.state.dirty,false);assert.equal(h.state.undo.length,0);
  assert.deepEqual(h.activity,{render:0,modal:0,cache:0,save:0});
});
