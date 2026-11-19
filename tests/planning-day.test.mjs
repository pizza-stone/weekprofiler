import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY_START,DAY_END,seedData,validateData,migrateData,planningDate,addDays,resolveDay} from '../lib/planner.mjs';

const block=(id,start,duration=30,extra={})=>({id,title:id,start,duration,category:'work',done:false,...extra});
const emptyDay=()=>({templateId:null,templateName:'',blocks:[]});
function legacyV2(){
  const data=seedData();data.version=2;
  data.days={};data.dayMeta={};data.weekTemplates=[];
  data.cycle={enabled:false,startDate:'2026-12-28',endDate:null,sourceWeekTemplateId:null,days:Array.from({length:7},emptyDay)};
  return data;
}
function actualSlots(data,first,last){
  const result=[];
  for(let date=addDays(first,-1);date<=last;date=addDays(date,1)){
    for(const b of resolveDay(data,date).blocks){
      for(let minute=b.start;minute<b.start+b.duration;minute+=30){
        const civil=addDays(date,Math.floor(minute/1440));
        if(civil>=first&&civil<=last)result.push(JSON.stringify([civil,minute%1440,b.title,b.category,b.taskId||null,b.done]));
      }
    }
  }
  return result.sort();
}

test('V3 validates 04:00 through next 04:00, while V1/V2 retain civil-day bounds',()=>{
  assert.equal(DAY_START,240);assert.equal(DAY_END,1680);
  const data=seedData();assert.equal(data.version,3);
  data.days['2026-11-15']=[block('full-planning-day',DAY_START,1440)];
  assert.equal(validateData(data),true);
  for(const [start,duration] of [[210,30],[1680,30],[1650,60],[239,30]]){
    data.days['2026-11-15']=[block('invalid',start,duration)];assert.equal(validateData(data),false);
  }
  const old=legacyV2();old.days['2026-11-15']=[block('midnight',0,1440)];
  assert.equal(validateData(old),true);
  old.days['2026-11-15']=[block('next-morning',1440)];assert.equal(validateData(old),false);
  const v1={version:1,timezone:old.timezone,tasks:old.tasks,templates:old.templates,days:{'2026-11-15':[block('midnight',0)]}};
  assert.equal(validateData(v1),true);assert.equal(migrateData(v1).version,3);
});

test('planningDate switches at local 04:00 across timezones, midnight, DST and New Year',()=>{
  assert.equal(planningDate('2026-12-31T19:59:59Z','Asia/Shanghai'),'2026-12-31');
  assert.equal(planningDate('2026-12-31T20:00:00Z','Asia/Shanghai'),'2027-01-01');
  assert.equal(planningDate('2027-01-01T00:00:00Z','UTC'),'2026-12-31');
  assert.equal(planningDate('2027-03-14T10:59:00Z','America/Los_Angeles'),'2027-03-13');
  assert.equal(planningDate('2027-03-14T11:00:00Z','America/Los_Angeles'),'2027-03-14');
  assert.equal(planningDate('2027-11-07T11:59:00Z','America/Los_Angeles'),'2027-11-06');
  assert.equal(planningDate('2027-11-07T12:00:00Z','America/Los_Angeles'),'2027-11-07');
  assert.throws(()=>planningDate('invalid','UTC'));
  assert.throws(()=>planningDate(new Date(),'Invalid/Timezone'));
});

test('legacy dates retain actual moments and completion when moving or splitting at 04:00',()=>{
  const old=legacyV2();
  old.days['2027-01-01']=[block('early',30,60,{done:true,taskId:'task-focus'}),block('crossing',210,60),block('daytime',480,60)];
  old.dayMeta['2027-01-01']={templateId:'template-workday',templateName:'Original day'};
  const before=structuredClone(old),data=migrateData(old);
  assert.deepEqual(old,before);
  assert.deepEqual(actualSlots(data,'2026-12-30','2027-01-02'),actualSlots(old,'2026-12-30','2027-01-02'));
  assert.deepEqual(data.days['2026-12-31'].map(b=>[b.start,b.duration]),[[1470,60],[1650,30]]);
  assert.deepEqual(data.days['2027-01-01'].map(b=>[b.start,b.duration]),[[240,30],[480,60]]);
  assert.equal(data.days['2026-12-31'][0].done,true);
  assert.equal(data.dayMeta['2027-01-01'].templateName,'Original day');
  assert.equal(validateData(data),true);
  assert.deepEqual(migrateData(data),data);
});

test('day templates put early hours at the end and split crossing tasks with valid unique IDs',()=>{
  const old=legacyV2(),longId='a'.repeat(128);
  old.templates=[{id:'overnight',name:'Night',description:'',blocks:[block(longId,120,180),block('late',1380,60)]}];
  const data=migrateData(old),blocks=data.templates[0].blocks;
  assert.deepEqual(blocks.map(b=>[b.start,b.duration]),[[240,60],[1380,60],[1560,120]]);
  assert.equal(new Set(blocks.map(b=>b.id)).size,3);
  assert.ok(blocks.every(b=>b.id.length<=128));
  assert.equal(blocks.reduce((total,b)=>total+b.duration,0),240);
  assert.equal(validateData(data),true);
});

