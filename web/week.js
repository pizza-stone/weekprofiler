import { resolveDay, mondayOf, addDays, DAY_START, DAY_END } from '/model.js';

const WEEK_LABELS = ['周一','周二','周三','周四','周五','周六','周日'];
const weekColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#91aa99';
const weekGroup = (data,id) => data.groups.find(group=>group.id===id) || {id,name:'未分组',color:'#91aa99'};
const weekTags = data => data.tags || data.groups || [];
function weekTag(data,item,tagForItem) {
  const tags=weekTags(data);
  const id=item.tagId!==undefined?item.tagId:(tags.some(tag=>tag.id===item.category)?item.category:tags[0]?.id);
  const tag=tagForItem?tagForItem(item):tags.find(tag=>tag.id===id);
  return tag || {id,name:'已移除标签',color:'#8b948c'};
}
const weekMuted = (group,tag,groupFilter,tagFilter) => (groupFilter!=='all'&&groupFilter!==group.id)||(tagFilter!=='all'&&tagFilter!==tag.id);
const windowMinutes = block => Math.max(0,Math.min(DAY_END,block.start+block.duration)-Math.max(DAY_START,block.start));
const weekShortDuration = minutes => (Math.round(minutes/6)/10)+'h';

function dayFlow(day,data,esc,groupFilter='all',tagFilter='all',tagForItem) {
  let cursor=DAY_START;
  const pieces=[];
  for(const block of [...day.blocks].sort((a,b)=>a.start-b.start)){
    const start=Math.max(DAY_START,block.start),end=Math.min(DAY_END,block.start+block.duration);
    if(end<=start)continue;
    if(start>cursor)pieces.push('<span class="week-flow-free" style="flex:'+String(start-cursor)+'"></span>');
    const group=weekGroup(data,block.category),tag=weekTag(data,block,tagForItem);
    const label=block.kind==='tag-slot'?tag.name+' · 预留':block.title+' · 项目：'+group.name+' · 标签：'+tag.name;
    pieces.push('<span class="week-flow-busy'+(weekMuted(group,tag,groupFilter,tagFilter)?' is-muted':'')+'" style="flex:'+String(end-start)+';background:'+weekColor(tag.color)+'" title="'+esc(label)+'"></span>');
    cursor=Math.max(cursor,end);
  }
  if(cursor<DAY_END)pieces.push('<span class="week-flow-free" style="flex:'+String(DAY_END-cursor)+'"></span>');
  return '<div class="week-flow" aria-hidden="true">'+pieces.join('')+'</div>';
}

function daySelector(day,data,index,key,editing,esc) {
  const attrs=editing?'data-action="assign-week-template-day" data-weekday="'+index+'"':'data-action="assign-day-template" data-date="'+key+'"';
  let options='<option value=""'+(!day.templateId?' selected':'')+'>留白 / 自定义</option>';
  if(day.templateId&&!data.templates.some(t=>t.id===day.templateId))options+='<option selected value="'+esc(day.templateId)+'">'+esc(day.templateName||'已保存的日模板')+'</option>';
  options+=data.templates.map(t=>'<option value="'+esc(t.id)+'"'+(day.templateId===t.id?' selected':'')+'>'+esc(t.name)+'</option>').join('');
  return '<select class="week-template-select" '+attrs+' aria-label="'+WEEK_LABELS[index]+'使用的日模板">'+options+'</select>';
}

