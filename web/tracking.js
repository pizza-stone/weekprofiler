// The timer uses persisted timestamps; repainting or closing the page does not reset it.
export function createTrackingUI(h,m) {
  const {getState,commit,render,modal,close,toast,esc,btn,icon,uid,resolveDay,materializeDay,addDays,mondayOf,planningDate}=h;
  const state=()=>getState(), data=()=>state().data, tracking=()=>data().tracking||{sessions:[],timer:null};
  const minutes=n=>Number(n.toFixed(1)).toLocaleString('zh-CN')+' 分钟';
  const percent=n=>n===null?'—':Number((n*100).toFixed(1))+'%';
  const clock=n=>{const seconds=Math.max(0,Math.floor(n/1000));return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(v=>String(v).padStart(2,'0')).join(':');};
  const precise=n=>m.timeInputValue(n,data().timezone).replace('T',' ');
  const displayTime=n=>(n>=1440?'次日 ':'')+String(Math.floor(n%1440/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  const tags=()=>data().tags||data().groups||[];
  const tagIdFor=item=>h.effectiveTagId?h.effectiveTagId(item):item.tagId??(tags().some(tag=>tag.id===item.category)?item.category:tags()[0]?.id);
  const tagFor=item=>(h.tagForItem?h.tagForItem(item):tags().find(tag=>tag.id===tagIdFor(item)))||{name:item.tagId?'已移除标签':'未设置标签',color:'#8a958b'};
  const classification=item=>tagFor(item).name+' · '+(data().groups.find(group=>group.id===item.category)?.name||'已移除项目');
  const taskById=(date,id)=>resolveDay(data(),date).blocks.find(block=>block.id===id&&block.kind!=='tag-slot');
  const stats=date=>m.summarizeTracking(resolveDay(data(),date).blocks,tracking().sessions,tracking().timer,date,Date.now(),data().groups,data().tags,data().timezone);
  const assignments=date=>m.trackingRecordAssignments(resolveDay(data(),date).blocks,tracking().sessions,tracking().timer,date,Date.now(),data().timezone);
  const attrs=(block,date)=>'type="button" data-id="'+esc(block.id)+'" data-date="'+date+'"';
  function setViewMode(mode,week){
    state()[week?'weekViewMode':'viewMode']=mode;
    try{localStorage.setItem(week?'weekprofiler-week-view-mode':'weekprofiler-view-mode',mode);}catch{}
  }
  function modeSelector(week){
    const selected=week?state().weekViewMode:state().viewMode;
    return '<div class="tracking-modes" role="group" aria-label="时间轴内容">'+[['plan','计划'],['actual','执行'],['compare','计划＋执行']].map(([id,label])=>btn('tracking-view',label,selected===id?'active':'','type="button" data-id="'+id+'" aria-pressed="'+(selected===id)+'"')).join('')+'</div>';
  }
  function timerButton(block,date){
    if(block.kind==='tag-slot')return '';
    const timer=tracking().timer,active=timer?.planDate===date&&timer.blockId===block.id;
    return btn(active?'timer-locate':'timer-start',active?'●':'▶','timer-start',attrs(block,date)+' aria-label="'+(active?'查看计时':'开始计时')+' '+esc(block.title)+'" title="'+(active?'正在计时或暂停':'开始计时')+'"');
  }
  function bar(){
    const timer=tracking().timer;if(!timer)return '';
    const total=tracking().sessions.filter(s=>s.planDate===timer.planDate&&s.blockId===timer.blockId).reduce((sum,s)=>sum+(s.endedAt-s.startedAt)/60000,0)+(timer.startedAt===null?0:Math.max(0,Date.now()-timer.startedAt)/60000);
    return '<section class="timer-bar" aria-label="当前计时"><div class="timer-info"><span class="timer-indicator'+(timer.startedAt===null?' paused':'')+'"></span><div><strong>'+esc(timer.title)+'</strong><small>'+timer.planDate+' · '+(timer.startedAt===null?'已暂停':'计时中')+' · 累计 <span data-timer-elapsed>'+clock(total*60000)+'</span></small></div></div><div class="timer-actions">'+btn('timer-locate','查看任务','ghost')+btn(timer.startedAt===null?'timer-resume':'timer-pause',timer.startedAt===null?'继续':'暂停')+btn('timer-stop','结束','primary')+'</div></section>';
  }
  function metrics(week=false){
    const dates=week?Array.from({length:7},(_,i)=>addDays(mondayOf(state().date),i)):[state().date];
    const totals=dates.map(stats).reduce((a,s)=>({plannedMinutes:a.plannedMinutes+s.plannedMinutes,actualMinutes:a.actualMinutes+s.actualMinutes,coveredMinutes:a.coveredMinutes+s.coveredMinutes,count:a.count+s.count,done:a.done+s.done,excludedCount:a.excludedCount+s.excludedCount}),{plannedMinutes:0,actualMinutes:0,coveredMinutes:0,count:0,done:0,excludedCount:0});
    return '<div><small>任务完成率</small><strong>'+percent(totals.count?totals.done/totals.count:null)+'</strong><span>'+totals.done+' / '+totals.count+' 项完成'+(totals.excludedCount?' · '+totals.excludedCount+' 项不计入':'')+'</span></div><div><small>执行用时</small><strong>'+minutes(totals.actualMinutes)+'</strong><span>计划 '+minutes(totals.plannedMinutes)+'</span></div><div><small>时长覆盖率</small><strong>'+percent(totals.plannedMinutes?totals.coveredMinutes/totals.plannedMinutes:null)+'</strong><span>已覆盖 '+minutes(totals.coveredMinutes)+'</span></div>';
  }
  function summary(week=false){
    const expanded=!!state().weekStatsExpanded;
    const toggle=week?btn('week-stats-toggle',(expanded?'收起统计':'统计与筛选')+'<span aria-hidden="true">'+(expanded?'⌃':'⌄')+'</span>','week-stats-toggle ghost','type="button" aria-expanded="'+expanded+'" aria-controls="week-statistics-content week-overview-content"'):'';
    const content='<div class="tracking-metrics" data-tracking-metrics data-scope="'+(week?'week':'day')+'">'+metrics(week)+'</div><p class="tracking-rule">每项任务的执行用时达到计划时长，即覆盖该项的 100%。'+btn('tracking-details','查看各项','ghost')+'</p>';
    return '<section class="tracking-summary'+(week?' week-tracking-summary':'')+'"'+(week?' data-stats-expanded="'+expanded+'"':'')+' aria-label="'+(week?'本周':'当日')+'统计"><div class="tracking-summary-top">'+modeSelector(week)+'<div class="tracking-summary-actions">'+(week?btn('timer-new','▶ 新建并计时','primary','type="button"'):'')+btn('actual-new','＋ 补录执行','ghost')+toggle+'</div></div>'+(week?'<div id="week-statistics-content">'+content+'</div>':content)+'</section>';
  }
  function newTimerForm(){
    if(tracking().timer){toast('先结束当前任务的计时，再开始另一项');return;}
    const date=planningDate(new Date(Date.now()),data().timezone),category=data().groups.some(g=>g.id===state().weekFilter)?state().weekFilter:data().groups[0].id;
    const selectedTag=state().tab==='week'?state().weekTagFilter:state().tagFilter;
    const tagId=[selectedTag,tagIdFor({category}),tags()[0]?.id].find(id=>tags().some(tag=>tag.id===id));
    modal('新建并计时','<form id="new-timer-form"><p>从现在开始，记录到 '+date+' 的执行时间。无需安排计划时段。</p><label for="timer-title">任务名称</label><input id="timer-title" name="title" required maxlength="100" placeholder="例如：临时整理资料"><div class="form-row"><div><label for="timer-category">项目分组</label><select id="timer-category" name="category" required>'+data().groups.map(g=>'<option value="'+esc(g.id)+'"'+(g.id===category?' selected':'')+'>'+esc(g.name)+'</option>').join('')+'</select></div><div><label for="timer-tag">标签</label><select id="timer-tag" name="tagId" required>'+tags().map(tag=>'<option value="'+esc(tag.id)+'"'+(tag.id===tagId?' selected':'')+'>'+esc(tag.name)+'</option>').join('')+'</select></div></div><div class="error" id="new-timer-error"></div><div class="modal-actions"><button type="submit" class="primary">开始计时</button></div></form>');
  }
  function submitNewTimer(form){
    try{
      if(tracking().timer)throw Error('先结束当前任务的计时，再开始另一项');
      const f=new FormData(form),title=String(f.get('title')||'').trim(),category=String(f.get('category')||'');
      if(!title||title.length>100)throw Error('请填写 1 至 100 字的任务名称');
      if(!data().groups.some(g=>g.id===category))throw Error('请选择有效项目分组');
      const tagId=String(f.get('tagId')??tagIdFor({category})??'');
      if(!tags().some(tag=>tag.id===tagId))throw Error('请选择有效标签');
      const now=Date.now(),date=planningDate(new Date(now),data().timezone);
      if(commit(d=>m.startTracking(d,date,{id:uid(),title,category,tagId,unplanned:true},now,uid()),'已开始临时任务计时',{recordUndo:false})){
        state().date=date;state().tab='week';state().templateId=null;state().weekTemplateId=null;
        if(state().weekViewMode==='plan')setViewMode('compare',true);
        close();render(true);
      }
    }catch(error){document.querySelector('#new-timer-error').textContent=error.message;}
    return true;
  }
  function renderActualEvents(date,kind='day'){return '<div class="actual-event-layer" data-actual-date="'+date+'" data-actual-kind="'+kind+'">'+actualCards(date,kind)+'</div>';}
  function actualCards(date,kind='day'){
    // Match against exact local clock minutes; rounded card positions can coincide.
    const wallStart=instant=>(Date.parse(m.timeInputValue(instant,data().timezone)+'Z')-Date.parse(date+'T00:00:00Z')+instant%1000)/60000;
    const records=new Map(tracking().sessions.map(record=>[record.id,record])),timer=tracking().timer,owners=new Map();
    const segments=m.actualSegments(data(),date,Date.now()).map(segment=>{
      const height=Math.max(18,segment.duration/30*26-3);
      return {...segment,height,top:Math.max(1,Math.min(1248-height,(segment.start-240)/30*26+1))};
    }).sort((a,b)=>a.top-b.top||a.exactStart-b.exactStart);
    // Partition painted cards into lanes, including point markers at the day boundary.
    const groups=[];let group=[],end=-Infinity;
    for(const segment of segments){if(segment.top>=end&&group.length){groups.push(group);group=[];end=-Infinity;}group.push(segment);end=Math.max(end,segment.top+segment.height);}if(group.length)groups.push(group);
    const cards=[];
    for(const cluster of groups){const ends=[];for(const segment of cluster){let lane=ends.findIndex(end=>end<=segment.top);if(lane<0)lane=ends.length;ends[lane]=segment.top+segment.height;segment.lane=lane;}for(const segment of cluster){
      if(!owners.has(segment.planDate))owners.set(segment.planDate,assignments(segment.planDate));
      const owner=owners.get(segment.planDate).get((segment.live?'timer:':'session:')+segment.id);
      const block=taskById(segment.planDate,owner||segment.blockId),title=block?.title||segment.title,category=block?.category||segment.category;
      const tagged={category,tagId:segment.tagId??block?.tagId},tag=tagFor(tagged),color=/^#[0-9a-f]{6}$/i.test(tag.color||'')?tag.color:'#8a958b';
      const displayRange=displayTime(segment.start)+(segment.duration?'–'+displayTime(segment.start+segment.duration):' · 短时记录');
      const label=title+' · '+classification(tagged)+' · 显示 '+displayRange+' · 执行 '+precise(segment.exactStart)+' — '+precise(segment.exactEnd)+(segment.live?' · 计时中':'');
      const width=100/ends.length,groupFilter=state().weekFilter||'all',tagFilter=state().weekTagFilter||'all';
      const dim=kind==='week'&&((groupFilter!=='all'&&category!==groupFilter)||(tagFilter!=='all'&&tagIdFor(tagged)!==tagFilter));
      const startedAt=(segment.live?timer:records.get(segment.id))?.startedAt??segment.exactStart;
      cards.push('<button type="button" class="actual-event'+(segment.duration>30?' long':'')+(segment.duration===0?' is-point':'')+(segment.live?' live':'')+(dim?' is-dimmed':'')+'" data-action="'+(segment.live?'timer-locate':'actual-edit')+'" data-id="'+esc(segment.id)+'" data-link-role="actual" data-plan-date="'+esc(segment.planDate)+'" data-plan-block="'+esc(segment.blockId)+'" data-link-owner="'+esc(owner||'')+'" data-link-date="'+esc(date)+'" data-link-task="'+esc(block?.taskId||'')+'" data-link-origin="'+!!block+'" data-link-title="'+esc(title)+'" data-link-category="'+esc(category)+'" data-link-start="'+wallStart(segment.exactStart)+'" data-link-record="'+esc((segment.live?'timer:':'session:')+segment.id)+'" data-link-instant="'+startedAt+'" data-link-segment="'+segment.exactStart+'"'+(segment.unplanned?' data-unplanned="true"':'')+' aria-label="'+esc(label)+'" title="'+esc(label)+'" style="top:'+segment.top+'px;height:'+segment.height+'px;left:calc('+segment.lane*width+'% + 4px);width:calc('+width+'% - 8px);--actual-color:'+color+'"><strong>'+esc(title)+'</strong>'+(segment.duration>30?'<small>'+displayRange+(segment.live?' · 计时中':'')+'</small>':'')+'</button>');
    }}
    return cards.join('')||'<div class="actual-empty">还没有执行记录</div>';
  }
  function blockTools(block,date){
    if(block.kind==='tag-slot')return '';
    const item=stats(date).items.find(i=>i.block.id===block.id),timer=tracking().timer,active=timer?.planDate===date&&timer.blockId===block.id;
    return '<div class="block-tracking"><div><strong>执行 '+minutes(item?.actualMinutes||0)+'</strong><small>已覆盖 '+minutes(item?.coveredMinutes||0)+' · 覆盖率 '+percent(item?.coverageRate??0)+'</small></div><div>'+btn(active?'timer-locate':'timer-start',active?'查看计时':'▶ 开始计时','primary',attrs(block,date))+btn('actual-history','执行记录','',attrs(block,date))+'</div></div>';
  }
  function details(){
    const dates=state().tab==='week'?Array.from({length:7},(_,i)=>addDays(mondayOf(state().date),i)):[state().date];
    const rows=dates.flatMap(date=>{
      const planned=stats(date).items.map(item=>'<tr><td>'+esc(item.block.title)+'<small>'+date+' · '+esc(classification(item.block))+(item.countsTowardsCompletion?'':' · 不计入完成度')+'</small></td><td>'+minutes(item.block.duration)+'</td><td>'+minutes(item.actualMinutes)+'</td><td>'+percent(item.coverageRate)+'</td></tr>');
      const temporary=new Map(),timer=tracking().timer;
      for(const record of [...tracking().sessions,...(timer?[{...timer,endedAt:Date.now()}]:[])]){
        if(record.planDate!==date||!record.unplanned)continue;
        const item=temporary.get(record.blockId)||{title:record.title,category:record.category,tagId:record.tagId,minutes:0};
        item.minutes+=record.startedAt===null?0:(record.endedAt-record.startedAt)/60000;temporary.set(record.blockId,item);
      }
      return [...planned,...[...temporary.values()].map(item=>'<tr><td>'+esc(item.title)+'<small>'+date+' · 临时任务 · '+esc(classification(item))+'</small></td><td>—</td><td>'+minutes(item.minutes)+'</td><td>—</td></tr>')];
    }).join('');
    modal('每项任务的用时','<p>每项任务最多覆盖自己的计划时长。临时任务计入执行用时，标签预留时段在填入任务后参与统计。</p><div class="tracking-table-scroll"><table class="tracking-table"><thead><tr><th>任务</th><th>计划</th><th>执行</th><th>时长覆盖率</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+(!rows?'<p>这段时间还没有任务或执行记录。</p>':''));
  }
  function history(date,id){
    const block=taskById(date,id);
    const owners=assignments(date);
    const sessions=tracking().sessions.filter(s=>s.planDate===date&&(owners.get('session:'+s.id)||(s.unplanned?'':s.blockId))===id).sort((a,b)=>a.startedAt-b.startedAt);
    modal('执行记录 · '+(block?.title||sessions[0]?.title||'任务'),'<div class="actual-record-list">'+sessions.map(s=>btn('actual-edit','<strong>'+precise(s.startedAt)+' → '+precise(s.endedAt)+'</strong><small>'+minutes((s.endedAt-s.startedAt)/60000)+' · '+esc(classification(s))+' · 点击修正</small>','export-option','data-id="'+esc(s.id)+'"')).join('')+'</div>'+(!sessions.length?'<p>尚无已结束的记录。暂停或结束计时后，记录会出现在这里。</p>':'')+'<div class="modal-actions">'+btn('actual-new','补录一段','primary','data-date="'+date+'" data-id="'+esc(id)+'"')+'</div>');
  }
  function recordForm(id,date=state().date,blockId=''){
    const session=tracking().sessions.find(s=>s.id===id);if(id&&!session)return;
    date=session?.planDate||date;blockId=session?(assignments(date).get('session:'+session.id)||session.blockId):blockId;
    const list=resolveDay(data(),date).blocks.filter(block=>block.kind!=='tag-slot').sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
    if(!session&&!list.length){toast('请先为这一天安排任务，再补录执行时间');return;}
    if(!session&&!list.some(b=>b.id===blockId))blockId=list[0].id;
    const selected=list.find(b=>b.id===blockId),plannedInput=minute=>addDays(date,Math.floor(minute/1440))+'T'+String(Math.floor(minute%1440/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0')+':00';
    const startValue=session?m.timeInputValue(session.startedAt,data().timezone):plannedInput(selected.start);
    const endValue=session?m.timeInputValue(session.endedAt,data().timezone):plannedInput(selected.start+selected.duration);
    const choices=list.map(b=>'<option value="'+esc(b.id)+'"'+(b.id===blockId?' selected':'')+'>'+esc(displayTime(b.start)+' · '+b.title+' · '+classification(b))+'</option>').join('');
    modal(session?'修正执行记录':'补录执行时间','<form id="actual-record-form" data-id="'+esc(session?.id||'')+'" data-date="'+date+'"><p>计划日期 '+date+' · '+esc(data().timezone)+'。保留精确时间，时间轴按最近半小时显示：不足 15 分钟舍去，满 15 分钟进位。</p><label for="actual-block">对应任务</label><select id="actual-block" name="blockId">'+(session&&!list.some(b=>b.id===blockId)?'<option value="'+esc(blockId)+'">'+esc('无计划时间 · '+session.title+' · '+classification(session))+(session.unplanned?'（临时任务）':'（计划已移除）')+'</option>':'')+choices+'</select>'+(session?'<p>本条记录：'+esc(classification(session))+'。更换关联任务后，标签随新任务更新。</p>':'')+'<label for="actual-start">执行开始</label><input id="actual-start" name="startedAt" type="datetime-local" step="1" required value="'+startValue+'"><label for="actual-end">执行结束</label><input id="actual-end" name="endedAt" type="datetime-local" step="1" required value="'+endValue+'"><div class="error" id="actual-error"></div><div class="modal-actions">'+(session?btn('actual-delete','删除记录','danger','type="button" data-id="'+esc(session.id)+'"'):'')+'<button type="submit" class="primary">保存执行记录</button></div></form>');
  }
  function submit(form){
    if(form.id==='new-timer-form')return submitNewTimer(form);
    if(form.id!=='actual-record-form')return false;
    try{
      const f=new FormData(form),id=form.dataset.id||uid(),date=form.dataset.date,blockId=String(f.get('blockId'));
      const original=tracking().sessions.find(s=>s.id===id);
      const readInstant=name=>{const value=String(f.get(name)),normalized=value.length===16?value+':00':value;return original&&normalized===m.timeInputValue(original[name],data().timezone)?original[name]:m.parseTimeInput(value,data().timezone);};
      const startedAt=readInstant('startedAt'),endedAt=readInstant('endedAt');
      if(endedAt<=startedAt)throw Error('结束时间必须晚于开始时间');
      if(endedAt>Date.now()+1000)throw Error('执行记录不能晚于当前时间');
      if(tracking().sessions.some(s=>s.id!==id&&s.startedAt<endedAt&&startedAt<s.endedAt))throw Error('这段时间与另一条执行记录重叠，请先调整已有记录');
      const timer=tracking().timer;if(timer?.startedAt!==null&&timer?.startedAt!==undefined&&endedAt>timer.startedAt)throw Error('这段时间与正在运行的计时重叠，请先暂停或结束计时');
      const keptUnplanned=original?.unplanned&&blockId===original.blockId;
      const planned=keptUnplanned?null:taskById(date,blockId);
      const block=planned||tracking().sessions.find(s=>s.id===id&&s.blockId===blockId);if(!block)throw Error('请选择对应任务');
      const originalOwner=original&&(assignments(date).get('session:'+id)||original.blockId);
      if(commit(d=>{
        if(planned&&!materializeDay(d,date).some(b=>b.id===blockId))throw Error('对应计划已发生变化，请重新选择任务');
        d.tracking??={sessions:[],timer:null};
        const tagId=originalOwner===blockId&&original.tagId!==undefined?original.tagId:tagIdFor(block);
        const record={id,planDate:date,blockId,title:block.title,category:block.category,startedAt,endedAt};
        if(tagId!==undefined)record.tagId=tagId;
        if(keptUnplanned)record.unplanned=true;
        if(planned)record.planBinding='explicit';else if(original?.planBinding)record.planBinding=original.planBinding;
        const index=d.tracking.sessions.findIndex(s=>s.id===id);if(index>=0)d.tracking.sessions[index]=record;else d.tracking.sessions.push(record);
      },'执行记录已保存',{recordUndo:false}))close();
    }catch(error){document.querySelector('#actual-error').textContent=error.message;}
    return true;
  }
  function transition(fn,message){try{return commit(fn,message,{recordUndo:false});}catch(error){toast(error.message);return false;}}
  function action(a,id,el){
    if(a==='tracking-view'){if(['plan','actual','compare'].includes(id)){setViewMode(id,state().tab==='week');render(true);}}
    else if(a==='tracking-details')details();
    else if(a==='timer-new')newTimerForm();
    else if(a==='timer-start'){
      const date=el.dataset.date||state().date,block=taskById(date,id);if(!block)return true;
      if(tracking().timer){toast('先结束当前任务的计时，再开始另一项');return true;}
      if(transition(d=>{materializeDay(d,date);m.startTracking(d,date,block,Date.now(),uid());},'已开始计时'))close();
    }
    else if(a==='timer-pause')transition(d=>m.pauseTracking(d,Date.now(),uid()),'已暂停，休息时间不计入');
    else if(a==='timer-resume')transition(d=>m.resumeTracking(d,Date.now()),'已继续计时');
    else if(a==='timer-stop'){
      const timer=tracking().timer;if(!timer)return true;const saved={...timer};
      if(transition(d=>m.stopTracking(d,Date.now(),uid()),'执行时间已保存')){
        const block=taskById(saved.planDate,saved.blockId);
        modal('计时已结束','<p>「'+esc(block?.title||saved.title)+'」的执行记录已保存。'+(block&&!block.done?'这项任务是否也已完成？':'')+'</p><div class="modal-actions">'+btn('close','关闭')+(block&&!block.done?btn('timer-complete','标记完成','primary','data-id="'+esc(saved.blockId)+'" data-date="'+saved.planDate+'"'):'')+'</div>');
      }
    }
    else if(a==='timer-complete'||a==='toggle-week'){
      const date=el.dataset.date;
      if(!taskById(date,id))return true;
      if(commit(d=>{const block=materializeDay(d,date).find(b=>b.id===id);if(!block)return;block.done=a==='timer-complete'?true:!block.done;const task=d.tasks.find(t=>t.id===block.taskId);if(task&&!task.reusable)task.done=block.done;}))if(a==='timer-complete')close();
    }
    else if(a==='timer-locate'){const timer=tracking().timer;if(timer){state().date=timer.planDate;state().tab='day';state().templateId=null;state().weekTemplateId=null;close();render();document.querySelector('.timer-bar')?.scrollIntoView({block:'nearest'});}}
    else if(a==='actual-new')recordForm(null,el.dataset.date||state().date,id||'');
    else if(a==='actual-edit')recordForm(id);
    else if(a==='actual-history')history(el.dataset.date,id);
    else if(a==='actual-delete')modal('删除执行记录','<p>删除这段执行时间后，用时统计会重新计算，计划保持不变。</p><div class="modal-actions">'+btn('actual-edit','取消','','data-id="'+esc(id)+'"')+btn('actual-confirm-delete','确认删除','danger','data-id="'+esc(id)+'"')+'</div>');
    else if(a==='actual-confirm-delete'){if(commit(d=>{d.tracking.sessions=d.tracking.sessions.filter(s=>s.id!==id);},'执行记录已删除',{recordUndo:false}))close();}
    else return false;
    return true;
  }
  let lastPaint=0;
  function tick(){
    const timer=tracking().timer;if(!timer)return;
    const total=tracking().sessions.filter(s=>s.planDate===timer.planDate&&s.blockId===timer.blockId).reduce((sum,s)=>sum+s.endedAt-s.startedAt,0)+(timer.startedAt===null?0:Math.max(0,Date.now()-timer.startedAt));
    document.querySelectorAll('[data-timer-elapsed]').forEach(el=>el.textContent=clock(total));
    if(Date.now()-lastPaint<5000||document.querySelector('#modal')?.open)return;lastPaint=Date.now();
    document.querySelectorAll('[data-tracking-metrics]').forEach(el=>el.innerHTML=metrics(el.dataset.scope==='week'));
    document.querySelectorAll('[data-actual-date]').forEach(el=>{if(!el.contains(document.activeElement))el.innerHTML=actualCards(el.dataset.actualDate,el.dataset.actualKind);});
    h.refreshTimeShares?.();h.refreshPlanLinks?.();
  }
  return {modeSelector,timerButton,bar,summary,renderActualEvents,blockTools,action,submit,tick};
}
