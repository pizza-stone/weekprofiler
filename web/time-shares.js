// A day's task mix uses its occupied time as the denominator, excluding blank time.
const shareColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#91aa99';
const shareNumber = value => Number(value.toFixed(1)).toLocaleString('zh-CN');
const sharePercent = value => value > 0 && value < .001 ? '＜0.1%' : shareNumber(value * 100) + '%';
function shareTag(data,item,h) {
  const tags=data.tags||data.groups||[];
  const id=h.effectiveTagId?h.effectiveTagId(item):item.tagId??(tags.some(tag=>tag.id===item.category)?item.category:tags[0]?.id);
  const tag=h.tagForItem?h.tagForItem(item):tags.find(tag=>tag.id===id);
  return {id:id||'untagged',title:tag?.name||(item.tagId?'已移除标签':'未设置标签'),color:tag?shareColor(tag.color):'#8a958b'};
}
function shareDuration(value) {
  if(value > 0 && value < .05)return '＜0.1 分钟';
  const rounded=Math.round(value*10)/10,hours=Math.floor(rounded/60),minutes=Math.round((rounded-hours*60)*10)/10;
  return (hours?hours+' 小时':'')+(hours&&minutes?' ':'')+(minutes||!hours?shareNumber(minutes)+' 分钟':'');
}

/** Actual shares follow the visible 04:00–04:00 day, using precise clipped timestamps. */
export function dailyTaskShares({data,blocks=[],date,source='plan',now=Date.now()},h={}) {
  const items=new Map(),tags=new Map();
  function add(key,block,minutes) {
    if(!Number.isFinite(minutes)||minutes<=0)return;
    const tag=shareTag(data,block,h);
    let item=items.get(key);
    if(!item){item={key,title:block.kind==='tag-slot'?tag.title+' · 预留':block.title||'未命名任务',category:block.category,color:tag.color,tagIds:new Set(),minutes:0};items.set(key,item);}
    item.tagIds.add(tag.id);
    item.minutes+=minutes;
    const label=tags.get(tag.id)||{key:tag.id,title:tag.title,color:tag.color,minutes:0};label.minutes+=minutes;tags.set(tag.id,label);
  }
  if(source==='actual'){
    // Cache the originating plans; a record can belong to another day's plan.
    const plans=new Map();
    for(const segment of h.actualSegments?.(data,date,now)||[]){
      if(!plans.has(segment.planDate))plans.set(segment.planDate,h.resolveDay?.(data,segment.planDate)?.blocks||[]);
      const planned=plans.get(segment.planDate).find(item=>item.id===segment.blockId&&item.kind!=='tag-slot');
      // Explicit record labels remain historical; the plan supplies old missing labels.
      const block=planned?{...planned,tagId:segment.tagId??planned.tagId}:segment;
      const key=block.taskId?'task:'+block.taskId:'block:'+segment.planDate+':'+segment.blockId;
      add(key,block,(segment.exactEnd-segment.exactStart)/60000);
    }
  }else{
    for(const block of blocks){
      const key=block.kind==='tag-slot'?'slot:'+block.tagId:block.taskId?'task:'+block.taskId:'block:'+block.id;
      add(key,block,block.duration);
    }
  }
  const totalMinutes=[...items.values()].reduce((sum,item)=>sum+item.minutes,0);
  const ranked=list=>list.sort((a,b)=>b.minutes-a.minutes||a.title.localeCompare(b.title,'zh-CN')).map(item=>({...item,share:totalMinutes?item.minutes/totalMinutes:0}));
  return {source,totalMinutes,items:ranked([...items.values()].map(({tagIds,...item})=>({...item,mixedTags:tagIds.size>1,color:tagIds.size>1?'#8a958b':item.color}))),tags:ranked([...tags.values()])};
}

/** h.actualSegments and h.resolveDay are only needed for actual / comparison views. */
export function renderTimeShares({data,blocks=[],date,viewMode='plan',template=false,compact=false,now=Date.now()},h) {
  const {esc}=h,mode=template?'plan':viewMode;
  const sources=mode==='compare'?['plan','actual']:[mode==='actual'?'actual':'plan'];
  const panels=sources.map(source=>{
    const stats=dailyTaskShares({data,blocks,date,source,now},h),label=(source==='actual'?'实际':'计划')+'耗时占比';
    const bars=stats.tags.map(item=>'<span style="flex:'+item.minutes+';background:'+item.color+'" title="'+esc(item.title+' · '+shareDuration(item.minutes)+' · '+sharePercent(item.share))+'"></span>').join('');
    const rows=items=>items.map(item=>'<li><span class="time-share-name" title="'+esc(item.title+(item.mixedTags?' · 多标签':''))+'"><i style="background:'+item.color+'" aria-hidden="true"></i><span>'+esc(item.title)+'</span>'+(item.mixedTags?'<small class="time-share-mixed">多标签</small>':'')+'</span><span class="time-share-value"><small>'+shareDuration(item.minutes)+'</small><strong>'+sharePercent(item.share)+'</strong></span><span class="time-share-track" aria-hidden="true"><span style="width:'+item.share*100+'%;background:'+item.color+'"></span></span></li>').join('');
    const breakdown=stats.items.length?'<section class="time-shares-section"><h3>标签占比</h3><ol data-shares-breakdown="tags">'+rows(stats.tags)+'</ol></section><section class="time-shares-section"><h3>各任务占比</h3><ol data-shares-breakdown="tasks">'+rows(stats.items)+'</ol></section>':'<p class="time-shares-empty">'+(source==='actual'?'当天还没有实际记录':'当天还没有安排任务')+'</p>';
    return '<details class="time-shares'+(compact?' compact':'')+'" data-shares-source="'+source+'"'+(!compact?' open':'')+'><summary><span class="time-shares-heading"><span>'+label+'</span><small>'+shareDuration(stats.totalMinutes)+'</small></span><span class="time-shares-bar" aria-hidden="true">'+bars+'</span></summary><div class="time-shares-detail">'+breakdown+'<p class="time-shares-note">两种占比均以当天任务总时长为 100%，不含空白时间。'+(source==='actual'?'按真实用时统计。':'')+'</p></div></details>';
  }).join('');
  return '<div class="time-shares-wrap'+(sources.length===2?' is-compare':'')+(compact?' compact':'')+'" data-shares-date="'+esc(date||'')+'" data-shares-mode="'+mode+'"'+(template?' data-shares-template="true"':'')+'>'+panels+'</div>';
}