export function renderWeekly({data,date,editingWeekId=null,groupFilter='all',tagFilter='all',viewMode='compare',statsExpanded=false,expandedDays=[]},h) {
  const {esc,btn,time,duration}=h;
  const startDate=mondayOf(date);
  const editing=data.weekTemplates.find(t=>t.id===editingWeekId);
  const mode=editing?'plan':(['plan','actual','compare'].includes(viewMode)?viewMode:'compare');
  const days=Array.from({length:7},(_,index)=>{
    const key=addDays(startDate,index);
    const plan=editing?editing.days[index]:resolveDay(data,key);
    return {...plan,key,index,blocks:plan?.blocks||[],source:editing?'template':plan.source};
  });
  const allBlocks=days.flatMap(day=>day.blocks);
  const gridStart=DAY_START;
  const gridEnd=DAY_END;
  const slots=(gridEnd-gridStart)/30;
  const gridHeight=slots*26;
  const busy=allBlocks.reduce((sum,block)=>sum+windowMinutes(block),0);
  const categoryTotals=new Map(data.groups.map(group=>[group.id,0]));
  for(const block of allBlocks)if(block.category)categoryTotals.set(block.category,(categoryTotals.get(block.category)||0)+block.duration);
  const projectLegend='<div class="week-group-legend" aria-label="按项目聚焦"><span class="week-filter-label">项目</span>'+btn('week-group-filter','全部','week-group-chip'+(groupFilter==='all'?' active':''),'data-id="all" aria-pressed="'+(groupFilter==='all')+'"')+data.groups.map(group=>btn('week-group-filter','<span>'+esc(group.name)+'</span><small>'+weekShortDuration(categoryTotals.get(group.id)||0)+'</small>','week-group-chip'+(groupFilter===group.id?' active':''),'data-id="'+esc(group.id)+'" aria-pressed="'+(groupFilter===group.id)+'" title="全周'+esc(group.name)+'计划时长"')).join('')+'</div>';
  const tagLegend='<div class="week-tag-legend" aria-label="按标签聚焦"><span class="week-filter-label">标签</span>'+btn('week-tag-filter','全部','week-group-chip'+(tagFilter==='all'?' active':''),'data-id="all" aria-pressed="'+(tagFilter==='all')+'"')+weekTags(data).map(tag=>btn('week-tag-filter','<i style="background:'+weekColor(tag.color)+'"></i><span>'+esc(tag.name)+'</span>','week-group-chip'+(tagFilter===tag.id?' active':''),'data-id="'+esc(tag.id)+'" aria-pressed="'+(tagFilter===tag.id)+'"')).join('')+'</div>';
  const legend='<div class="week-view-summary" id="week-overview-content"><div class="week-overview-metrics"><span>'+(mode==='plan'?'忙碌':'计划时长')+' <b>'+duration(busy)+'</b></span><span>'+(mode==='plan'?'空闲':'计划留白')+' <b>'+duration(7*(DAY_END-DAY_START)-busy)+'</b></span></div><div class="week-view-filters">'+projectLegend+tagLegend+'</div></div>';
  const axisHead='<div class="week-axis-head" aria-hidden="true"><span>时间</span><small>30 分钟</small></div>';
  const dayHeads=days.map(day=>{
    const dayBusy=day.blocks.reduce((sum,block)=>sum+windowMinutes(block),0);
    const source={cycle:'周循环',saved:'已调整',empty:'留白',template:'周模板'}[day.source]||'已安排';
    const dateLabel=day.key.slice(5).replace('-','/');
    const dayTitle=editing?'<strong>'+WEEK_LABELS[day.index]+'</strong><span>第 '+(day.index+1)+' 天</span>':
      btn('week-select-date','<strong>'+WEEK_LABELS[day.index]+'</strong><span>'+dateLabel+'</span>','week-date-button',
        'type="button" data-date="'+day.key+'" aria-pressed="'+(day.key===date)+'" aria-label="选择 '+day.key+' '+WEEK_LABELS[day.index]+'"');
    const detailKey=editing?'template:'+editing.id+':'+day.index:day.key,detailsExpanded=expandedDays.includes(detailKey);
    const detailToggle=btn('week-day-details','详情 <span aria-hidden="true">'+(detailsExpanded?'⌃':'⌄')+'</span>','week-day-details-toggle ghost','type="button" data-id="'+esc(detailKey)+'" aria-label="'+(detailsExpanded?'收起':'展开')+WEEK_LABELS[day.index]+'详情" aria-expanded="'+detailsExpanded+'" aria-controls="week-day-details-'+day.index+'"');
    const detail=mode==='actual'?'<div class="week-actual-caption">执行记录</div>':daySelector(day,data,day.index,day.key,!!editing,esc)+'<div class="week-day-source"><span class="'+(day.source==='cycle'?'cycle-source':'')+'">'+source+'</span><span title="当日 04:00 到次日 04:00 的空闲时间">空闲 '+weekShortDuration(DAY_END-DAY_START-dayBusy)+'</span></div>'+dayFlow(day,data,esc,groupFilter,tagFilter,h.tagForItem);
    return axisHead+'<section class="week-day-head'+(!editing&&day.key===date?' is-selected':'')+'" data-details-expanded="'+detailsExpanded+'"><div class="week-day-title">'+dayTitle+detailToggle+'</div><div class="week-day-details" id="week-day-details-'+day.index+'">'+detail+(h.timeShares?.({blocks:day.blocks,date:day.key,viewMode:mode,template:!!editing,compact:true})||'')+'</div>'+(mode==='compare'?'<div class="week-column-labels"><span>计划</span><span>执行</span></div>':'')+'</section>';
  }).join('');
  const timeAxis='<div class="week-time-axis" aria-hidden="true">'+Array.from({length:slots},(_,index)=>'<div class="week-axis-slot'+((gridStart+index*30)%60===0?' hour':'')+(gridStart+index*30>=1440?' next-day':'')+'">'+((gridStart+index*30)%60===0?'<span>'+time(gridStart+index*30)+'</span>':'')+'</div>').join('')+'<div class="week-axis-end"><span>'+time(DAY_END)+'</span></div></div>';
  const columns=days.map(day=>{
    const metadata='data-date="'+day.key+'" data-weekday="'+day.index+'"';
    const cells=readOnly=>Array.from({length:slots},(_,index)=>{
      const minute=gridStart+index*30;
      return '<div class="week-time-cell'+(minute%60===0?' hour':'')+(minute===1440?' midnight':'')+(minute>=1440?' next-day':'')+'"'+(readOnly?'':' data-action="new-week-block" data-minute="'+minute+'" '+metadata+' title="'+WEEK_LABELS[day.index]+' '+time(minute)+' 添加安排"')+'></div>';
    }).join('');
    const events=day.blocks.map(block=>{
      const group=weekGroup(data,block.category),tag=weekTag(data,block,h.tagForItem),color=weekColor(tag.color);
      const slot=block.kind==='tag-slot',title=slot?tag.name+' · 预留':block.title;
      const identity=slot?(editing?'按标签预留':'选择同标签任务'):'项目：'+group.name+' · 标签：'+tag.name;
      const label=title+' · '+time(block.start)+'–'+time(block.start+block.duration)+' · '+identity;
      const check=!editing&&!slot?btn('toggle-week',block.done?(h.icon?.('check')||'✓'):'','check','type="button" data-id="'+esc(block.id)+'" data-date="'+day.key+'" aria-pressed="'+block.done+'" aria-label="'+(block.done?'取消完成':'标记完成')+' '+esc(block.title)+'"'):'';
      const link=slot?'':' data-link-role="plan" data-plan-date="'+day.key+'" data-plan-block="'+esc(block.id)+'"'+(h.planLinkMetadata?.(block,day.key)||'');
      const action=editing?'':slot?'<span class="slot-add" aria-hidden="true">＋</span>':h.timerButton?.(block,day.key)||'';
      return '<div role="button" tabindex="0" draggable="true" class="week-event'+(slot?' tag-slot':'')+(block.duration===30?' short':'')+(block.done?' done':'')+(weekMuted(group,tag,groupFilter,tagFilter)?' is-dimmed':'')+'" data-action="edit-week-block" data-block="'+esc(block.id)+'"'+link+' data-id="'+esc(block.id)+'" '+metadata+' aria-label="'+esc(label)+'" title="'+esc(label)+'" style="top:'+((block.start-gridStart)/30*26+1)+'px;height:'+(block.duration/30*26-3)+'px;--event-bg:'+color+'52;--event-accent:'+color+';--event-text:#324139;--group-color:'+color+'">'+check+'<div class="week-event-main"><strong>'+esc(title)+'</strong>'+(block.duration>=60?'<small>'+time(block.start)+'–'+time(block.start+block.duration)+'</small>':'')+(block.duration>=90?'<em>'+esc(identity)+'</em>':'')+'</div>'+action+'</div>';
    }).join('');
    const planned='<div class="week-day-column" '+metadata+' data-grid-start="'+gridStart+'" data-grid-end="'+gridEnd+'" style="height:'+gridHeight+'px">'+cells(false)+events+'</div>';
    const actual=mode!=='plan'?'<div class="week-actual-column" data-readonly="true" data-date="'+day.key+'" style="height:'+gridHeight+'px">'+cells(true)+(h.renderActualEvents?.(day.key,'week')||'')+'</div>':'';
    const dayColumn=mode==='compare'?'<div class="week-day-pair">'+planned+actual+'</div>':mode==='actual'?actual:planned;
    return timeAxis+dayColumn;
  }).join('');
  const overviewToggle=editing?btn('week-stats-toggle',(statsExpanded?'收起筛选':'周概览与筛选')+'<span aria-hidden="true">'+(statsExpanded?'⌃':'⌄')+'</span>','week-stats-toggle week-template-stats-toggle ghost','type="button" aria-expanded="'+statsExpanded+'" aria-controls="week-overview-content"'):'';
  const canvas='<div class="week-view-canvas is-'+mode+'"><div class="week-view-head">'+dayHeads+'</div><div class="week-view-grid"'+(mode==='compare'?' data-plan-links':'')+' style="height:'+gridHeight+'px">'+columns+'</div></div>';
  const timeline='<div class="week-view-scroll" tabindex="0" aria-label="周时间表，每天从04:00到次日04:00，可上下或左右滚动">'+canvas+'</div>';
  // Day stops belong to the horizontal pager, outside the vertical time scroller.
  const stops='<div class="week-day-stops" aria-hidden="true">'+'<i></i>'.repeat(days.length)+'</div>';
  return '<section class="panel weekly-panel" data-stats-expanded="'+statsExpanded+'">'+overviewToggle+legend+'<div class="week-view-pager"><div class="week-view-strip">'+stops+timeline+'</div></div></section>';
}

