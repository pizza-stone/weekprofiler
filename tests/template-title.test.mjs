import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as planner from '../lib/planner.mjs';
import * as trackingModel from '../lib/tracking.mjs';

function harness(){
  const listeners={},nodes=new Set(),notices=[];
  let current=null,context,renderCount=0,requests=0;
  const document={activeElement:null,
    addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    querySelector:selector=>selector==='#modal'?{open:false}:null,
    querySelectorAll:selector=>selector==='[data-action="edit-template-title"]'?[...nodes].filter(node=>node.connected&&node.dataset.action==='edit-template-title'):[],
    createElement(type){
      const node={tagName:type.toUpperCase(),dataset:{},attributes:{},value:'',textContent:'',connected:false,validityMessage:'',
        setAttribute(key,value){this.attributes[key]=value;},setCustomValidity(value){this.validityMessage=value;},reportValidity(){this.reported=true;return !this.validityMessage;},
        matches:()=>false,closest(selector){return selector==='[data-action]'&&this.dataset.action?this:null;},
        replaceWith(next){this.connected=false;next.connected=true;if(current===this)current=next;
          if(document.activeElement===this){document.activeElement=null;for(const listener of listeners.focusout||[])listener({target:this,relatedTarget:null});}},
        focus(){const previous=document.activeElement;document.activeElement=this;
          if(previous&&previous!==this)for(const listener of listeners.focusout||[])listener({target:previous,relatedTarget:this});},
        select(){this.selected=true;},
      };nodes.add(node);return node;
    },
  };
  const mount=(kind,id)=>{
    const template=context.api.state.data[kind==='week'?'weekTemplates':'templates'].find(item=>item.id===id);
    const button=document.createElement('button');button.dataset={action:'edit-template-title',kind,id};button.textContent=template.name;
    if(current)current.replaceWith(button);else {current=button;button.connected=true;}
    return button;
  };
  context=vm.createContext({...planner,trackingModel,document,TextEncoder,Intl,Date,Uint8Array,URL,Blob,
    crypto:{randomUUID:()=>crypto.randomUUID()},window:{addEventListener(){}},
    setTimeout:()=>1,clearTimeout(){},setInterval(){},localStorage:{setItem(){}},
    createTrackingUI:()=>({action:()=>false}),renderTimeShares:()=>'',refreshPlanLinks(){},
    fetch:async()=>{requests++;throw Error('unexpected refresh while renaming');},
  });
  const weekly=readFileSync(new URL('../web/week.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\nboot\(\);\s*$/,'');
  context.repaint=()=>{renderCount++;if(current)mount(current.dataset.kind,current.dataset.id);};
  context.captureNotice=message=>notices.push(message);
  vm.runInContext(weekly+'\n'+source+'\nrender=()=>globalThis.repaint();updateStatus=()=>{};cache=()=>{};toast=message=>globalThis.captureNotice(message);globalThis.api={state,templateTitle,templateCards,beginTemplateRename,finishTemplateRename,refresh,weekCards:()=>renderWeekTemplateCards(state.data,viewHelpers)};',context);
  context.api.state.data=planner.seedData();context.api.state.ready=true;context.api.state.date='2026-11-16';context.api.state.tab='templates';
  const dispatch=async(type,target,extra={})=>{
    const event={target,prevented:false,preventDefault(){this.prevented=true;},...extra};
    for(const listener of listeners[type]||[])await listener(event);
    return event;
  };
  return {...context.api,document,notices,mount,dispatch,get current(){return current;},get renders(){return renderCount;},get requests(){return requests;}};
}

test('day and week titles open in place, select existing text, and Enter commits one name-only change',async()=>{
  for(const [kind,collection] of [['day','templates'],['week','weekTemplates']]){
    const h=harness(),template=h.state.data[collection][0];template.notes='保持复盘\n第二行';template.description='保持简介';
    const original=JSON.stringify(h.state.data),button=h.mount(kind,template.id);
    await h.dispatch('click',button);
    const input=h.current;assert.equal(input.tagName,'INPUT');assert.equal(input.value,template.name);assert.equal(input.selected,true);
    assert.equal(h.document.activeElement,input);assert.equal(input.dataset.templateRename,'true');assert.equal(h.state.undo.length,0);
    input.value='  新名称 <保持文本>  ';
    const enter=await h.dispatch('keydown',input,{key:'Enter'});
    assert.equal(enter.prevented,true);assert.equal(template.name,'新名称 <保持文本>');assert.equal(h.state.undo.length,1);assert.equal(h.state.dirty,true);
    assert.equal(h.renders,1);assert.equal(h.current.tagName,'BUTTON');assert.equal(h.document.activeElement,h.current);
    await h.dispatch('focusout',input);await h.dispatch('keydown',input,{key:'Enter'});
    assert.equal(h.state.undo.length,1);assert.equal(h.renders,1,'detached Enter/blur cannot create duplicate commits');
    const expected=JSON.parse(original);expected[collection][0].name=template.name;
    assert.equal(JSON.stringify(h.state.data),JSON.stringify(expected),'notes, descriptions, schedules and every other field are preserved');
  }
});

test('Escape and blur cancel drafts without saving or adding undo; blur keeps focus on the next control',async()=>{
  for(const cancel of ['escape','blur'])for(const [kind,collection] of [['day','templates'],['week','weekTemplates']]){
    const h=harness(),template=h.state.data[collection][0],before=JSON.stringify(h.state.data);
    await h.dispatch('click',h.mount(kind,template.id));const input=h.current;input.value='放弃草稿';
    if(cancel==='escape'){await h.dispatch('keydown',input,{key:'Escape'});assert.equal(h.document.activeElement,h.current,'Escape restores keyboard focus to the title');}
    else {const other=h.document.createElement('button');other.connected=true;other.focus();assert.equal(h.document.activeElement,other);}
    assert.equal(h.current.tagName,'BUTTON');assert.equal(h.current.textContent,template.name);
    assert.equal(JSON.stringify(h.state.data),before);assert.equal(h.state.undo.length,0);assert.equal(h.state.dirty,false);assert.equal(h.renders,0);
  }
});

test('IME candidate Enter is ignored, and the next ordinary Enter saves once',async()=>{
  for(const ime of [{isComposing:true},{keyCode:229}]){
    const h=harness(),template=h.state.data.templates[0],before=template.name;
    await h.dispatch('click',h.mount('day',template.id));const input=h.current;input.value='中文模板名称';
    const event=await h.dispatch('keydown',input,{key:'Enter',...ime});
    assert.equal(event.prevented,false);assert.equal(template.name,before);assert.equal(h.state.undo.length,0);assert.equal(h.current,input);
    await h.dispatch('keydown',input,{key:'Enter',isComposing:false,keyCode:13});
    assert.equal(template.name,'中文模板名称');assert.equal(h.state.undo.length,1);
  }
});

test('empty and overlong names never reach storage, input clears validity, and Enter on the unchanged name adds no undo',async()=>{
  for(const draft of ['   ','长'.repeat(61)]){
    const h=harness(),template=h.state.data.templates[0],name=template.name;
    await h.dispatch('click',h.mount('day',template.id));const input=h.current;input.value=draft;
    await h.dispatch('keydown',input,{key:'Enter'});
    assert.ok(input.validityMessage);assert.equal(input.reported,true);assert.equal(h.current,input);
    assert.equal(template.name,name);assert.equal(h.state.undo.length,0);assert.equal(h.state.dirty,false);
    input.value=name;await h.dispatch('input',input);assert.equal(input.validityMessage,'');
    await h.dispatch('keydown',input,{key:'Enter'});
    assert.equal(h.current.tagName,'BUTTON');assert.equal(h.document.activeElement,h.current);
    assert.equal(h.state.undo.length,0);assert.equal(h.state.dirty,false);assert.equal(h.renders,0);
  }
});

test('renaming titles protects active drafts from background refresh and renders escaped names as title buttons',async()=>{
  const h=harness(),day=h.state.data.templates[0],week=h.state.data.weekTemplates[0];
  day.name='名称 <img src=x>';week.name='每周 <b>标题</b>';
  assert.match(h.templateCards(),/data-action="edit-template-title"[^>]*data-kind="day"/);
  assert.match(h.weekCards(),/data-action="edit-template-title"[^>]*data-kind="week"/);
  assert.match(h.templateCards(),/名称 &lt;img src=x&gt;/);assert.equal(h.templateCards().includes('<img src=x>'),false);
  assert.match(h.weekCards(),/每周 &lt;b&gt;标题&lt;\/b&gt;/);assert.equal(h.weekCards().includes('<b>标题</b>'),false);
  await h.dispatch('click',h.mount('day',day.id));h.current.value='尚未确认';await h.refresh();
  assert.equal(h.requests,0);assert.equal(h.current.tagName,'INPUT');assert.equal(h.current.value,'尚未确认');
});
