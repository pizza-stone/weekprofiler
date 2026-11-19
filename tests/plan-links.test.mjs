import test from 'node:test';
import assert from 'node:assert/strict';
import {pairPlanLinks,planLinkPath,refreshPlanLinks,installPlanLinks} from '../web/plan-links.js';

const day='2026-11-16',instant=(minute,date=day)=>Date.parse(date+'T00:00:00Z')+minute*60000;
const plan=(blockId,minute=600,extra={})=>({role:'plan',blockId,planDate:day,title:'同名任务',category:'learn',taskId:'read',startAt:instant(minute),...extra});
const actual=(recordId,minute=600,extra={})=>({role:'actual',recordId,blockId:'morning',planDate:day,title:'同名任务',category:'learn',taskId:'read',startAt:instant(minute),segmentStart:instant(minute),...extra});
const pairs=result=>result.groups.map(group=>[group.plan.blockId,...group.actuals.map(card=>card.recordId)]);

test('repeated tasks match morning and afternoon once each even when records reference the morning plan',()=>{
  const cards=[plan('morning',540),plan('afternoon',840),actual('first',550),actual('second',850)],before=structuredClone(cards);
  const result=pairPlanLinks(cards);
  assert.deepEqual(pairs(result),[['morning','first'],['afternoon','second']]);assert.equal(result.unmatched.length,0);
  assert.ok(result.groups.every(group=>group.actuals.length===1));assert.deepEqual(cards,before);
  assert.deepEqual(pairs(pairPlanLinks([...cards].reverse())),pairs(result));
});

test('one plan selects only its nearest exact start while unmatched actual records remain visible',()=>{
  const far=actual('far',540),nearest=actual('nearest',600+1/60000),roundedTie=actual('rounded-tie',601);
  const result=pairPlanLinks([plan('one',600),far,roundedTie,nearest]);
  assert.deepEqual(pairs(result),[['one','nearest']]);assert.deepEqual(result.unmatched.map(item=>item.card),[far,roundedTie]);
  assert.deepEqual(pairs(pairPlanLinks([plan('morning',540),plan('afternoon',840),actual('only',830)])),[['afternoon','only']]);
});

test('chronological optimum avoids the crossing caused by picking the shortest edge first',()=>{
  const cards=[plan('early',600),plan('late',660),actual('first',640),actual('second',720)];
  assert.deepEqual(pairs(pairPlanLinks(cards)),[['early','first'],['late','second']]);
  const extra=actual('distant',1200);
  assert.deepEqual(pairs(pairPlanLinks([extra,...cards])),[['early','first'],['late','second']]);
});

test('equal distances use original references then stable chronological IDs',()=>{
  assert.deepEqual(pairs(pairPlanLinks([plan('early',600),plan('late',660),actual('only',630,{blockId:'late'})])),[['late','only']]);
  const cards=[plan('one',600),actual('later',610),actual('earlier',590)];
  assert.deepEqual(pairs(pairPlanLinks(cards)),[['one','earlier']]);
  assert.deepEqual(pairs(pairPlanLinks([...cards].reverse())),[['one','earlier']]);
});

test('task IDs and categories separate names; title fallback applies only when both task IDs are absent',()=>{
  const wrongId=actual('wrong-id',600,{taskId:'different'}),wrongGroup=actual('wrong-group',600,{category:'rest'});
  const withoutId=actual('without-id',600,{taskId:''});
  assert.equal(pairPlanLinks([plan('one'),wrongId,wrongGroup,withoutId]).groups.length,0);
  assert.deepEqual(pairs(pairPlanLinks([plan('manual',600,{taskId:'',title:' 同名任务 '}),withoutId])),[['manual','without-id']]);
});