export function renderWeekTemplateCards(data,h) {
  const {esc,btn,icon,duration}=h;
  return '<div class="template-grid week-template-grid">'+data.weekTemplates.map(template=>{
    const count=template.days.reduce((sum,day)=>sum+day.blocks.length,0);
    const total=template.days.reduce((sum,day)=>sum+day.blocks.reduce((n,block)=>n+block.duration,0),0);
    const active=data.cycle.enabled&&data.cycle.sourceWeekTemplateId===template.id;
    const preview=template.days.map((day,index)=>{
      const tags=new Map();
      for(const block of day.blocks){
        const tag=weekTag(data,block,h.tagForItem),previous=tags.get(tag.id);
        tags.set(tag.id,{tag,minutes:(previous?.minutes||0)+block.duration});
      }
      return '<div class="week-template-preview-day"><small>'+WEEK_LABELS[index].slice(1)+'</small><div class="week-template-preview-bar">'+[...tags.values()].map(({tag,minutes})=>'<span style="height:'+Math.max(4,Math.min(60,minutes/(DAY_END-DAY_START)*60))+'px;background:'+weekColor(tag.color)+'" title="'+esc('标签：'+tag.name+' · '+duration(minutes))+'"></span>').join('')+'</div><span title="'+esc(day.templateName||'自定义')+'">'+esc(day.templateName||'留白')+'</span></div>';
    }).join('');
    return '<article class="panel template-card week-template-card"><div class="week-template-preview" aria-hidden="true">'+preview+'</div><div class="week-card-title">'+(h.templateTitle?h.templateTitle('week',template):'<h2>'+esc(template.name)+'</h2>')+(active?'<span class="template-tag">当前周循环</span>':'')+'</div><p>'+esc(template.description||'把一周的节奏，安排得刚刚好。')+'</p><div class="template-info"><span>'+count+' 项安排</span><span>'+duration(total)+'</span><span>每 7 天一轮</span></div><div class="actions"><div>'+btn('edit-week-template','编辑','','data-id="'+esc(template.id)+'"')+' '+btn('copy-week-template',icon('copy'),'icon','data-id="'+esc(template.id)+'" aria-label="复制 '+esc(template.name)+'"')+'</div>'+btn('apply-week-template','应用到一周','primary','data-id="'+esc(template.id)+'"')+'</div>'+btn('activate-cycle',active?'调整每周循环':'设为每周循环','week-cycle-button','data-id="'+esc(template.id)+'"')+'<div class="template-card-tools">'+btn('week-template-meta','简介','ghost','data-id="'+esc(template.id)+'" aria-label="修改简介：'+esc(template.name)+'"')+btn('template-notes',template.notes?'查看备注':'添加备注','ghost','data-kind="week" data-id="'+esc(template.id)+'" aria-label="备注：'+esc(template.name)+'"')+btn('delete-week-template','删除','danger','data-id="'+esc(template.id)+'" aria-label="删除周模板 '+esc(template.name)+'"')+'</div></article>';
  }).join('')+btn('new-week-template',icon('plus')+'<span>创建一个周模板</span>','new-template')+'</div>';
}
