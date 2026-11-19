import { validateTracking } from './tracking.mjs';

/** @typedef {{id:string,name:string,color:string,countTowardsCompletion?:boolean}} Group */
/** @typedef {{id:string,name:string,color:string,countTowardsCompletion?:boolean}} Tag */
/** @typedef {{id:string,title:string,duration:number,category:string,tagId?:string,reusable:boolean,done:boolean}} Task */
/** @typedef {{id:string,taskId?:string,title:string,start:number,duration:number,category:string,tagId?:string,done:boolean}} TaskBlock */
/** @typedef {{id:string,kind:'tag-slot',tagId:string,title:string,start:number,duration:number,done:false}} TagSlot */
/** @typedef {TaskBlock | TagSlot} Block */
/** @typedef {{id:string,name:string,description:string,notes?:string,blocks:Block[]}} DayTemplate */
/** @typedef {{templateId:string|null,templateName:string,blocks:Block[]}} WeekDay */
/** @typedef {{id:string,name:string,description:string,notes?:string,days:WeekDay[]}} WeekTemplate */
/** @typedef {{version:3,groups:Group[],tags?:Tag[],tasks:Task[],templates:DayTemplate[],days:Record<string,Block[]>,dayMeta:Record<string,{templateId:string|null,templateName:string,weekTemplateId?:string}>,weekTemplates:WeekTemplate[],cycle:{enabled:boolean,startDate:string,endDate:string|null,sourceWeekTemplateId:string|null,days:WeekDay[]},timezone:string}} PlannerData */

export const MAX_STATE_BYTES = 3_000_000;
export const MAX_TEMPLATE_NOTES = 5000;
export const DAY_START = 240;
export const DAY_END = 1680;
const LEGACY_CATEGORIES = ['work', 'learn', 'life', 'rest'];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && ID_PATTERN.test(value);
const isTitle = (value,max=160) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const isDuration = value => Number.isInteger(value) && value>=30 && value<=1440 && value%30===0;
const isTemplateNotes = value => value===undefined || (typeof value==='string' && value.length<=MAX_TEMPLATE_NOTES);
const uniqueIds = values => new Set(values.map(value=>value.id)).size===values.length;
const copyPlannerValue = value => JSON.parse(JSON.stringify(value));
const ownsPlannerKey = (record,key) => Object.prototype.hasOwnProperty.call(record,key);

const isPlannerClassification = value => isRecord(value) && isId(value.id) && isTitle(value.name,40)
  && typeof value.color==='string' && /^#[0-9a-fA-F]{6}$/.test(value.color)
  && (value.countTowardsCompletion===undefined || typeof value.countTowardsCompletion==='boolean');
const isPlannerTagReference = (value,tags) => value.tagId===undefined || (isId(value.tagId) && tags.has(value.tagId));