test('original plan day is retained for cross-day recordings and different plan days never compete',()=>{
  const monday=plan('monday',1650),tuesday=plan('tuesday',270,{planDate:'2026-11-17',startAt:instant(270,'2026-11-17')});
  const late=actual('late',1710,{displayDate:'2026-11-17'}),next=actual('next',1800,{planDate:'2026-11-17'});
  assert.deepEqual(pairs(pairPlanLinks([tuesday,next,late,monday])),[['monday','late'],['tuesday','next']]);
});

test('split session or timer cards consume only one plan and use the earliest visible segment',()=>{
  for(const recordId of ['session:one','timer:one']){
    const first=actual(recordId,1650),next=actual(recordId,1650,{segmentStart:instant(1680)});
    const result=pairPlanLinks([plan('night',1620),plan('later',1650),next,first]);
    assert.deepEqual(pairs(result),[['later',recordId]]);assert.equal(result.groups[0].actuals[0],first);
    assert.equal(result.unmatched[0].card,next);assert.equal(result.unmatched[0].reason,'continuation');
  }
});

test('temporary, orphan, invalid and unrelated records do not acquire a misleading line',()=>{
  const cards=[plan('one'),actual('temp',600,{unplanned:true}),actual('orphan',600,{hasOrigin:false}),actual('other-day',600,{planDate:'2026-11-17'}),actual('bad-time',600,{startAt:NaN})];
  const result=pairPlanLinks(cards);assert.deepEqual(result.groups,[]);
  assert.deepEqual(result.unmatched.map(item=>item.reason),['unplanned','unmatched','unmatched','unmatched']);
  assert.deepEqual(pairPlanLinks([]),{groups:[],unmatched:[]});
});

test('curves retain the right plan edge and left actual edge for either cross-day direction',()=>{
  for(const [start,end] of [[{x:100,y:12},{x:110,y:600}],[{x:600,y:300},{x:10,y:20}],[{x:100,y:20},{x:110,y:20}]]){
    const path=planLinkPath(start,end);
    assert.ok(path.startsWith('M '+start.x+' '+start.y+' C '));assert.ok(path.endsWith(', '+end.x+' '+end.y));
    assert.equal(/NaN|Infinity/.test(path),false);
  }
});

function fakeDOM(){
  const listeners=new Map(),windowListeners=new Map(),queue=[];
  const classes=()=>({values:new Set(),toggle(name,on){on?this.values.add(name):this.values.delete(name);},remove(name){this.values.delete(name);}});
  const doc={activeElement:null,createElementNS:(_ns,name)=>({name,attributes:{},children:[],classList:classes(),setAttribute(k,v){this.attributes[k]=v;},append(node){this.children.push(node);},remove(){this.removed=true;}})};
  doc.defaultView={addEventListener:(type,fn)=>windowListeners.set(type,fn),removeEventListener:type=>windowListeners.delete(type),requestAnimationFrame:fn=>{queue.push(fn);return queue.length;},cancelAnimationFrame:()=>{}};
  const card=(role,id,date,left,top,unplanned=false)=>({
    dataset:{linkRole:role,planBlock:id,planDate:date,unplanned:String(unplanned),linkTask:id,linkCategory:'learn',linkTitle:'原有标题',linkInstant:String(instant(600)),linkRecord:role==='actual'?'session:'+id:undefined,linkSegment:String(instant(600))},attributes:{title:'原有标题'},classList:classes(),
    getAttribute(name){return this.attributes[name]??null;},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},
    getBoundingClientRect:()=>({left,right:left+80,top,width:80,height:23}),closest(selector){return selector==='[data-plan-links]'?board:this;},contains(node){return node===this;},matches:()=>false,
  });
  const first=card('plan','one','2026-11-16',20,10),second=card('actual','one','2026-11-16',120,40),temporary=card('actual','two','2026-11-16',120,100,true);
  const board={ownerDocument:doc,children:[],querySelectorAll:()=>[first,second,temporary],getBoundingClientRect:()=>({left:0,top:0,width:220,height:1248}),append(node){this.children.push(node);}};
  Object.assign(doc,{querySelectorAll:()=>[board],contains:node=>[first,second,temporary].includes(node),addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)});
  return {doc,board,first,second,temporary,listeners,windowListeners,queue};
}

