import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { seedData, validateData, materializeDay, createTagSlot, assignTagSlot } from '../lib/planner.mjs';
import { startTracking, stopTracking } from '../lib/tracking.mjs';
import { createChanges, applyChanges, rebaseChanges, readChangeValue, SyncConflictError, validateChanges } from '../lib/sync.mjs';
import { handleSync } from '../worker/sync-api.mjs';

const endpoint='https://weekprofiler.example/api/sync';
const copy=value=>structuredClone(value);
function environment(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0000_planner.sql','0001_sync.sql'])sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
  const wrap=(sql,params=[])=>({sql,params,bind(...values){return wrap(sql,values);},async first(){return sqlite.prepare(sql).get(...params)??null;}});
  const env={sqlite,failAck:false,DB:{prepare:wrap,async batch(statements){
    sqlite.exec('BEGIN');try{
      const results=statements.map((statement,index)=>{if(env.failAck&&index===1)throw Error('ack failed');return sqlite.prepare(statement.sql).run(...statement.params);});
      sqlite.exec('COMMIT');return results;
    }catch(error){sqlite.exec('ROLLBACK');throw error;}
  }},close:()=>sqlite.close()};return env;
}
function post(input,headers={}){return new Request(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(endpoint).origin,...headers},body:JSON.stringify(input)});}
async function read(env,user='alice',revision){return (await handleSync(new Request(endpoint+(revision===undefined?'':'?revision='+revision)),env,user)).json();}
async function write(env,input,user='alice'){const response=await handleSync(post(input),env,user);return {status:response.status,...await response.json()};}
async function initial(env,data=seedData(),user='alice'){const result=await write(env,{mutationId:'init',baseRevision:0,baseTimerRevision:0,replace:true,data},user);assert.equal(result.status,200);return result;}
function change(base,next,id,extra={}){return {mutationId:id,baseRevision:base.revision,baseTimerRevision:base.timerRevision,changes:createChanges(base.data,next),...extra};}
function withDay(){const data=seedData();data.days['2026-11-16']=[{id:'block-a',title:'阅读',start:600,duration:60,category:'learn',done:false}];data.dayMeta['2026-11-16']={templateId:null,templateName:'自定义安排'};return data;}

test('guarded edits merge different task fields and independent template edits',()=>{
  const base=seedData(),desktop=copy(base),mobile=copy(base);
  desktop.tasks[0].duration=90;desktop.templates[0].notes='桌面备注';mobile.tasks[0].done=true;
  const merged=applyChanges(mobile,createChanges(base,desktop));
  assert.equal(merged.tasks[0].duration,90);assert.equal(merged.tasks[0].done,true);assert.equal(merged.templates[0].notes,'桌面备注');assert.equal(validateData(merged),true);
  assert.equal(base.tasks[0].duration,60);assert.equal(mobile.templates[0].notes,undefined);
});

test('group completion preferences sync independently of concurrent group names and reject invalid values',async()=>{
  const env=environment();try{
    const base=await initial(env),desktop=copy(base.data),phone=copy(base.data);
    desktop.groups.find(group=>group.id==='life').countTowardsCompletion=false;
    phone.groups.find(group=>group.id==='life').name='日常生活';
    assert.equal((await write(env,change(base,phone,'rename-life'))).status,200);
    assert.equal((await write(env,change(base,desktop,'exclude-life'))).status,200);
    const current=await read(env),life=current.data.groups.find(group=>group.id==='life');
    assert.equal(life.name,'日常生活');assert.equal(life.countTowardsCompletion,false);
    const invalid=copy(current.data);invalid.groups.find(group=>group.id==='life').countTowardsCompletion='false';
    const rejected=await write(env,change(current,invalid,'invalid-life'));
    assert.equal(rejected.status,409);assert.deepEqual(rejected.conflicts,[['validation']]);
    assert.deepEqual((await read(env)).data,current.data);
    const restored=copy(current.data);restored.groups.find(group=>group.id==='life').countTowardsCompletion=true;
    assert.equal((await write(env,change(current,restored,'include-life'))).status,200);
    assert.equal((await read(env)).data.groups.find(group=>group.id==='life').countTowardsCompletion,true);
  }finally{env.close();}
});

