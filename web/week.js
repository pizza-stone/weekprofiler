import { resolveDay, mondayOf, addDays, DAY_START, DAY_END } from '/model.js';

const WEEK_LABELS = ['周一','周二','周三','周四','周五','周六','周日'];
const weekColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#91aa99';
const weekGroup = (data,id) => data.groups.find(group=>group.id===id) || {id,name:'未分组',color:'#91aa99'};
const windowMinutes = block => Math.max(0,Math.min(DAY_END,block.start+block.duration)-Math.max(DAY_START,block.start));
const weekShortDuration = minutes => (Math.round(minutes/6)/10)+'h';

function dayFlow(day,data,esc,groupFilter) {
  let cursor=DAY_START;
  const pieces=[];
  for(const block of [...day.blocks].sort((a,b)=>a.start-b.start)){
    const start=Math.max(DAY_START,block.start),end=Math.min(DAY_END,block.start+block.duration);
    if(end<=start)continue;
    if(start>cursor)pieces.push('<span class="week-flow-free" style="flex:'+String(start-cursor)+'"></span>');
    const group=weekGroup(data,block.category);
    pieces.push('<span class="week-flow-busy'+(groupFilter!=='all'&&groupFilter!==group.id?' is-muted':'')+'" style="flex:'+String(end-start)+';background:'+weekColor(group.color)+'" title="'+esc(group.name+' · '+block.title)+'"></span>');
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

export function renderWeekly({data,date,editingWeekId=null,groupFilter='all'},h) {
  const {esc,btn,time,duration}=h;
  const startDate=mondayOf(date);
  const editing=data.weekTemplates.find(t=>t.id===editingWeekId);
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
  for(const block of allBlocks)categoryTotals.set(block.category,(categoryTotals.get(block.category)||0)+block.duration);
  const legend='<div class="week-view-summary"><div class="week-overview-metrics"><span>每天 04:00 → 次日 04:00 · 24 小时</span><span>忙碌 <b>'+duration(busy)+'</b></span><span>空闲 <b>'+duration(7*(DAY_END-DAY_START)-busy)+'</b></span></div><div class="week-group-legend" aria-label="按任务分组聚焦">'+btn('week-group-filter','全部','week-group-chip'+(groupFilter==='all'?' active':''),'data-id="all"')+data.groups.map(group=>btn('week-group-filter','<i style="background:'+weekColor(group.color)+'"></i><span>'+esc(group.name)+'</span><small>'+weekShortDuration(categoryTotals.get(group.id)||0)+'</small>','week-group-chip'+(groupFilter===group.id?' active':''),'data-id="'+esc(group.id)+'" title="全周'+esc(group.name)+'时长"')).join('')+'</div></div>';
  const dayHeads=days.map(day=>{
    const dayBusy=day.blocks.reduce((sum,block)=>sum+windowMinutes(block),0);
    const source={cycle:'周循环',saved:'已调整',empty:'留白',template:'周模板'}[day.source]||'已安排';
    const dateLabel=day.key.slice(5).replace('-','/');
    return '<section class="week-day-head'+(!editing&&day.key===date?' is-selected':'')+'"><div class="week-day-title"><strong>'+WEEK_LABELS[day.index]+'</strong><span>'+(!editing?dateLabel:'第 '+(day.index+1)+' 天')+'</span></div>'+daySelector(day,data,day.index,day.key,!!editing,esc)+'<div class="week-day-source"><span class="'+(day.source==='cycle'?'cycle-source':'')+'">'+source+'</span><span title="当日 04:00 到次日 04:00 的空闲时间">空闲 '+weekShortDuration(DAY_END-DAY_START-dayBusy)+'</span></div>'+dayFlow(day,data,esc,groupFilter)+'</section>';
  }).join('');
  const timeAxis='<div class="week-time-axis" aria-hidden="true">'+Array.from({length:slots},(_,index)=>'<div class="week-axis-slot'+((gridStart+index*30)%60===0?' hour':'')+(gridStart+index*30>=1440?' next-day':'')+'">'+((gridStart+index*30)%60===0?'<span>'+time(gridStart+index*30)+'</span>':'')+'</div>').join('')+'<div class="week-axis-end"><span>'+time(DAY_END)+'</span></div></div>';
  const columns=days.map(day=>{
    const metadata='data-date="'+day.key+'" data-weekday="'+day.index+'"';
    const cells=Array.from({length:slots},(_,index)=>{
      const minute=gridStart+index*30;
      return '<div class="week-time-cell'+(minute%60===0?' hour':'')+(minute===1440?' midnight':'')+(minute>=1440?' next-day':'')+'" data-action="new-week-block" data-minute="'+minute+'" '+metadata+' title="'+WEEK_LABELS[day.index]+' '+time(minute)+' 添加安排"></div>';
    }).join('');
    const events=day.blocks.map(block=>{
      const group=weekGroup(data,block.category),color=weekColor(group.color);
      const label=block.title+' · '+time(block.start)+'–'+time(block.start+block.duration)+' · '+group.name;
      return '<button type="button" draggable="true" class="week-event'+(block.duration===30?' short':'')+(block.done?' done':'')+(groupFilter!=='all'&&groupFilter!==group.id?' is-dimmed':'')+'" data-action="edit-week-block" data-block="'+esc(block.id)+'" data-id="'+esc(block.id)+'" '+metadata+' aria-label="'+esc(label)+'" title="'+esc(label)+'" style="top:'+((block.start-gridStart)/30*26+1)+'px;height:'+(block.duration/30*26-3)+'px;--event-bg:'+color+'52;--event-accent:'+color+';--event-text:#324139;--group-color:'+color+'"><strong>'+esc(block.title)+'</strong>'+(block.duration>=60?'<small>'+time(block.start)+'–'+time(block.start+block.duration)+'</small>':'')+(block.duration>=90?'<em>'+esc(group.name)+'</em>':'')+'</button>';
    }).join('');
    return '<div class="week-day-column" '+metadata+' data-grid-start="'+gridStart+'" data-grid-end="'+gridEnd+'" style="height:'+gridHeight+'px">'+cells+events+'</div>';
  }).join('');
  return '<section class="panel weekly-panel">'+legend+'<div class="week-view-scroll" tabindex="0" aria-label="周时间表，每天从04:00到次日04:00，可上下或左右滚动"><div class="week-view-canvas"><div class="week-view-head"><div class="week-axis-head"><span>时间</span><small>30 分钟</small></div>'+dayHeads+'</div><div class="week-view-grid" style="height:'+gridHeight+'px">'+timeAxis+columns+'</div></div></div><div class="week-view-footer"><span>点击安排可编辑 · 点击空白添加 · 拖动可调整</span><span>一天从 04:00 到次日 04:00；分组、忙闲均按完整 24 小时统计</span></div></section>';
}

export function renderWeekTemplateCards(data,h) {
  const {esc,btn,icon,duration}=h;
  return '<div class="template-grid week-template-grid">'+data.weekTemplates.map(template=>{
    const count=template.days.reduce((sum,day)=>sum+day.blocks.length,0);
    const total=template.days.reduce((sum,day)=>sum+day.blocks.reduce((n,block)=>n+block.duration,0),0);
    const active=data.cycle.enabled&&data.cycle.sourceWeekTemplateId===template.id;
    const preview=template.days.map((day,index)=>{
      const groups=new Map();
      for(const block of day.blocks)groups.set(block.category,(groups.get(block.category)||0)+block.duration);
      return '<div class="week-template-preview-day"><small>'+WEEK_LABELS[index].slice(1)+'</small><div class="week-template-preview-bar">'+[...groups].map(([id,minutes])=>'<span style="height:'+Math.max(4,Math.min(60,minutes/(DAY_END-DAY_START)*60))+'px;background:'+weekColor(weekGroup(data,id).color)+'"></span>').join('')+'</div><span title="'+esc(day.templateName||'自定义')+'">'+esc(day.templateName||'留白')+'</span></div>';
    }).join('');
    return '<article class="panel template-card week-template-card"><div class="week-template-preview" aria-hidden="true">'+preview+'</div><div class="week-card-title"><h2>'+esc(template.name)+'</h2>'+(active?'<span class="template-tag">当前周循环</span>':'')+'</div><p>'+esc(template.description||'把一周的节奏，安排得刚刚好。')+'</p><div class="template-info"><span>'+count+' 项安排</span><span>'+duration(total)+'</span><span>每 7 天一轮</span></div><div class="actions"><div>'+btn('edit-week-template','编辑','','data-id="'+esc(template.id)+'"')+' '+btn('copy-week-template',icon('copy'),'icon','data-id="'+esc(template.id)+'" aria-label="复制 '+esc(template.name)+'"')+'</div>'+btn('apply-week-template','应用到一周','primary','data-id="'+esc(template.id)+'"')+'</div>'+btn('activate-cycle',active?'调整每周循环':'设为每周循环','week-cycle-button','data-id="'+esc(template.id)+'"')+'</article>';
  }).join('')+btn('new-week-template',icon('plus')+'<span>创建一个周模板</span>','new-template')+'</div>';
}