test('refresh replaces paths, preserves original tooltips and geometry, and removes stale highlights',()=>{
  const dom=fakeDOM();refreshPlanLinks(dom.doc);
  const layer=dom.board.children.at(-1);
  assert.equal(layer.children.length,1);assert.equal(layer.attributes['aria-hidden'],'true');
  assert.ok(layer.children[0].attributes.d.startsWith('M 100 21.5 C '));
  assert.equal(dom.first.attributes['data-link-label'],'1');assert.equal(dom.second.attributes['data-link-label'],'1');
  assert.equal(dom.temporary.attributes['data-link-state'],'unplanned');
  const title=dom.first.attributes.title;refreshPlanLinks(dom.doc);
  assert.equal(layer.removed,true);assert.equal(dom.first.attributes.title,title,'refresh does not stack tooltip annotations');
  dom.second.dataset.linkTask='different';refreshPlanLinks(dom.doc);
  assert.equal(dom.board.children.at(-1).children.length,0);
  assert.equal(dom.first.attributes.title,'原有标题');assert.equal(dom.first.attributes['data-link-label'],undefined);
  assert.equal(dom.second.attributes['data-link-state'],'unmatched');
});

test('rendered full-day ownership takes precedence over stored references and visible-card rematching',()=>{
  const dom=fakeDOM();
  dom.second.dataset.planBlock='old-reference';
  dom.second.dataset.linkOwner='one';
  refreshPlanLinks(dom.doc);
  assert.equal(dom.board.children.at(-1).children.length,1);
  assert.equal(dom.first.attributes['data-link-state'],'matched');
  dom.second.dataset.linkOwner='not-visible';
  refreshPlanLinks(dom.doc);
  assert.equal(dom.board.children.at(-1).children.length,0,'do not borrow a visible same-task plan from a different ownership');
  dom.second.dataset.linkOwner='';
  refreshPlanLinks(dom.doc);
  assert.equal(dom.board.children.at(-1).children.length,0,'an unassigned record cannot acquire a line from its old reference');
});

test('installation is idempotent and hover or keyboard focus highlights both cards without intercepting clicks',()=>{
  const dom=fakeDOM(),dispose=installPlanLinks(dom.doc);
  assert.equal(installPlanLinks(dom.doc),dispose);assert.equal(dom.listeners.size,4);assert.equal(dom.listeners.has('click'),false);
  dom.listeners.get('pointerover')({target:dom.second});
  assert.equal(dom.first.classList.values.has('plan-link-active'),true);assert.equal(dom.second.classList.values.has('plan-link-active'),true);
  assert.equal(dom.board.children.at(-1).children[0].classList.values.has('is-active'),true);
  dom.listeners.get('pointerout')({relatedTarget:null});assert.equal(dom.first.classList.values.has('plan-link-active'),false);
  dom.doc.activeElement=dom.first;dom.listeners.get('focusin')({target:dom.first});
  assert.equal(dom.second.classList.values.has('plan-link-active'),true);
  dom.listeners.get('pointerover')({target:dom.temporary});assert.equal(dom.first.classList.values.has('plan-link-active'),false);
  dom.listeners.get('focusin')({target:dom.first});assert.equal(dom.first.classList.values.has('plan-link-active'),true,'keyboard focus takes precedence over a stationary pointer on a different card');
  dom.listeners.get('pointerout')({relatedTarget:null});
  dom.listeners.get('focusout')({relatedTarget:null});assert.equal(dom.first.classList.values.has('plan-link-active'),false);
  dom.windowListeners.get('resize')();dom.windowListeners.get('resize')();assert.equal(dom.queue.length,1);dom.queue[0]();
  dispose();assert.equal(dom.listeners.size,0);assert.equal(dom.windowListeners.size,0);assert.equal(dom.first.attributes.title,'原有标题');
});