test('weekly snapshots move Monday morning to Sunday and remain independent of source templates',()=>{
  const old=legacyV2();
  old.cycle.days[0]={templateId:'template-workday',templateName:'Monday',blocks:[block('monday-early',60,60),block('monday-cross',210,60)]};
  old.cycle.days[6]={templateId:null,templateName:'Sunday',blocks:[block('sunday-late',1380,60)]};
  old.weekTemplates=[{id:'week-night',name:'Night week',description:'',days:structuredClone(old.cycle.days)}];
  const data=migrateData(old);
  assert.deepEqual(data.cycle.days[0].blocks.map(b=>[b.start,b.duration]),[[240,30]]);
  assert.deepEqual(data.cycle.days[6].blocks.map(b=>[b.start,b.duration]),[[1380,60],[1500,60],[1650,30]]);
  const weekBefore=structuredClone(data.weekTemplates[0]);
  data.cycle.days[6].blocks[0].title='Changed only active cycle';
  assert.deepEqual(data.weekTemplates[0],weekBefore);
  assert.equal(validateData(data),true);
});

test('migration preserves recurring actual-time slots, saved blank exceptions and finite range edges',()=>{
  const old=legacyV2();old.cycle.enabled=true;old.cycle.endDate='2027-01-03';
  old.cycle.days=Array.from({length:7},(_,i)=>({templateId:null,templateName:'Weekday '+i,blocks:[
    block('morning-'+i,30,60),block('cross-'+i,210,60),block('focus-'+i,540,60),block('evening-'+i,1410,30),
  ]}));
  old.days['2026-12-29']=[];
  old.days['2026-12-31']=[block('same-id',1380,60,{done:true})];
  old.days['2027-01-01']=[block('same-id',30,60,{done:true})];
  const data=migrateData(old);
  assert.deepEqual(actualSlots(data,'2026-12-26','2027-01-05'),actualSlots(old,'2026-12-26','2027-01-05'));
  assert.ok(Object.hasOwn(data.days,'2026-12-27'));
  assert.ok(Object.hasOwn(data.days,'2027-01-03'));
  assert.equal(data.days['2027-01-03'].some(b=>b.start>=1440),false);
  assert.equal(data.days['2026-12-28'].some(b=>b.start>=1440),false);
  assert.equal(new Set(data.days['2026-12-31'].map(b=>b.id)).size,2);
  assert.equal(validateData(data),true);
  assert.deepEqual(migrateData(old),data);
});

test('a one-day full-day legacy cycle does not duplicate or lose boundary hours',()=>{
  const old=legacyV2();old.cycle.enabled=true;old.cycle.endDate=old.cycle.startDate;
  old.cycle.days=Array.from({length:7},()=>({...emptyDay(),blocks:[block('full',0,1440)]}));
  const data=migrateData(old);
  assert.deepEqual(actualSlots(data,'2026-12-26','2026-12-30'),actualSlots(old,'2026-12-26','2026-12-30'));
  assert.equal(data.days['2026-12-27'][0].duration,240);
  assert.equal(data.days['2026-12-28'][0].duration,1200);
  assert.equal(validateData(data),true);
});

test('disabled legacy cycles stay disabled and saved blank dates remain explicit exceptions',()=>{
  const old=legacyV2();old.days['2026-12-29']=[];
  old.cycle.days[0].blocks=[block('inactive',30,60)];
  const data=migrateData(old);
  assert.equal(data.cycle.enabled,false);
  assert.deepEqual(data.days,{'2026-12-29':[]});
  assert.deepEqual(actualSlots(data,'2026-12-26','2027-01-03'),[]);
});

test('sparse legacy date limits still migrate when early events double the number of date entries',()=>{
  const old=legacyV2();
  for(let i=0;i<3660;i++){
    old.days[addDays('2020-01-02',i*2)]=[block('early',60)];
    old.dayMeta[addDays('1980-01-01',i)]={templateId:null,templateName:'Retained historical metadata'};
  }
  assert.equal(validateData(old),true);
  const data=migrateData(old);
  assert.equal(Object.keys(data.days).length,7320);
  assert.equal(Object.keys(data.dayMeta).length,10980);
  assert.equal(validateData(data),true);
});

test('mixed recurring and saved civil days preserve actual slots across deterministic migration samples',()=>{
  let randomState=783265;
  const random=max=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState%max;};
  const randomBlocks=()=>{
    const result=[];
    for(let start=0;start<1440;){
      const duration=Math.min((random(6)+1)*30,1440-start);
      if(random(3))result.push(block('slot-'+start,start,duration,{done:random(2)===0}));
      start+=duration;
    }
    return result;
  };
  for(let sample=0;sample<24;sample++){
    const old=legacyV2();old.cycle.enabled=sample%4!==0;
    old.cycle.endDate=sample%3===0?null:'2027-01-03';
    old.cycle.days=Array.from({length:7},()=>({...emptyDay(),blocks:randomBlocks()}));
    for(let offset=-2;offset<10;offset++)if(random(3)===0)old.days[addDays(old.cycle.startDate,offset)]=random(3)===0?[]:randomBlocks();
    assert.equal(validateData(old),true);
    const data=migrateData(old);
    assert.deepEqual(actualSlots(data,'2026-12-25','2027-01-10'),actualSlots(old,'2026-12-25','2027-01-10'),'migration sample '+sample);
    assert.equal(validateData(data),true);
  }
});