test('cloud stores project and label edits independently and restores both through full backup replacement',async()=>{
  const env=environment();try{
    const base=await initial(env),desktop=copy(base.data),phone=copy(base.data);
    desktop.tasks[0].category='work';desktop.groups[0].name='进行中的课题';
    phone.tags.push({id:'focus',name:'专注',color:'#123456',countTowardsCompletion:false});phone.tasks[0].tagId='focus';
    assert.equal((await write(env,change(base,desktop,'project-change'))).status,200);
    assert.equal((await write(env,change(base,phone,'label-change'))).status,200);
    const current=await read(env);
    assert.equal(current.data.tasks[0].category,'work');assert.equal(current.data.tasks[0].tagId,'focus');
    assert.equal(current.data.tags.find(tag=>tag.id==='focus').countTowardsCompletion,false);
    const backup=JSON.parse(JSON.stringify(current.data));backup.tags.find(tag=>tag.id==='focus').color='#654321';
    const replaced=await write(env,{mutationId:'restore-labels',baseRevision:current.revision,baseTimerRevision:current.timerRevision,replace:true,data:backup});
    assert.equal(replaced.status,200);assert.deepEqual((await read(env)).data,backup);
  }finally{env.close();}
});
test('cloud persists dated slot assignments and keeps the first choice on a stale device write',async()=>{
  const env=environment(),date='2026-11-16';
  try{
    const data=seedData(),slot=createTagSlot('study','learn',600,90);
    data.templates[0].blocks=[copy(slot)];
    data.days[date]=[copy(slot)];
    const base=await initial(env,data),phone=copy(base.data),desktop=copy(base.data);
    assignTagSlot(phone,date,slot.id,'task-read',60);
    assignTagSlot(desktop,date,slot.id,'task-notes');
    const saved=await write(env,change(base,phone,'fill-on-phone'));
    assert.equal(saved.status,200);
    assert.equal((await write(env,change(base,desktop,'fill-on-desktop'))).status,409);
    const current=await read(env);
    assert.deepEqual(current.data.days[date],phone.days[date]);
    assert.deepEqual(current.data.templates[0].blocks,[slot]);
  }finally{env.close();}
});
test('same field conflicts, deletion versus edits conflicts, and user rebase preserves remote fields',()=>{
  const base=seedData(),desktop=copy(base),mobile=copy(base);desktop.tasks[0].title='电脑';mobile.tasks[0].title='手机';mobile.tasks[0].done=true;
  const changes=createChanges(base,desktop);
  assert.throws(()=>applyChanges(mobile,changes),error=>error instanceof SyncConflictError&&error.paths[0].at(-1)==='title');
  const resolved=applyChanges(mobile,rebaseChanges(mobile,changes));assert.equal(resolved.tasks[0].title,'电脑');assert.equal(resolved.tasks[0].done,true);
  desktop.tasks.shift();assert.throws(()=>applyChanges(mobile,createChanges(base,desktop)),SyncConflictError);
  const deleted=copy(base);deleted.tasks.shift();assert.throws(()=>rebaseChanges(deleted,changes),SyncConflictError);
});
test('stable record ids merge additions, preserve local ordering changes, and expose missing values',()=>{
  const base=seedData(),a=copy(base),b=copy(base);a.tasks.push({...a.tasks[0],id:'task-a'});b.tasks.push({...b.tasks[0],id:'task-b'});
  const merged=applyChanges(b,createChanges(base,a));assert.equal(merged.tasks.length,base.tasks.length+2);
  const ordered=copy(base);ordered.tasks.reverse();assert.deepEqual(applyChanges(base,createChanges(base,ordered)).tasks,ordered.tasks);
  const inserted=copy(base);inserted.tasks.splice(1,0,{...base.tasks[0],id:'middle'});assert.deepEqual(applyChanges(base,createChanges(base,inserted)).tasks,inserted.tasks);
  assert.deepEqual(readChangeValue(merged,['tasks',{id:'task-a'},'title']),{exists:true,value:base.tasks[0].title});
  assert.deepEqual(readChangeValue(merged,['tasks',{id:'absent'},'title']),{exists:false});
});
test('tracking defaults normalize so separate offline sessions can merge',()=>{
  const base=withDay(),one=copy(base),two=copy(base);
  const session=(id,start)=>({id,planDate:'2026-11-16',blockId:'block-a',title:'阅读',category:'learn',startedAt:start,endedAt:start+1000});
  one.tracking={timer:null,sessions:[session('one',1000)]};two.tracking={timer:null,sessions:[session('two',3000)]};
  const merged=applyChanges(two,createChanges(base,one));assert.equal(merged.tracking.sessions.length,2);assert.equal(validateData(merged),true);
  assert.throws(()=>rebaseChanges(two,createChanges(base,one)),SyncConflictError);
});
test('first edits of one virtual cycle date merge schedule fields and completion by block id',()=>{
  const base=seedData();base.cycle.enabled=true;base.cycle.startDate='2026-01-01';
  const desktop=copy(base),phone=copy(base);
  materializeDay(desktop,'2026-11-16')[0].title='桌面调整标题';
  materializeDay(phone,'2026-11-16')[0].done=true;
  const merged=applyChanges(phone,createChanges(base,desktop));
  assert.equal(merged.days['2026-11-16'][0].title,'桌面调整标题');assert.equal(merged.days['2026-11-16'][0].done,true);assert.equal(validateData(merged),true);
  const changedCycle=copy(base);changedCycle.cycle.days[0].blocks[0].title='新的循环标题';
  assert.throws(()=>applyChanges(changedCycle,createChanges(base,desktop)),SyncConflictError);
});
test('first independent additions to one empty date merge only after sharing its empty baseline',()=>{
  const base=seedData(),desktop=copy(base),phone=copy(base);
  materializeDay(desktop,'2026-11-16').push({id:'a',title:'A',start:600,duration:60,category:'work',done:false});
  materializeDay(phone,'2026-11-16').push({id:'b',title:'B',start:720,duration:60,category:'work',done:false});
  const merged=applyChanges(phone,createChanges(base,desktop));assert.equal(merged.days['2026-11-16'].length,2);assert.equal(validateData(merged),true);
});
test('timer preconditions are strict even if the target state was already reached',()=>{
  const base=withDay();startTracking(base,'2026-11-16',base.days['2026-11-16'][0],1000,'timer-one');
  const ended=copy(base);stopTracking(ended,3000,'session-one');
  assert.throws(()=>applyChanges(ended,createChanges(base,ended)),SyncConflictError);
});
test('malformed paths cannot pollute prototypes or mutate id-targeted records into another id',()=>{
  for(const path of [['__proto__','polluted'],['tasks',{id:'bad id'}],['tasks',{id:'task-reading'},'constructor'],[]])assert.equal(validateChanges([{path,after:1}]),false);
  assert.throws(()=>applyChanges(seedData(),[{path:['tasks',{id:'fake'}],after:{id:'other'}}]),TypeError);
  assert.equal({}.polluted,undefined);
});
test('cloud initial data, conditional reads, and mutation acknowledgements are scoped to user',async()=>{
  const env=environment();try{
    assert.deepEqual((await read(env)).data,null);
    const result=await initial(env);assert.equal(result.revision,1);assert.equal(result.timerRevision,1);assert.equal(result.ackMutationId,'init');
    const unchanged=await read(env,'alice',1);assert.equal(unchanged.unchanged,true);assert.equal(unchanged.data,undefined);
    assert.equal((await read(env,'bob')).data,null);
    assert.equal((await handleSync(new Request(endpoint),env,null)).status,401);
    const response=await handleSync(new Request(endpoint),env,'alice');assert.match(response.headers.get('Cache-Control'),/no-store/);
  }finally{env.close();}
});
test('an unchanged poll does not load or parse the stored document',async()=>{
  const env=environment();try{
    const base=await initial(env);const prepare=env.DB.prepare;
    env.DB.prepare=sql=>{if(/^SELECT data,/.test(sql))throw Error('document reads disabled for this poll');return prepare(sql);};
    const unchanged=await read(env,'alice',base.revision);assert.equal(unchanged.unchanged,true);assert.equal(unchanged.revision,base.revision);
  }finally{env.close();}
});
test('lost response retry stays idempotent after another device modifies the document',async()=>{
  const env=environment();try{
    const base=await initial(env),a=copy(base.data);a.tasks[0].done=true;
    const input=change(base,a,'device-a');const first=await write(env,input);assert.equal(first.status,200);
    const b=copy(first.data);b.templates[0].notes='另一设备';const second=await write(env,change(first,b,'device-b'));assert.equal(second.status,200);
    const retry=await write(env,input);assert.equal(retry.status,200);assert.equal(retry.revision,second.revision);assert.equal(retry.appliedRevision,first.revision);assert.equal(retry.data.templates[0].notes,'另一设备');
    const reused=await write(env,{...input,changes:[]});assert.equal(reused.status,409);assert.equal(reused.code,'MUTATION_ID_REUSED');
    assert.equal(env.sqlite.prepare('SELECT count(*) n FROM planner_mutations').get().n,3);
  }finally{env.close();}
});
test('concurrent non-conflicting writes are retried against the latest state',async()=>{
  const env=environment();try{
    const base=await initial(env),a=copy(base.data),b=copy(base.data);a.tasks[0].done=true;b.templates[0].notes='新备注';
    const results=await Promise.all([write(env,change(base,a,'a')),write(env,change(base,b,'b'))]);assert.deepEqual(results.map(r=>r.status),[200,200]);
    const current=await read(env);assert.equal(current.revision,3);assert.equal(current.data.tasks[0].done,true);assert.equal(current.data.templates[0].notes,'新备注');
  }finally{env.close();}
});
test('conflicting writes leave the losing edit available and never overwrite the winner',async()=>{
  const env=environment();try{
    const base=await initial(env),a=copy(base.data),b=copy(base.data);a.tasks[0].title='A';b.tasks[0].title='B';
    const results=await Promise.all([write(env,change(base,a,'a')),write(env,change(base,b,'b'))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const conflict=results.find(r=>r.status===409);assert.equal(conflict.conflicts[0].at(-1),'title');assert.equal(conflict.revision,2);
  }finally{env.close();}
});
test('state and acknowledgement transaction rolls back together if either write fails',async()=>{
  const env=environment();try{
    const base=await initial(env),next=copy(base.data);next.tasks[0].done=true;env.failAck=true;
    assert.equal((await write(env,change(base,next,'failed'))).status,503);env.failAck=false;
    assert.equal((await read(env)).revision,1);assert.equal(env.sqlite.prepare('SELECT count(*) n FROM planner_mutations').get().n,1);
    assert.equal((await write(env,change(base,next,'failed'))).status,200);
  }finally{env.close();}
});
test('cross-device start and end create one exact session, concurrent end cannot duplicate it',async()=>{
  const env=environment();try{
    const base=await initial(env,withDay()),running=copy(base.data);startTracking(running,'2026-11-16',running.days['2026-11-16'][0],1000,'timer-a');
    const started=await write(env,change(base,running,'start'));assert.equal(started.status,200);
    const endA=copy(started.data),endB=copy(started.data);stopTracking(endA,5500,'session-a');stopTracking(endB,6500,'session-b');
    const results=await Promise.all([write(env,change(started,endA,'end-a')),write(env,change(started,endB,'end-b'))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const current=await read(env);assert.equal(current.data.tracking.sessions.length,1);assert.equal(current.data.tracking.timer,null);
    assert.ok([5500,6500].includes(current.data.tracking.sessions[0].endedAt));
  }finally{env.close();}
});
test('timer version rejects stale null-to-running intent after another complete timer cycle',async()=>{
  const env=environment();try{
    const stale=await initial(env,withDay()),run=copy(stale.data);startTracking(run,'2026-11-16',run.days['2026-11-16'][0],1000,'first');
    const started=await write(env,change(stale,run,'start-first'));const end=copy(started.data);stopTracking(end,2000,'ended-first');
    assert.equal((await write(env,change(started,end,'stop-first'))).status,200);
    const other=copy(stale.data);startTracking(other,'2026-11-16',other.days['2026-11-16'][0],3000,'second');
    const conflict=await write(env,change(stale,other,'stale-start'));assert.equal(conflict.status,409);assert.deepEqual(conflict.conflicts,[['tracking','timer']]);
  }finally{env.close();}
});
test('independent actual records merge only if the resulting timeline is valid',async()=>{
  const env=environment();try{
    const base=await initial(env,withDay());
    const add=(id,start,end)=>{const data=copy(base.data);data.tracking={timer:null,sessions:[{id,planDate:'2026-11-16',blockId:'block-a',title:'阅读',category:'learn',startedAt:start,endedAt:end}]};return change(base,data,id);};
    assert.equal((await write(env,add('a',1000,2000))).status,200);
    assert.equal((await write(env,add('b',3000,4000))).status,200);
    const overlap=await write(env,add('overlap',1500,2500));assert.equal(overlap.status,409);assert.deepEqual(overlap.conflicts,[['validation']]);
    assert.equal((await read(env)).data.tracking.sessions.length,2);
  }finally{env.close();}
});
test('full backup replacement is strict and cannot silently merge over new remote changes',async()=>{
  const env=environment();try{
    const base=await initial(env),changed=copy(base.data);changed.tasks[0].done=true;await write(env,change(base,changed,'change'));
    const result=await write(env,{mutationId:'restore',baseRevision:base.revision,baseTimerRevision:base.timerRevision,replace:true,data:base.data});assert.equal(result.status,409);assert.equal(result.data.tasks[0].done,true);
    const latest=await read(env);const restored=await write(env,{mutationId:'restore-new',baseRevision:latest.revision,baseTimerRevision:latest.timerRevision,replace:true,data:base.data});assert.equal(restored.status,200);assert.equal(restored.data.tasks[0].done,false);
  }finally{env.close();}
});
test('future timer and record timestamps are kept as conflicts instead of silently corrected',async()=>{
  const env=environment();try{
    const base=await initial(env,withDay()),future=Date.now()+10*60*1000,running=copy(base.data);
    startTracking(running,'2026-11-16',running.days['2026-11-16'][0],future,'future-timer');
    const timerResult=await write(env,change(base,running,'future-start'));assert.equal(timerResult.status,409);assert.deepEqual(timerResult.paths,[['tracking','timer']]);
    const recorded=copy(base.data);recorded.tracking={timer:null,sessions:[{id:'future-record',planDate:'2026-11-16',blockId:'block-a',title:'阅读',category:'learn',startedAt:future,endedAt:future+1000}]};
    const recordResult=await write(env,change(base,recorded,'future-record'));assert.equal(recordResult.status,409);assert.equal(recordResult.paths[0][2].id,'future-record');
    const replacement=await write(env,{mutationId:'future-backup',baseRevision:base.revision,baseTimerRevision:base.timerRevision,replace:true,data:recorded});assert.equal(replacement.status,409);
    assert.equal((await read(env)).revision,base.revision);assert.equal(recorded.tracking.sessions[0].startedAt,future);
  }finally{env.close();}
});
test('unchanged historical timestamps are not rejected while editing unrelated content',async()=>{
  const env=environment();try{
    const data=withDay(),future=Date.now()+10*60*1000;data.tracking={timer:null,sessions:[{id:'legacy-future',planDate:'2026-11-16',blockId:'block-a',title:'阅读',category:'learn',startedAt:future,endedAt:future+1000}]};
    env.sqlite.prepare('INSERT INTO planner_states(user_id,data,revision,mutation_id,timer_revision) VALUES(?,?,?,?,?)').run('alice',JSON.stringify(data),1,'legacy',0);
    const base=await read(env),changed=copy(base.data);changed.tasks[0].title='不相关修改';
    assert.equal((await write(env,change(base,changed,'title-only'))).status,200);
  }finally{env.close();}
});
test('API rejects untrusted origins, invalid batches, missing timer versions, and user spoofing',async()=>{
  const env=environment();try{
    const base=await initial(env,withDay()),next=copy(base.data);next.tasks[0].done=true;const input=change(base,next,'new');
    assert.equal((await handleSync(post(input,{Origin:'https://evil.example'}),env,'alice')).status,403);
    assert.equal((await handleSync(post(input,{'Content-Type':'text/plain'}),env,'alice')).status,415);
    assert.equal((await write(env,{...input,userId:'bob'})).status,400);
    assert.equal((await write(env,{...input,changes:[{path:['__proto__','bad'],after:true}]})).status,400);
    const running=copy(base.data);materializeDay(running,'2026-11-16');startTracking(running,'2026-11-16',running.days['2026-11-16'][0],1000,'timer');
    const timerInput=change(base,running,'timer');delete timerInput.baseTimerRevision;assert.equal((await write(env,timerInput)).status,400);
    assert.equal((await read(env)).revision,1);
  }finally{env.close();}
});
