import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as planner from '../lib/planner.mjs';
import * as trackingModel from '../lib/tracking.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const databaseKey='dayloom-portable-db',cacheKey='dayloom-v1-portable-preview';
function legacyData(){
  const data=planner.seedData();delete data.tags;
  const strip=value=>{if(!value||typeof value!=='object')return;delete value.tagId;Object.values(value).forEach(strip);};
  strip(data);data.groups.find(group=>group.id==='rest').countTowardsCompletion=false;
  return data;
}
function writeRow(storage,data,revision,mutationId='previous-save'){
  storage.set(databaseKey,JSON.stringify({data,revision,mutationId}));
}
function harness(storage=new Map(),request){
  const listeners={},scheduled=new Map(),requests=[],notices=[];
  const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  const adapter=vm.createContext({validateData:planner.validateData,Response,localStorage});
  vm.runInContext(readFileSync(new URL('../portable-adapter.js',import.meta.url),'utf8')+'\nglobalThis.adapterFetch=fetch;',adapter);
  let nextTimer=0,nextId=0;
  const app={innerHTML:''},modal={open:false,close(){this.open=false;}};
  const context=vm.createContext({...planner,trackingModel,TextEncoder,Intl,Date,Uint8Array,URL,Blob,
    crypto:{randomUUID:()=>`migration-${++nextId}`},
    installPlanLinks(){},refreshPlanLinks(){},createTrackingUI:()=>({action:()=>false}),
    document:{activeElement:null,querySelector:selector=>selector==='#modal'?modal:selector==='#app'?app:null,
      querySelectorAll:()=>[],addEventListener(type,listener){(listeners[type]??=[]).push(listener);}},
    window:{addEventListener(){}},localStorage,
    setTimeout(callback){const id=++nextTimer;scheduled.set(id,callback);return id;},clearTimeout:id=>scheduled.delete(id),setInterval(){},
    fetch:async(path,options={})=>{
      requests.push({path,...clone(options)});
      return request?request(path,options,adapter.adapterFetch):adapter.adapterFetch(path,options);
    },
  });
  const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\nboot\(\);\s*$/,'');
  vm.runInContext(source+'\nrender=()=>{};toast=message=>globalThis.captureNotice(message);globalThis.api={state,boot,refresh,save,commit};',context);
  context.captureNotice=message=>notices.push(message);
  return {...context.api,storage,requests,scheduled,notices,app,
    click:action=>listeners.click[0]({target:{closest:()=>({dataset:{action}})}})};
}

test('legacy API boot persists same-version label migration to the portable database and stays clean after reload',async()=>{
  const storage=new Map(),original=legacyData();writeRow(storage,original,4);
  const h=harness(storage);await h.boot();
  assert.equal(h.state.ready,true,h.app.innerHTML);assert.equal(h.state.dirty,true);assert.ok(h.scheduled.size);
  assert.equal(h.state.revision,4);assert.equal(h.state.data.tags.length,original.groups.length);
  assert.deepEqual(clone(h.state.data.groups),original.groups);
  assert.equal(JSON.parse(storage.get(databaseKey)).data.tags,undefined,'the pending migration is not assumed saved');
  assert.ok(JSON.parse(storage.get(cacheKey)).data.tasks.every(task=>task.tagId));
  await h.save();
  const saved=JSON.parse(storage.get(databaseKey));assert.equal(saved.revision,5);assert.ok(saved.data.tags.length);
  assert.equal(h.state.dirty,false);assert.equal(h.state.pending,null);
  const reopened=harness(storage);await reopened.boot();
  assert.equal(reopened.state.ready,true);assert.equal(reopened.state.dirty,false);assert.equal(reopened.state.revision,5);
});

test('offline legacy API boot migrates the cache and preserves the generated request across another restart',async()=>{
  const storage=new Map(),original=legacyData();
  storage.set(cacheKey,JSON.stringify({data:original,revision:3,dirty:false,pending:null}));
  const offline=(path,options,next)=>path==='/api/planner'?Promise.reject(Error('offline')):next(path,options);
  const first=harness(storage,offline);await first.boot();await first.save();
  assert.equal(first.state.ready,true);assert.equal(first.state.dirty,true);assert.ok(first.state.pending?.data.tags.length);
  const pending=JSON.stringify(first.state.pending);
  const reopened=harness(storage,offline);await reopened.boot();await reopened.save();
  assert.equal(JSON.stringify(reopened.state.pending),pending);assert.equal(reopened.state.dirty,true);
  assert.equal(reopened.requests.filter(r=>r.method==='PUT')[0].body,pending);
});

test('an empty legacy database uses revision zero when restoring a clean cached copy and its label migration',async()=>{
  const storage=new Map(),original=legacyData();original.tasks[0].title='数据库清空后保留的本机内容';
  storage.set(cacheKey,JSON.stringify({data:original,revision:9,dirty:false,pending:null}));
  const h=harness(storage);await h.boot();
  assert.equal(h.state.ready,true);assert.equal(h.state.revision,0,'a valid remote revision of zero must not fall back to the cache revision');
  assert.equal(h.state.data.tasks[0].title,original.tasks[0].title);assert.equal(h.state.dirty,true);
  await h.save();
  assert.equal(h.state.conflict,false);assert.equal(h.state.dirty,false);
  const saved=JSON.parse(storage.get(databaseKey));assert.equal(saved.revision,1);assert.ok(saved.data.tags.length);
  assert.equal(saved.data.tasks[0].title,original.tasks[0].title);
});