function isTask(value,categories,tags) {
  return isRecord(value) && isId(value.id) && isTitle(value.title) && isDuration(value.duration)
    && categories.has(value.category) && isPlannerTagReference(value,tags) && typeof value.reusable==='boolean' && typeof value.done==='boolean';
}
export function isTagSlot(block) { return block?.kind==='tag-slot'; }
export function createTagSlot(id,tagId,start,duration) {
  return {id,kind:'tag-slot',tagId,title:'待选任务',start,duration,done:false};
}
function isBlock(value,categories,version,tags) {
  if(!isRecord(value) || !isId(value.id) || !isTitle(value.title) || !isDuration(value.duration)
    || !Number.isInteger(value.start) || value.start%30!==0 || value.start<(version===3?DAY_START:0)
    || value.start+value.duration>(version===3?DAY_END:1440))return false;
  if(isTagSlot(value))return version===3 && tags.has(value.tagId) && value.taskId===undefined && value.category===undefined && value.done===false;
  return value.kind===undefined && (value.taskId===undefined || isId(value.taskId)) && categories.has(value.category)
    && isPlannerTagReference(value,tags) && typeof value.done==='boolean';
}
function isBlocks(value,categories,version,tags) {
  if(!Array.isArray(value) || value.length>48 || !value.every(item=>isBlock(item,categories,version,tags)) || !uniqueIds(value))return false;
  const ordered=[...value].sort((a,b)=>a.start-b.start);
  return ordered.every((item,index)=>index===0 || ordered[index-1].start+ordered[index-1].duration<=item.start);
}
function isTemplate(value,categories,version,tags) {
  return isRecord(value) && isId(value.id) && isTitle(value.name,80)
    && typeof value.description==='string' && value.description.length<=500 && isTemplateNotes(value.notes)
    && isBlocks(value.blocks,categories,version,tags);
}
function isDateKey(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10)===value;
}
function isDayReference(value) {
  return isRecord(value) && (value.templateId===null || isId(value.templateId))
    && typeof value.templateName==='string' && value.templateName.length<=160;
}
function isWeekDays(value,categories,version,tags) {
  return Array.isArray(value) && value.length===7
    && value.every(day=>isDayReference(day) && isBlocks(day.blocks,categories,version,tags));
}
function isWeekTemplate(value,categories,version,tags) {
  return isRecord(value) && isId(value.id) && isTitle(value.name,80)
    && typeof value.description==='string' && value.description.length<=500 && isTemplateNotes(value.notes)
    && isWeekDays(value.days,categories,version,tags);
}
/** Validate each persisted version against its own clock bounds; never modify input. */
export function validateData(value) {
  try {
    if(!isRecord(value) || ![1,2,3].includes(value.version) || typeof value.timezone!=='string' || value.timezone.length>100)return false;
    const version=value.version,maxDays=version===3?7322:3660;
    new Intl.DateTimeFormat('en-US',{timeZone:value.timezone}).format();
    let categories=new Set(LEGACY_CATEGORIES);
    if(version>=2) {
      if(!Array.isArray(value.groups) || !value.groups.length || value.groups.length>50
        || !value.groups.every(isPlannerClassification)
        || !uniqueIds(value.groups))return false;
      categories=new Set(value.groups.map(group=>group.id));
    }
    if(value.tags!==undefined && (!Array.isArray(value.tags) || !value.tags.length || value.tags.length>50
      || !value.tags.every(isPlannerClassification) || !uniqueIds(value.tags)))return false;
    const tags=value.tags===undefined?categories:new Set(value.tags.map(tag=>tag.id));
    if(!Array.isArray(value.tasks) || value.tasks.length>2000 || !value.tasks.every(item=>isTask(item,categories,tags)) || !uniqueIds(value.tasks))return false;
    if(!Array.isArray(value.templates) || value.templates.length>100 || !value.templates.every(item=>isTemplate(item,categories,version,tags)) || !uniqueIds(value.templates))return false;
    if(!isRecord(value.days) || Object.keys(value.days).length>maxDays)return false;
    if(!Object.entries(value.days).every(([date,day])=>isDateKey(date) && isBlocks(day,categories,version,tags)))return false;
    if(version>=2) {
      if(!isRecord(value.dayMeta) || Object.keys(value.dayMeta).length>(version===3?10982:maxDays)
        || !Object.entries(value.dayMeta).every(([date,meta])=>isDateKey(date) && isDayReference(meta)
          && (meta.weekTemplateId===undefined || isId(meta.weekTemplateId))))return false;
      if(!Array.isArray(value.weekTemplates) || value.weekTemplates.length>100
        || !value.weekTemplates.every(item=>isWeekTemplate(item,categories,version,tags)) || !uniqueIds(value.weekTemplates))return false;
      const cycle=value.cycle;
      if(!isRecord(cycle) || typeof cycle.enabled!=='boolean' || !isDateKey(cycle.startDate)
        || !(cycle.endDate===null || (isDateKey(cycle.endDate) && cycle.endDate>=cycle.startDate))
        || !(cycle.sourceWeekTemplateId===null || isId(cycle.sourceWeekTemplateId))
        || !isWeekDays(cycle.days,categories,version,tags))return false;
    }
    return validateTracking(value.tracking) && new TextEncoder().encode(JSON.stringify(value)).length<=MAX_STATE_BYTES;
  }catch{return false;}
}
function defaultPlannerGroups() {
  return [
    {id:'work',name:'工作',color:'#6F987E'}, {id:'learn',name:'学习',color:'#9992C0'},
    {id:'life',name:'生活',color:'#C5A26D'}, {id:'rest',name:'休息',color:'#AC95B8'},
  ];
}
/** A missing tag uses its legacy category, then the first tag. Explicit historical ids stay intact. */
export function effectiveTagId(data,item) {
  if(item?.tagId!==undefined)return item.tagId;
  const tags=data.tags||data.groups||defaultPlannerGroups();
  return tags.some(tag=>tag.id===item?.category)?item.category:tags[0]?.id;
}
export function tagForItem(data,item) {
  const tags=data.tags||data.groups||defaultPlannerGroups();
  return tags.find(tag=>tag.id===effectiveTagId(data,item))||null;
}
function migratePlannerTags(data) {
  if(data.tags===undefined)data.tags=data.groups.map(({id,name,color})=>({id,name,color}));
  const assign=item=>{if(item.tagId===undefined)item.tagId=effectiveTagId(data,item);};
  data.tasks.forEach(assign);
  const lists=[...data.templates.map(template=>template.blocks),...Object.values(data.days),
    ...data.weekTemplates.flatMap(template=>template.days.map(day=>day.blocks)),...data.cycle.days.map(day=>day.blocks)];
  for(const blocks of lists)blocks.forEach(assign);
  const dates=new Map();
  for(const record of [...(data.tracking?.sessions||[]),...(data.tracking?.timer?[data.tracking.timer]:[])]){
    if(record.tagId!==undefined)continue;
    if(!dates.has(record.planDate))dates.set(record.planDate,new Map(resolveDay(data,record.planDate).blocks.map(block=>[block.id,block])));
    const block=record.unplanned?null:dates.get(record.planDate).get(record.blockId);
    record.tagId=effectiveTagId(data,block||record);
  }
  return data;
}
function plannerWeekDay(template) {
  return template
    ? {templateId:template.id,templateName:template.name,blocks:copyPlannerValue(template.blocks).map(block=>({...block,done:false}))}
    : {templateId:null,templateName:'',blocks:[]};
}
function defaultPlannerWeeks(templates) {
  const workday=templates.find(item=>item.id==='template-workday') || templates[0];
  const weekend=templates.find(item=>item.id==='template-weekend') || templates[1] || workday;
  const standard=Array.from({length:7},(_,index)=>plannerWeekDay(index<5?workday:weekend));
  const light=standard.map((day,index)=>({
    ...copyPlannerValue(day),templateName:day.templateName?day.templateName+' · 轻量':'',
    blocks:copyPlannerValue(day.blocks.filter((block,blockIndex)=>index<5?blockIndex===0||block.category==='life':blockIndex<2)),
  }));
  return [
    {id:'week-standard',name:'标准一周',description:'工作日保持节奏，周末留给学习和生活。',days:standard},
    {id:'week-light',name:'轻量一周',description:'保留每天的重点，为临时变化留出更多空白。',days:light},
  ];
}
function derivedPlannerId(original,suffix) {
  const ending=':'+suffix;
  if(original.length+ending.length<=128)return original+ending;
  let first=0x811c9dc5,second=0x9e3779b9;
  for(const character of original){first=Math.imul(first^character.charCodeAt(0),0x01000193);second=Math.imul(second^character.charCodeAt(0),0x85ebca6b);}
  const hash=(first>>>0).toString(16).padStart(8,'0')+(second>>>0).toString(16).padStart(8,'0');
  return original.slice(0,128-ending.length-17)+':'+hash+ending;
}
function uniquePlannerBlocks(blocks) {
  const reserved=new Set(blocks.map(block=>block.id)),used=new Set();
  return blocks.map(block=>{
    if(used.has(block.id)){
      let suffix=1,id;
      do{id=derivedPlannerId(block.id,'m3-'+suffix++);}while(reserved.has(id)||used.has(id));
      block={...block,id};
    }
    used.add(block.id);
    return block;
  });
}
/** Split a legacy civil day at 04:00. Early pieces belong to the previous planning day. */
function legacyPlannerSections(blocks) {
  const late=[],early=[];
  for(const original of blocks){
    const end=original.start+original.duration,crosses=original.start<DAY_START&&end>DAY_START;
    if(end>DAY_START){
      const start=Math.max(DAY_START,original.start);
      late.push({...copyPlannerValue(original),start,duration:end-start});
    }
    if(original.start<DAY_START){
      early.push({...copyPlannerValue(original),id:crosses?derivedPlannerId(original.id,'m3-before4'):original.id,
        start:original.start+1440,duration:Math.min(end,DAY_START)-original.start});
    }
  }
  return {late,early};
}
function migratePlannerWeek(days) {
  return days.map((day,index)=>({...copyPlannerValue(day),blocks:uniquePlannerBlocks([
    ...legacyPlannerSections(day.blocks).late,...legacyPlannerSections(days[(index+1)%7].blocks).early,
  ])}));
}
function legacyCycleIncludes(data,date) {
  return data.cycle.enabled&&date>=data.cycle.startDate&&(data.cycle.endDate===null||date<=data.cycle.endDate);
}
function migratePlannerDates(legacy,data) {
  const dates=new Set(Object.keys(legacy.days));
  for(const date of Object.keys(legacy.days)){
    // An empty saved civil day also suppresses that morning's recurring blocks.
    if(legacyPlannerSections(legacy.days[date]).early.length||legacyCycleIncludes(legacy,date))dates.add(addDays(date,-1));
  }
  if(legacy.cycle.enabled){
    const start=legacy.cycle.startDate;
    if(legacyPlannerSections(resolveDay(legacy,start).blocks).early.length)dates.add(addDays(start,-1));
    // The last civil day must not inherit the next day's out-of-range morning.
    if(legacy.cycle.endDate!==null)dates.add(legacy.cycle.endDate);
  }
  data.days={};
  data.dayMeta=copyPlannerValue(legacy.dayMeta);
  for(const date of dates){
    const current=resolveDay(legacy,date),next=resolveDay(legacy,addDays(date,1));
    const late=legacyPlannerSections(current.blocks).late,early=legacyPlannerSections(next.blocks).early;
    data.days[date]=uniquePlannerBlocks([...late,...early]);
    const reference=current.source==='saved'||late.length?current:early.length?next:current;
    data.dayMeta[date]=copyPlannerValue(legacy.dayMeta[date]||{
      templateId:reference.templateId,templateName:reference.templateName,
      ...(reference.source==='cycle'&&legacy.cycle.sourceWeekTemplateId?{weekTemplateId:legacy.cycle.sourceWeekTemplateId}:{}),
    });
  }
}
/** Return an independent V3 clone, retaining legacy events at their actual civil dates/times. */
export function migrateData(input) {
  if(!validateData(input))throw new Error('日程数据格式不正确，无法升级。');
  const legacy=copyPlannerValue(input);
  if(legacy.version===3){
    migratePlannerTags(legacy);
    if(!validateData(legacy))throw new Error('升级后的数据超过限制，请减少备份内容后重试。');
    return legacy;
  }
  if(legacy.version===1){
    legacy.version=2;
    legacy.groups=defaultPlannerGroups();
    legacy.dayMeta=Object.fromEntries(Object.keys(legacy.days).map(date=>[date,{templateId:null,templateName:'自定义安排'}]));
    legacy.weekTemplates=defaultPlannerWeeks(legacy.templates);
    legacy.cycle={enabled:false,startDate:planningDate(new Date(),legacy.timezone),endDate:null,sourceWeekTemplateId:null,days:copyPlannerValue(legacy.weekTemplates[0].days)};
  }
  const data={...legacy,version:3,
    templates:legacy.templates.map(template=>{const sections=legacyPlannerSections(template.blocks);return {...template,blocks:uniquePlannerBlocks([...sections.late,...sections.early])};}),
    weekTemplates:legacy.weekTemplates.map(week=>({...week,days:migratePlannerWeek(week.days)})),
    cycle:{...legacy.cycle,days:migratePlannerWeek(legacy.cycle.days)},
  };
  migratePlannerDates(legacy,data);
  migratePlannerTags(data);
  if(!validateData(data))throw new Error('升级后的数据超过限制，请减少备份内容后重试。');
  return data;
}
/** UTC arithmetic prevents timezone or DST changes from shifting weekday assignments. */
export function addDays(date,count) {
  if(!isDateKey(date) || !Number.isSafeInteger(count))throw new Error('日期或天数不正确。');
  const result=new Date(date+'T00:00:00.000Z'); result.setUTCDate(result.getUTCDate()+count);
  if(!Number.isFinite(result.valueOf()))throw new Error('日期超出范围。');
  const key=result.toISOString().slice(0,10);
  if(!isDateKey(key))throw new Error('日期超出范围。');
  return key;
}
export function weekdayIndex(date) {
  if(!isDateKey(date))throw new Error('日期不正确。');
  return (new Date(date+'T00:00:00.000Z').getUTCDay()+6)%7;
}
export function mondayOf(date) { return addDays(date,-weekdayIndex(date)); }
/** The local calendar date whose 04:00–next 04:00 window contains this instant. */
export function planningDate(now=new Date(),timezone='Asia/Shanghai') {
  const instant=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(instant.valueOf()))throw new Error('时间不正确。');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(instant);
  const fields=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const date=fields.year+'-'+fields.month+'-'+fields.day;
  return Number(fields.hour)<4?addDays(date,-1):date;
}
function plannerCycleBlockId(date,originalId) {
  const plain='cyc:'+date+':'+originalId;
  if(plain.length<=128)return plain;
  let h1=0x811c9dc5,h2=0x9e3779b9;
  for(const character of originalId){h1=Math.imul(h1^character.charCodeAt(0),0x01000193);h2=Math.imul(h2^character.charCodeAt(0),0x85ebca6b);}
  return 'cyc:'+date+':'+originalId.slice(0,88)+':'+(h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0');
}
/** Saved entries, including [], override virtual cycle occurrences. Returns independent blocks. */
export function resolveDay(data,date) {
  if(!isDateKey(date))throw new Error('日期不正确。');
  if(ownsPlannerKey(data.days,date)) {
    const meta=data.dayMeta?.[date];
    return {blocks:copyPlannerValue(data.days[date]),templateId:meta?.templateId??null,templateName:meta?.templateName??'自定义安排',source:'saved'};
  }
  const cycle=data.cycle;
  if(cycle?.enabled && date>=cycle.startDate && (cycle.endDate===null || date<=cycle.endDate)) {
    const day=cycle.days[weekdayIndex(date)];
    return {
      blocks:day.blocks.map(block=>({...copyPlannerValue(block),id:plannerCycleBlockId(date,block.id),done:false})),
      templateId:day.templateId,templateName:day.templateName,source:'cycle',
    };
  }
  return {blocks:[],templateId:null,templateName:'',source:'empty'};
}
/** Save an independent exception before editing a generated date. Returns its mutable block array. */
export function materializeDay(data,date) {
  if(!isDateKey(date))throw new Error('日期不正确。');
  if(!ownsPlannerKey(data.days,date)) {
    const resolved=resolveDay(data,date);
    data.days[date]=resolved.blocks;
    data.dayMeta??={};
    data.dayMeta[date]={templateId:resolved.templateId,templateName:resolved.templateName,
      ...(resolved.source==='cycle' && data.cycle.sourceWeekTemplateId?{weekTemplateId:data.cycle.sourceWeekTemplateId}:{})};
  }
  return data.days[date];
}
/** Actual records belong to one filled task even if filling it is later undone on an offline device. */
export function assignTagSlot(data,date,blockId,taskId,minutes,newId=()=>crypto.randomUUID()) {
  const blocks=resolveDay(data,date).blocks;
  const index=blocks.findIndex(block=>block.id===blockId),slot=blocks[index];
  if(!isTagSlot(slot))throw new Error('这段标签预留已变更，请重新选择。');
  const task=data.tasks.find(item=>item.id===taskId);
  if(!task || (task.done&&!task.reusable) || effectiveTagId(data,task)!==slot.tagId)throw new Error('请选择此标签下可用的任务。');
  const duration=minutes===undefined?slot.duration:minutes;
  if(!isDuration(duration) || duration>slot.duration)throw new Error('占用时长须为 30 分钟的倍数，且不能超过预留时段。');
  const used=new Set(blocks.map(block=>block.id));
  for(const record of data.tracking?.sessions||[])if(record.planDate===date)used.add(record.blockId);
  const timer=data.tracking?.timer;
  if(timer?.planDate===date)used.add(timer.blockId);
  const allocate=()=>{
    const id=newId();
    if(!isId(id) || used.has(id))throw new Error('未能生成独立的安排编号，请重试。');
    used.add(id);
    return id;
  };
  const assigned={id:allocate(),start:slot.start,duration,taskId:task.id,title:task.title,category:task.category,tagId:slot.tagId,done:false};
  const remainder=duration<slot.duration?createTagSlot(allocate(),slot.tagId,slot.start+duration,slot.duration-duration):null;
  const target=materializeDay(data,date);
  target[index]=assigned;
  if(remainder)target.push(remainder);
  return assigned;
}
/** Snapshot Monday through Sunday; later cycle/template edits cannot change the result. */
export function snapshotWeek(data,date) {
  const monday=mondayOf(date);
  return Array.from({length:7},(_,index)=>{
    const resolved=resolveDay(data,addDays(monday,index));
    return {templateId:resolved.templateId,templateName:resolved.templateName,blocks:resolved.blocks.map(block=>({...block,done:false}))};
  });
}
export function seedData() { return migrateData(legacySeedData()); }
function legacySeedData() {
  return {
    version: 1,
    timezone: 'Asia/Shanghai',
    tasks: [
      { id: 'task-read', title: '阅读一篇论文', duration: 60, category: 'learn', reusable: true, done: false },
      { id: 'task-notes', title: '整理学习笔记', duration: 30, category: 'learn', reusable: true, done: false },
      { id: 'task-focus', title: '专注工作', duration: 90, category: 'work', reusable: true, done: false },
      { id: 'task-walk', title: '散步与放松', duration: 30, category: 'life', reusable: true, done: false },
      { id: 'task-plan', title: '规划下一周', duration: 30, category: 'life', reusable: true, done: false },
    ],
    days: {},
    templates: [
      {
        id: 'template-workday', name: '工作日', description: '专注工作，也留一些时间给自己。',
        blocks: [
          { id: 'work-morning', taskId: 'task-focus', title: '专注工作', start: 540, duration: 90, category: 'work', done: false },
          { id: 'work-break', title: '休息一下', start: 630, duration: 30, category: 'rest', done: false },
          { id: 'work-next', title: '继续推进', start: 660, duration: 60, category: 'work', done: false },
          { id: 'work-lunch', title: '午餐与休息', start: 720, duration: 90, category: 'rest', done: false },
          { id: 'work-afternoon', taskId: 'task-focus', title: '专注工作', start: 840, duration: 90, category: 'work', done: false },
          { id: 'work-evening', taskId: 'task-read', title: '阅读一篇论文', start: 1170, duration: 60, category: 'learn', done: false },
        ],
      },
      {
        id: 'template-weekend', name: '周末', description: '慢一点，给学习和生活留白。',
        blocks: [
          { id: 'weekend-read', taskId: 'task-read', title: '阅读一篇论文', start: 600, duration: 60, category: 'learn', done: false },
          { id: 'weekend-notes', taskId: 'task-notes', title: '整理学习笔记', start: 660, duration: 30, category: 'learn', done: false },
          { id: 'weekend-lunch', title: '午餐与休息', start: 720, duration: 90, category: 'rest', done: false },
          { id: 'weekend-interest', title: '自己的兴趣时间', start: 900, duration: 90, category: 'life', done: false },
          { id: 'weekend-walk', taskId: 'task-walk', title: '散步与放松', start: 1020, duration: 30, category: 'life', done: false },
          { id: 'weekend-plan', taskId: 'task-plan', title: '规划下一周', start: 1200, duration: 30, category: 'life', done: false },
        ],
      },
    ],
  };
}