test('legacy pending retries keep their exact old payload, then persist label migration as a second guarded save',async()=>{
  const storage=new Map(),original=legacyData();original.tasks[0].title='已保存但响应丢失';
  const pending={data:clone(original),baseRevision:4,mutationId:'legacy-lost-response'};
  writeRow(storage,original,5,pending.mutationId);
  storage.set(cacheKey,JSON.stringify({data:original,revision:4,dirty:true,pending}));
  const h=harness(storage);await h.boot();
  assert.equal(JSON.stringify(h.state.pending),JSON.stringify(pending));assert.ok(h.state.data.tags.length);
  await h.save();
  assert.equal(h.requests.filter(r=>r.method==='PUT')[0].body,JSON.stringify(pending));
  assert.equal(h.state.revision,5);assert.equal(h.state.dirty,true);assert.equal(h.state.pending,null);
  assert.equal(JSON.parse(storage.get(databaseKey)).data.tags,undefined,'retry acknowledges only the exact pre-migration payload');
  await h.save();
  const second=JSON.parse(h.requests.filter(r=>r.method==='PUT')[1].body),saved=JSON.parse(storage.get(databaseKey));
  assert.equal(second.baseRevision,5);assert.notEqual(second.mutationId,pending.mutationId);
  assert.ok(second.data.tags.length);assert.equal(saved.data.tasks[0].title,original.tasks[0].title);
  assert.equal(saved.revision,6);assert.equal(h.state.dirty,false);
});

test('legacy API refresh caches and saves newly received legacy labels instead of silently treating migration as synchronized',async()=>{
  const storage=new Map();writeRow(storage,planner.seedData(),1);
  const h=harness(storage);await h.boot();
  const remote=legacyData();remote.tasks[0].title='另一端的旧版内容';writeRow(storage,remote,2,'remote-update');
  await h.refresh();
  assert.equal(h.state.revision,2);assert.equal(h.state.data.tasks[0].title,remote.tasks[0].title);
  assert.equal(h.state.dirty,true);assert.ok(h.scheduled.size);assert.equal(JSON.parse(storage.get(cacheKey)).dirty,true);
  await h.save();
  const saved=JSON.parse(storage.get(databaseKey));assert.equal(saved.revision,3);assert.ok(saved.data.tags.length);
  assert.equal(saved.data.tasks[0].title,remote.tasks[0].title);assert.equal(h.state.dirty,false);
});

test('choosing a legacy remote version clears the abandoned request and persists its migrated labels using the remote revision',async()=>{
  const storage=new Map();writeRow(storage,planner.seedData(),1);
  const h=harness(storage);await h.boot();h.commit(data=>{data.tasks[0].title='放弃的本机版本';});
  h.state.pending={data:clone(h.state.data),baseRevision:1,mutationId:'discarded-local'};h.state.conflict=true;
  const remote=legacyData();remote.tasks[0].title='选定的远端版本';writeRow(storage,remote,2,'remote-version');
  await h.click('confirm-cloud');
  assert.equal(h.state.conflict,false);assert.equal(h.state.pending,null);assert.equal(h.state.dirty,true);
  assert.equal(h.state.revision,2);assert.equal(h.state.data.tasks[0].title,remote.tasks[0].title);
  assert.ok(h.scheduled.size);assert.equal(JSON.parse(storage.get(cacheKey)).pending,null);
  await h.save();
  const sent=JSON.parse(h.requests.find(r=>r.method==='PUT').body),saved=JSON.parse(storage.get(databaseKey));
  assert.equal(sent.baseRevision,2);assert.notEqual(sent.mutationId,'discarded-local');
  assert.equal(saved.data.tasks[0].title,remote.tasks[0].title);assert.ok(saved.data.tags.length);assert.equal(h.state.dirty,false);
});

test('invalid remote label references leave the chosen local draft and pending retry intact',async()=>{
  const storage=new Map();writeRow(storage,planner.seedData(),1);
  let invalid=false;
  const h=harness(storage,(path,options,next)=>{
    if(invalid&&path==='/api/planner'&&options.method!=='PUT'){
      const data=planner.seedData();data.tasks[0].tagId='missing-label';return Response.json({data,revision:2});
    }
    return next(path,options);
  });
  await h.boot();h.commit(data=>{data.tasks[0].title='保留本机草稿';});
  h.state.pending={data:clone(h.state.data),baseRevision:1,mutationId:'preserved-retry'};h.state.conflict=true;
  const before=JSON.stringify(h.state.data),pending=JSON.stringify(h.state.pending);invalid=true;
  await h.click('confirm-cloud');
  assert.equal(JSON.stringify(h.state.data),before);assert.equal(JSON.stringify(h.state.pending),pending);
  assert.equal(h.state.conflict,true);assert.equal(h.state.revision,1);assert.match(h.notices.at(-1),/保留本机内容/);
});
