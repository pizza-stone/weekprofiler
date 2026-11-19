import { seedData, validateData, migrateData, resolveDay, materializeDay, snapshotWeek, mondayOf, addDays, MAX_STATE_BYTES, DAY_START, DAY_END, planningDate } from '/model.js';
import { createAIPlanner } from '/ai.js';
import { renderWeekly, renderWeekTemplateCards } from '/week.js';

const $ = s => document.querySelector(s);
const clone = v => JSON.parse(JSON.stringify(v));
const uid = () => {
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
};
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={calendar:'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z',layers:'m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5',list:'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',plus:'M12 5v14M5 12h14',search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',left:'m15 18-6-6 6-6',right:'m9 18 6-6-6-6',download:'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',close:'m6 6 12 12M6 18 18 6',copy:'M9 9h12v12H9V9ZM15 9V3H3v12h6',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',undo:'M3 7v6h6M3 13a8 8 0 1 1 3 6',check:'m5 12 4 4L19 6',clock:'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'};
const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';
const btn = (action,text,cls='',attrs='') => '<button class="'+cls+'" data-action="'+action+'" '+attrs+'>'+text+'</button>';
const time = n => (n>=1440?'次日 ':'')+String(Math.floor((n%1440)/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const duration = n => n%60 ? (n>60?Math.floor(n/60)+' 小时 ':'')+n%60+' 分钟' : n/60+' 小时';
const dayKey = (date=new Date()) => planningDate(date,state.data?.timezone||'Asia/Shanghai');
const dateObj = str => new Date(str+'T12:00:00');
const addDate = (str,n) => { const d=dateObj(str); d.setDate(d.getDate()+n);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
let state={data:null,revision:0,userId:'',dirty:false,pending:null,busy:false,conflict:false,status:'正在连接',tab:'week',date:'',templateId:null,weekTemplateId:null,templateKind:'day',weekFilter:'all',editDate:null,editWeekday:null,filter:'all',search:'',undo:[],ready:false};
let saveTimer,toastTimer,drag=null,storageFailed=false,changeGeneration=0,suppressClickUntil=0;
// Keep the original storage namespace so existing users retain their data.
const cacheKey=()=> 'dayloom-v1-'+state.userId;
function cache(){try{localStorage.setItem(cacheKey(),JSON.stringify({data:state.data,revision:state.revision,dirty:state.dirty,pending:state.pending}));}catch{storageFailed=true;toast('浏览器存储空间不足，请保持联网或导出备份');}}
function toast(msg){$('#toast').textContent=msg;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3300);}
function updateStatus(){document.querySelectorAll('[data-action="sync"]').forEach(el=>{el.innerHTML='<span class="dot"></span>'+esc(state.status);el.classList.toggle('warn',state.dirty||state.conflict);});}
function commit(fn,message){if(!state.ready)return false;const previous=clone(state.data);fn(state.data);if(!validateData(state.data)){state.data=previous;toast('内容超出容量或存在无效安排，未保存这次修改');return false;}state.undo.push(previous);if(state.undo.length>30)state.undo.shift();changeGeneration++;state.syncRejected=false;state.dirty=true;cache();render(true);queueSave();if(message)toast(message);return true;}
function queueSave(){state.status='等待同步';updateStatus();clearTimeout(saveTimer);saveTimer=setTimeout(save,550);}
async function save(){
 if(!state.dirty||state.busy||state.conflict||state.syncRejected)return;
 state.busy=true;state.status='正在同步';updateStatus();
 if(!state.pending)state.pending={data:clone(state.data),baseRevision:state.revision,mutationId:uid()};
 cache();const payload=state.pending;
 try{
   const r=await fetch('/api/planner',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   if(r.status===409){state.conflict=true;state.status='发现同步冲突';render(true);return;}
   if(r.status===401){state.status='请重新登录';updateStatus();return;}
   if(!r.ok){const err=await r.json().catch(()=>({}));if([400,413,415].includes(r.status)){state.pending=null;state.syncRejected=true;state.status='内容未获保存 · 请调整';cache();updateStatus();toast(err.error||'云端未接受这次修改，已保留本机内容');return;}throw new Error(err.error||'save');}
   const result=await r.json();state.revision=result.revision;state.pending=null;state.dirty=JSON.stringify(state.data)!==JSON.stringify(payload.data);cache();
   state.status=state.dirty?'等待同步':'已同步';updateStatus();
 }catch{state.status=storageFailed?'同步失败，请导出备份':'已存本机 · 待同步';updateStatus();}
 finally{state.busy=false;if(state.dirty&&!state.pending&&!state.conflict&&!state.syncRejected)queueSave();}
}
async function refresh(){
 if(state.busy)return;
 if(state.dirty){await save();return;}
 if($('#modal')?.open||drag||resize)return;
 const requestedRevision=state.revision,requestedGeneration=changeGeneration;
 try{const r=await fetch('/api/planner',{cache:'no-store'});if(!r.ok)throw Error();const v=await r.json();if(state.dirty||state.busy||state.conflict||state.revision!==requestedRevision||changeGeneration!==requestedGeneration||$('#modal')?.open||drag||resize)return;if(v.data&&v.revision!==state.revision){state.data=migrateData(v.data);state.revision=v.revision;state.undo=[];cache();render(true);}state.status='已同步';updateStatus();}catch{if(!state.dirty&&!state.busy){state.status='离线 · 已有内容可编辑';updateStatus();}}
}
async function boot(){
 try{
   const session=await fetch('/api/session',{cache:'no-store'});if(!session.ok)throw Error('auth');state.userId=(await session.json()).userId;
   let cached;try{cached=JSON.parse(localStorage.getItem(cacheKey())||'null');}catch{}
   if(cached&&!validateData(cached.data))cached=null;
   let remote;try{const r=await fetch('/api/planner',{cache:'no-store'});if(!r.ok)throw Error();remote=await r.json();}catch{if(!cached)throw Error('cloud');}
   if(cached?.dirty){Object.assign(state,{data:cached.data,revision:cached.revision,dirty:true,pending:cached.pending});}
   else{state.data=remote?.data||cached?.data||seedData();state.revision=remote?.revision||cached?.revision||0;state.dirty=!!remote&&!remote.data;}
   const upgraded=state.data.version!==3;state.data=migrateData(state.data);if(upgraded)state.dirty=true;state.date=dayKey();state.ready=true;state.status=remote?'已同步':'离线 · 已有内容可编辑';cache();render();if(state.dirty)queueSave();
   setInterval(refresh,12000);
 }catch(e){$('#app').innerHTML='<div class="boot-error panel"><div class="brand-mark">◷</div><h1>周谱</h1><p>'+(e.message==='auth'?'登录后，电脑和手机就能使用同一份时间表。':'暂时无法读取云端日程。请检查网络后重试；未连接成功时不会覆盖已有数据。')+'</p><a href="/signin-with-chatgpt?return_to=/" target="_top">登录 ChatGPT</a> '+btn('reload','重新尝试')+'</div>';}
}
const currentTemplate=()=>state.data.templates.find(t=>t.id===state.templateId);
const blocks=()=>state.weekTemplateId&&state.editWeekday!==null?(state.data.weekTemplates.find(w=>w.id===state.weekTemplateId)?.days[state.editWeekday]?.blocks||[]):state.templateId?(currentTemplate()?.blocks||[]):resolveDay(state.data,state.editDate||state.date).blocks;
const targetBlocks=d=>state.weekTemplateId&&state.editWeekday!==null?d.weekTemplates.find(w=>w.id===state.weekTemplateId).days[state.editWeekday].blocks:state.templateId?d.templates.find(t=>t.id===state.templateId).blocks:materializeDay(d,state.editDate||state.date);
const collision=(list,start,len,ignore)=>list.some(b=>b.id!==ignore&&b.start<start+len&&start<b.start+b.duration);
const currentTitle=()=>dateObj(state.date).toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
function filteredTasks(){return state.data.tasks.filter(t=>(state.filter==='all'||t.category===state.filter)&&(t.title.includes(state.search)));}
function taskCard(t){
 const meta=categoryMap()[t.category]+' · '+duration(t.duration)+(t.reusable?' · 可复用':'');
 const status=state.tab==='tasks'?btn('toggle-task',t.done?icon('check'):'','task-check','type="button" data-id="'+t.id+'" aria-pressed="'+t.done+'" aria-label="'+(t.done?'取消完成':'标记完成')+' '+esc(t.title)+'" title="'+(t.done?'取消完成':'标记完成')+'"'):'<span class="grip" aria-hidden="true">⠿</span>';
 return '<div class="task-card '+(t.done?'done':'')+'" draggable="true" data-task="'+t.id+'">'+status+'<div class="task-content" data-action="edit-task" data-id="'+t.id+'" role="button" tabindex="0" title="'+esc(t.title)+'"><strong>'+esc(t.title)+'</strong><div class="task-meta" title="'+esc(meta)+'"><i class="category-dot" style="background:'+groupFor(t.category).color+'"></i>'+esc(categoryMap()[t.category])+' <span>·</span> '+duration(t.duration)+(t.reusable?' <span>↻ 可复用</span>':'')+'</div></div>'+btn('schedule',icon('plus'),'schedule-btn','data-id="'+t.id+'" aria-label="安排 '+esc(t.title)+'"')+'</div>';
}
function filters(){return '<div class="filters">'+['all',...Object.keys(categoryMap())].map(c=>btn('filter',c==='all'?'全部':esc(categoryMap()[c]),state.filter===c?'active':'','data-id="'+c+'"')).join('')+'</div>';}
function pool(){return '<aside class="sidebar"><div class="panel pool"><div class="panel-title"><h2>待安排任务 <span class="count">'+state.data.tasks.filter(t=>!t.done).length+'</span></h2>'+btn('groups',icon('settings'),'icon ghost','aria-label="管理分组"')+btn('new-task',icon('plus'),'icon ghost','aria-label="新建任务"')+'</div><div class="search">'+icon('search')+'<input id="task-search" placeholder="找一个任务…" value="'+esc(state.search)+'" aria-label="搜索任务"></div>'+filters()+'<div class="task-list" id="pool-list">'+filteredTasks().filter(t=>!t.done||t.reusable).map(taskCard).join('')+'</div><p class="help">拖动任务到右侧时间表，或点击 ＋ 安排。<br>每一小格，是留给自己的 30 分钟。</p></div><div class="side-note">'+icon('sun')+' <strong>给一天留一点空白</strong><p>不必填满每个时段。休息和临时变化，也值得被安排。</p></div></aside>';}
function week(){const d=dateObj(state.date),day=(d.getDay()+6)%7,start=addDate(state.date,-day);return '<div class="week">'+Array.from({length:7},(_,i)=>{const key=addDate(start,i);return btn('date','<small>'+['周一','周二','周三','周四','周五','周六','周日'][i]+'</small><b>'+dateObj(key).getDate()+'</b><span class="has '+(resolveDay(state.data,key).blocks.length?'':'empty')+'"></span>',key===state.date?'selected':'','data-date="'+key+'" aria-label="'+key+'"');}).join('')+'</div>';}
function timeline(){
 const bs=blocks(),total=bs.reduce((a,b)=>a+b.duration,0),done=bs.filter(b=>b.done).length;
 let content='<div class="panel calendar">';
 if(!state.templateId)content+='<div class="calendar-head"><div class="calendar-top"><strong>'+dateObj(state.date).toLocaleDateString('zh-CN',{year:'numeric',month:'long'})+'</strong><div class="date-controls">'+btn('prev',icon('left'),'icon ghost','aria-label="上一周"')+btn('today','今天')+btn('next',icon('right'),'icon ghost','aria-label="下一周"')+'<input type="date" id="date-picker" value="'+state.date+'" aria-label="选择日期"></div></div>'+week()+'</div>';
 else content+='<div class="calendar-head"><div class="panel-title"><h2>模板时间表</h2><span class="template-tag">编辑不会改变已有日程</span></div></div>';
 content+='<div class="calendar-toolbar"><div class="summary"><span>已安排 <b>'+duration(total)+'</b></span><span>'+bs.length+' 项安排'+(!state.templateId?' · '+done+' 项完成':'')+'</span></div><div class="segments">'+btn('scroll','上午','','data-minute="480"')+btn('scroll','下午','','data-minute="720"')+btn('scroll','晚上','','data-minute="1080"')+'</div>'+btn('pick-task','＋ 选任务','mobile-pool-button')+'</div>';
 content+='<div class="scroll-timeline"><div class="timeline">'+Array.from({length:48},(_,i)=>'<div class="time-row '+(i%2===0?'hour':'')+'" data-minute="'+(DAY_START+i*30)+'" data-action="new-block">'+(i%2===0?'<span class="time-label">'+time(DAY_START+i*30)+'</span>':'')+'</div>').join('');
 content+=bs.map(b=>'<div class="event '+b.category+(b.done?' done':'')+(b.duration>30?' long':'')+'" draggable="true" data-block="'+b.id+'" data-action="edit-block" data-id="'+b.id+'" role="button" tabindex="0" aria-label="'+esc(b.title)+' '+time(b.start)+' 至 '+time(b.start+b.duration)+'" title="'+esc(b.title)+' · '+time(b.start)+' — '+time(b.start+b.duration)+'" style="'+groupStyle(b.category)+';top:'+((b.start-DAY_START)/30*26+1)+'px;height:'+(b.duration/30*26-3)+'px">'+(!state.templateId?btn('toggle',b.done?icon('check'):'','check','type="button" data-id="'+b.id+'" aria-pressed="'+b.done+'" aria-label="'+(b.done?'取消完成':'标记完成')+' '+esc(b.title)+'"'):'')+'<div class="event-main"><strong>'+esc(b.title)+'</strong>'+(b.duration>30?'<small>'+time(b.start)+' — '+time(b.start+b.duration)+'</small>':'')+'</div><div class="resize" data-resize="'+b.id+'" title="拖动调整时长"></div></div>').join('');
 if(!bs.length)content+='<div class="timeline-empty">'+icon('sun')+'<strong>这一天，留给你来安排</strong><span>从一个任务开始，或应用熟悉的日模板。</span><br>'+btn(state.templateId?'new-block':'apply',state.templateId?'添加第一项安排':'选择日模板','', 'data-minute="540"')+'</div>';
 return content+'</div></div><div class="timeline-footer"><span>04:00 至次日 04:00 · 30 分钟刻度</span>'+(state.data.cycle.enabled&&!state.templateId&&Object.hasOwn(state.data.days,state.date)?btn('restore-cycle','恢复周循环','ghost'):'')+btn('undo',icon('undo')+' 撤销','ghost',state.undo.length?'':'disabled')+'</div></div>';
}
function templateCards(){return '<div class="template-grid">'+state.data.templates.map(t=>'<article class="panel template-card"><div class="template-art" aria-hidden="true">'+t.blocks.slice(0,5).map((b,i)=>'<span style="width:'+(50+(b.duration%90)/2+i*3)+'%"></span>').join('')+'</div><h2>'+esc(t.name)+'</h2><p>'+esc(t.description||'按照自己的节奏，安排一天。')+'</p><div class="template-info"><span>'+t.blocks.length+' 项安排</span><span>'+duration(t.blocks.reduce((a,b)=>a+b.duration,0))+'</span></div><div class="actions"><div>'+btn('edit-template','编辑','','data-id="'+t.id+'"')+' '+btn('copy-template',icon('copy'),'icon','data-id="'+t.id+'" aria-label="复制 '+esc(t.name)+'"')+'</div>'+btn('apply','应用到日期','primary','data-id="'+t.id+'"')+'</div><div class="repeat-row">'+btn('repeat-template',icon('calendar')+'<span class="repeat-label">'+weekdayCaption(t)+'</span><span class="repeat-edit">设置</span>','repeat-button'+(state.data.cycle.enabled&&state.data.cycle.days.some(d=>d.templateId===t.id)?' is-active':''),'data-id="'+t.id+'" aria-label="设置 '+esc(t.name)+' 的每周循环"')+'</div></article>').join('')+btn('new-template',icon('plus')+'<span>创建一个日模板</span>','new-template')+'</div>';}
function render(keep=false){
 if(state.weekTemplateId&&!state.data.weekTemplates.some(w=>w.id===state.weekTemplateId)){state.weekTemplateId=null;state.editWeekday=null;state.editDate=null;state.tab='templates';state.templateKind='week';}
 const scroll=$('.scroll-timeline')?.scrollTop,weekScroll=$('.week-view-scroll')?.scrollTop,weekLeft=$('.week-view-scroll')?.scrollLeft;
 const nav=Object.entries({week:['calendar','一周'],day:['calendar','日程'],templates:['layers','模板'],tasks:['list','任务']}).map(([id,v])=>btn('tab',icon(v[0])+v[1],state.tab===id?'active':'','data-id="'+id+'"')).join('');
 let main='';
 if(state.weekTemplateId||state.tab==='week')main=renderWeekPage();
 else if(state.templateId){const t=currentTemplate();if(!t){state.templateId=null;return render();}main='<div class="intro"><div><p class="eyebrow">DAY TEMPLATE / 日模板</p><div class="template-editor-title">'+btn('back',icon('left'),'icon','aria-label="返回模板列表"')+'<h1>'+esc(t.name)+'</h1>'+btn('rename-template',icon('settings'),'icon ghost','aria-label="修改模板名称"')+'</div><p>'+esc(t.description||'为一种日常，保存一份从容。')+'</p></div><div class="intro-actions">'+btn('repeat-template',icon('calendar')+'设置每周循环','repeat-button','data-id="'+t.id+'"')+btn('new-block',icon('plus')+'添加安排','','data-minute="540"')+btn('apply','应用模板','primary','data-id="'+t.id+'"')+'</div></div><div class="workspace">'+pool()+timeline()+'</div>';}
 else if(state.tab==='day')main='<div class="intro"><div><p class="eyebrow">A LITTLE MORE INTENTION / 把时间留给重要的事</p><h1>'+currentTitle()+'</h1><p>跟随自己的节奏，好好度过今天。</p></div><div class="intro-actions">'+btn('save-template',icon('copy')+'存为模板')+btn('apply',icon('layers')+'应用模板','primary')+'</div></div><div class="workspace">'+pool()+timeline()+'</div>';
 else if(state.tab==='templates')main='<div class="intro"><div><p class="eyebrow">YOUR DAILY RHYTHMS</p><h1>熟悉的日常，一键开始。</h1><p>为工作日、周末或特别的一天，留下一份可复用的安排。</p></div><div class="intro-actions">'+btn(state.templateKind==='week'?'new-week-template':'new-template',icon('plus')+'新建模板','primary')+'</div></div><div class="template-switch">'+btn('template-kind','日模板',state.templateKind==='day'?'active':'','data-id="day"')+btn('template-kind','周模板',state.templateKind==='week'?'active':'','data-id="week"')+'</div>'+(state.templateKind==='week'?renderWeekTemplateCards(state.data,viewHelpers):templateCards());
 else main='<div class="intro"><div><p class="eyebrow">ONE THING AT A TIME</p><h1>先记下来，再慢慢安排。</h1><p>一次性的待办，或想经常做的事，都放在这里。</p></div><div class="intro-actions">'+btn('new-task',icon('plus')+'新建任务','primary')+'</div></div><div class="all-tasks"><div class="group-toolbar">'+btn('groups','管理分组')+'</div>'+filters()+'<div class="task-list">'+filteredTasks().map(taskCard).join('')+'</div>'+(state.data.tasks.length?'':'<div class="empty-state">还没有任务。添加一件想做的事吧。</div>')+'</div>';
 $('#app').innerHTML='<header class="header"><div class="brand"><div class="brand-mark">◷</div><div><strong>周谱</strong><small>weekprofiler</small></div></div><nav class="tabs" aria-label="主导航">'+nav+'</nav><div class="header-actions">'+btn('ai','✦ AI','ai-launch','aria-label="AI 整理日程"')+btn('sync','','sync ghost')+btn('export',icon('download'),'icon desktop-export','aria-label="导出与备份"')+btn('settings',icon('settings'),'icon ghost','aria-label="设置"')+'</div></header><main class="shell">'+(state.conflict?'<div class="notice"><span>另一台设备更新了日程。本机修改已保留，暂未覆盖云端。可先导出本机备份，再载入云端版本。</span><div>'+btn('backup','导出本机备份')+' '+btn('resolve-conflict','载入云端版本')+'</div></div>':'')+main+'</main><nav class="bottom-nav" aria-label="手机导航">'+nav+'</nav>';
 updateStatus();if(keep&&$('.week-view-scroll')){$('.week-view-scroll').scrollTop=weekScroll||0;$('.week-view-scroll').scrollLeft=weekLeft||0;}if($('.scroll-timeline'))$('.scroll-timeline').scrollTop=keep&&scroll!==undefined?scroll:Math.max(0,((blocks().length?Math.min(...blocks().map(b=>b.start)):480)-DAY_START-60)/30*26);
}
function modal(title,content){$('#modal').innerHTML='<div class="modal-head"><h2>'+esc(title)+'</h2>'+btn('close',icon('close'),'icon ghost','aria-label="关闭"')+'</div><div class="modal-body">'+content+'</div>';if(!$('#modal').open)$('#modal').showModal();setTimeout(()=>($('#modal textarea')||$('#modal input:not([type=checkbox]),#modal select'))?.focus(),50);}
function close(){ $('#modal').close();state.editDate=null;state.editWeekday=null; }
const options=(obj,selected)=>Object.entries(obj).map(([k,v])=>'<option value="'+k+'" '+(String(k)===String(selected)?'selected':'')+'>'+esc(v)+'</option>').join('');
const durations=()=>Object.fromEntries(Array.from({length:48},(_,i)=>[(i+1)*30,duration((i+1)*30)]));
const defaultGroupId=()=>{const selected=state.weekTemplateId||state.tab==='week'?state.weekFilter:state.filter;return state.data.groups.some(g=>g.id===selected)?selected:state.data.groups[0].id;};
let aiPlanner=null;
function getAIPlanner(){return aiPlanner??=createAIPlanner({getData:()=>state.data,getDate:()=>state.date,getScope:()=>state.weekTemplateId||state.tab==='week'?'week':'day',getGroup:()=>state.weekTemplateId||state.tab==='week'?state.weekFilter:state.filter,commit,modal,toast,time,esc,uid});}
function taskForm(id){const t=state.data.tasks.find(t=>t.id===id)||{title:'',duration:60,category:defaultGroupId(),reusable:false,done:false};modal(id?'编辑任务':'记录一件想做的事','<form id="task-form" data-id="'+(id||'')+'"><label for="title">任务名称</label><input id="title" name="title" required maxlength="100" placeholder="例如：阅读一篇论文" value="'+esc(t.title)+'"><div class="form-row"><div><label for="category">分类</label><select id="category" name="category">'+options(categoryMap(),t.category)+'</select></div><div><label for="duration">预计时长</label><select id="duration" name="duration">'+options(durations(),t.duration)+'</select></div></div><label class="check-label"><input type="checkbox" name="reusable" '+(t.reusable?'checked':'')+'>可复用活动（如学习、运动）</label>'+(id?'<label class="check-label"><input type="checkbox" name="done" '+(t.done?'checked':'')+'>任务已完成</label>':'')+'<div class="modal-actions">'+(id?btn('delete-task','删除','danger','data-id="'+id+'" type="button"'):'')+'<button class="primary" type="submit">保存任务</button></div></form>');}
function taskChoice(taskId){return '<label for="block-task-picker">从任务池选择（可选）</label><select id="block-task-picker">'+options({'':'自定义安排',...Object.fromEntries(state.data.tasks.filter(t=>!t.done||t.reusable).map(t=>[t.id,t.title]))},taskId||'')+'</select>';}
function blockForm({id,taskId,start=540}={}){const b=blocks().find(b=>b.id===id),t=state.data.tasks.find(t=>t.id===taskId),v=b||{title:t?.title||'',start,duration:t?.duration||60,category:t?.category||defaultGroupId()};
 modal(b?'调整安排':t?'安排到'+(state.templateId?'模板':'当天'):'添加一项安排','<form id="block-form" data-id="'+(id||'')+'" data-task="'+(taskId||b?.taskId||'')+'">'+(!b?taskChoice(taskId):'')+'<label for="title">安排名称</label><input id="title" name="title" required maxlength="100" value="'+esc(v.title)+'" placeholder="想做什么？"><div class="form-row"><div><label for="start">开始时间</label><select id="start" name="start">'+options(Object.fromEntries(Array.from({length:48},(_,i)=>[DAY_START+i*30,time(DAY_START+i*30)])),v.start)+'</select></div><div><label for="duration">持续时间</label><select id="duration" name="duration">'+options(durations(),v.duration)+'</select></div></div><label for="category">分类</label><select id="category" name="category">'+options(categoryMap(),v.category)+'</select><div class="error" id="form-error"></div><div class="modal-actions">'+(b?btn('delete-block','移除安排','danger','type="button" data-id="'+b.id+'"'):'')+'<button class="primary" type="submit">保存安排</button></div></form>');
}
function templateForm(mode,id){const t=state.data.templates.find(t=>t.id===id);modal(mode==='rename'?'修改模板':mode==='save'?'把这一天存为模板':'新建日模板','<form id="template-form" data-mode="'+mode+'" data-id="'+(id||'')+'"><label for="name">模板名称</label><input id="name" name="name" required maxlength="60" value="'+esc(t?.name||'')+'" placeholder="例如：周末充电日"><label for="description">一句描述（可选）</label><input id="description" name="description" maxlength="200" value="'+esc(t?.description||'')+'" placeholder="这个日子，想以什么节奏度过？"><div class="modal-actions">'+(mode==='rename'?btn('delete-template','删除模板','danger','type="button" data-id="'+id+'"'):'')+'<button class="primary" type="submit">保存模板</button></div></form>');}
function applyForm(id){if(!state.data.templates.length){toast('先创建一个日模板');return;}modal('把熟悉的安排，放进一天','<form id="apply-form"><label for="template">选择模板</label><select id="template" name="template">'+options(Object.fromEntries(state.data.templates.map(t=>[t.id,t.name])),id||state.data.templates[0].id)+'</select><div class="form-row"><div><label for="date">应用到日期</label><input id="date" name="date" type="date" required value="'+state.date+'"></div><div><label for="apply-mode">已有日程</label><select id="apply-mode" name="mode"><option value="merge">保留，跳过冲突</option><option value="replace">替换整天（可撤销）</option></select></div></div><p>应用后生成独立日程。之后编辑模板，不会改变这一天。已完成的一次性任务会跳过。</p><div class="callout" id="apply-preview"></div><div class="error" id="form-error"></div><div class="modal-actions"><button type="submit" class="primary">应用到这一天</button></div></form>');previewApply();}
function proposedApply(form){const f=new FormData(form),t=state.data.templates.find(t=>t.id===f.get('template')),date=String(f.get('date')),replace=f.get('mode')==='replace';const out=replace?[]:clone(resolveDay(state.data,date).blocks);let skipped=0,added=0;for(const b of t?.blocks||[]){const task=state.data.tasks.find(t=>t.id===b.taskId);if((task?.done&&!task.reusable)||collision(out,b.start,b.duration)){skipped++;continue;}out.push({...b,id:uid(),done:false});added++;}return {out,date,skipped,added};}
function previewApply(){const f=$('#apply-form');if(!f)return;const p=proposedApply(f);$('#apply-preview').textContent='将添加 '+p.added+' 项安排'+(p.skipped?'，跳过 '+p.skipped+' 项冲突或已完成的待办':'')+'。';}
function pickTask(){modal('选择一个任务','<div class="task-list">'+state.data.tasks.filter(t=>!t.done||t.reusable).map(taskCard).join('')+'</div><div class="modal-actions">'+btn('new-task','新建任务','primary')+'</div>');}
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function backup(){download('weekprofiler-backup-'+dayKey()+'.json',JSON.stringify({app:'weekprofiler',exportedAt:new Date().toISOString(),data:state.data},null,2),'application/json');}
function utcDate(date,min,zone){let candidate=new Date(date+'T00:00:00Z').getTime()+min*60000;const intended=candidate;const representedAt=value=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));return Date.UTC(+o.year,+o.month-1,+o.day,+o.hour,+o.minute,+o.second);};for(let i=0;i<3;i++)candidate+=intended-representedAt(candidate);if(representedAt(candidate)!==intended)throw Error('日程含夏令时跳过的钟点，请调整后再导出');return new Date(candidate).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');}
// Existing ICS event UIDs retain @dayloom to keep calendar identity stable.
function calendarExport(all=false){
 const escapeICS=s=>String(s).replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//weekprofiler//Personal Planner//ZH','CALSCALE:GREGORIAN','X-WR-CALNAME:周谱'];
 const entries=(all==='week'||all==='four')?Array.from({length:all==='week'?7:28},(_,i)=>{const date=addDays(mondayOf(state.date),i);return [date,resolveDay(state.data,date).blocks];}):all?Object.entries(state.data.days):[[state.date,resolveDay(state.data,state.date).blocks]];
 let count=0;for(const [date,bs] of entries)for(const b of bs){count++;lines.push('BEGIN:VEVENT','UID:'+date+':'+b.id+'@dayloom','DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),'DTSTART:'+utcDate(date,b.start,state.data.timezone),'DTEND:'+utcDate(date,b.start+b.duration,state.data.timezone),'SUMMARY:'+escapeICS(b.title),'DESCRIPTION:'+escapeICS('周谱 · '+categoryMap()[b.category]+(b.done?' · 已完成':'')),'END:VEVENT');}
 if(!count){toast('还没有可导出的日程');return;}lines.push('END:VCALENDAR');const folded=lines.map(line=>{let out='',chunk='',size=0;for(const ch of line){const n=new TextEncoder().encode(ch).length;if(size+n>74){out+=chunk+'\r\n ';chunk='';size=1;}chunk+=ch;size+=n;}return out+chunk;}).join('\r\n')+'\r\n';
 download('weekprofiler-'+(all==='week'?'week-'+mondayOf(state.date):all==='four'?'4weeks-'+mondayOf(state.date):all?'saved-days':state.date)+'.ics',folded,'text/calendar;charset=utf-8');toast('已导出 '+count+' 项日程，需在日历中手动导入');close();
}
function exportModal(){modal('带走你的安排',btn('windows-calendar','<strong>Windows / Outlook 日历（可选）</strong><small>导出周循环，查看导入步骤</small>','export-option')+btn('ics-week','<strong>导出当前周</strong><small>包含周循环与单日例外</small>','export-option')+btn('ics-4weeks','<strong>导出从本周起 4 周</strong><small>把循环展开为具体日期，兼容日历导入</small>','export-option')+'<p>日历文件用于手动导入。再次修改网页日程后，需要重新导出；它不会自动更新手机日历。</p>'+btn('ics-day','<strong>导出选中日期 · '+state.date+'</strong><small>标准 .ics 日历文件</small>','export-option')+btn('ics-all','<strong>导出所有手动保存的日期</strong><small>循环日期请使用上方按周导出</small>','export-option')+btn('backup','<strong>完整数据备份</strong><small>保存任务、模板、每日安排及设置 · JSON</small>','export-option')+'<div class="callout" style="margin-top:16px">华为 4.3 是否能直接打开日历文件，需要在手机上验证。自动同步可以后续连接日历账户，当前尚未接入。</div>');}
function settings(){modal('让周谱适合你',btn('ai','✦ AI 对话整理日程','export-option')+btn('groups','自定义任务分组','export-option')+btn('cycle-settings','设置每周循环','export-option')+'<div class="settings-row"><strong>电脑与手机同步</strong><p>在两端用同一个 ChatGPT 账户打开本网站。打开页面时同步，并每 12 秒检查更新。</p><p>当前：'+esc(state.status)+'</p></div><div class="settings-row"><strong>日程时区</strong><p>导出的手机日历使用这个时区，模板仍按当地钟点安排。</p><select id="timezone" aria-label="日程时区">'+options({'Asia/Shanghai':'北京时间 · UTC+8','Asia/Singapore':'新加坡 · UTC+8','America/Los_Angeles':'洛杉矶 · 夏令时自动调整','UTC':'协调世界时 · UTC'},state.data.timezone)+'</select></div><div class="settings-row"><strong>添加到手机桌面</strong><p>华为浏览器打开此网址，在菜单中选择「添加至 → 桌面」。首次加载需要网络；已打开的页面支持断网编辑，恢复联网后补同步。</p></div>'+btn('export','日历导出与备份','export-option')+'<label class="export-option" for="import-file">从 JSON 备份恢复<input type="file" id="import-file" accept=".json,application/json" style="margin-top:10px"></label><p>恢复会替换当前数据，先预览确认，并可撤销。</p>');}
let restoreData=null;
document.addEventListener('click',async e=>{
 if(Date.now()<suppressClickUntil){e.preventDefault();return;}
 const el=e.target.closest('[data-action]');if(!el)return;const a=el.dataset.action,id=el.dataset.id;
 if(a==='reload'){location.reload();return;}if(!state.ready)return;
 if(handleV2Action(a,id,el))return;
 if(a==='close')close();
 else if(a==='tab'){state.tab=id;state.templateId=null;state.weekTemplateId=null;state.editDate=null;state.editWeekday=null;state.filter='all';state.search='';render();}
 else if(a==='filter'){state.filter=id;render(true);}
 else if(a==='new-task')taskForm();
 else if(a==='edit-task')taskForm(id);
 else if(a==='toggle-task'){if(state.data.tasks.some(t=>t.id===id))commit(d=>{const t=d.tasks.find(t=>t.id===id);t.done=!t.done;});}
 else if(a==='schedule'){if(state.tab==='tasks'||state.tab==='week'){state.tab='day';state.templateId=null;render();}blockForm({taskId:id});}
 else if(a==='pick-task')pickTask();
 else if(a==='new-block')blockForm({start:el.dataset.minute===undefined?540:Number(el.dataset.minute)});
 else if(a==='edit-block')blockForm({id});
 else if(a==='toggle'){commit(d=>{const b=targetBlocks(d).find(b=>b.id===id);b.done=!b.done;const t=d.tasks.find(t=>t.id===b.taskId);if(t&&!t.reusable)t.done=b.done;});}
 else if(a==='date'){state.date=el.dataset.date;render();}
 else if(a==='today'){state.date=dayKey();render();}
 else if(a==='prev'||a==='next'){state.date=addDate(state.date,a==='prev'?-7:7);render();}
 else if(a==='scroll')$('.scroll-timeline')?.scrollTo({top:(Number(el.dataset.minute)-DAY_START)/30*26-10,behavior:'smooth'});
 else if(a==='new-template')templateForm('new');
 else if(a==='save-template')templateForm('save');
 else if(a==='rename-template')templateForm('rename',state.templateId);
 else if(a==='copy-template'){commit(d=>{const t=d.templates.find(t=>t.id===id);d.templates.push({...clone(t),id:uid(),name:t.name.slice(0,54)+' · 副本',blocks:t.blocks.map(b=>({...b,id:uid(),done:false}))});},'模板已复制');}
 else if(a==='edit-template'){state.templateId=id;state.weekTemplateId=null;state.tab='templates';render();}
 else if(a==='back'){state.templateId=null;render();}
 else if(a==='apply')applyForm(id);
 else if(a==='delete-task'){commit(d=>{d.tasks=d.tasks.filter(t=>t.id!==id);for(const bs of allBlockLists(d))for(const b of bs)if(b.taskId===id)delete b.taskId;},'任务已移除，已有安排保留');close();}
 else if(a==='delete-block'){commit(d=>{const list=targetBlocks(d);list.splice(list.findIndex(b=>b.id===id),1)},'已移除安排');close();}
 else if(a==='delete-template'){commit(d=>{d.templates=d.templates.filter(t=>t.id!==id);state.templateId=null;},'模板已删除，已应用的日程保留');close();}
 else if(a==='undo'){if(state.undo.length){state.data=state.undo.pop();changeGeneration++;state.syncRejected=false;state.dirty=true;cache();render(true);queueSave();toast('已撤销上一步');}}
 else if(a==='sync'){if(state.status==='请重新登录')location.href='/signin-with-chatgpt?return_to=/';else{await refresh();toast(state.status);}}
 else if(a==='ai')getAIPlanner().open();
 else if(a==='settings')settings();
 else if(a==='export')exportModal();
 else if(a==='backup'){backup();toast('已导出完整备份');}
  else if(a==='ics-day'||a==='ics-all'){try{calendarExport(a==='ics-all');}catch(error){toast(error.message||'日历导出失败，请检查日程时区');}}
 else if(a==='resolve-conflict'){modal('载入云端版本','<p>这会用云端版本替换本机的待同步修改。建议先保存本机备份，以便之后手动合并。</p><div class="modal-actions">'+btn('backup','先导出备份')+btn('confirm-cloud','载入云端','primary')+'</div>');}
 else if(a==='confirm-cloud'){try{const r=await fetch('/api/planner',{cache:'no-store'});if(!r.ok)throw Error();const v=await r.json();state.data=migrateData(v.data||seedData());state.revision=v.revision;changeGeneration++;state.pending=null;state.dirty=false;state.conflict=false;state.syncRejected=false;state.undo=[];state.status='已同步';cache();close();render(true);}catch{toast('未能读取云端，已保留本机内容');}}
 else if(a==='confirm-import'&&restoreData){commit(d=>{state.data=clone(restoreData);state.templateId=null;state.weekTemplateId=null;state.filter='all';state.weekFilter='all';},'备份已恢复，可撤销');restoreData=null;close();}
});
document.addEventListener('submit',e=>{
 const form=e.target;if(handleV2Submit(form)){e.preventDefault();return;} if(!['task-form','block-form','template-form','apply-form'].includes(form.id))return;e.preventDefault();const f=new FormData(form);
 if(form.id==='task-form'){const title=String(f.get('title')).trim();if(!title)return;const id=form.dataset.id||uid();const value={id,title,duration:Number(f.get('duration')),category:f.get('category'),reusable:f.get('reusable')==='on',done:f.get('done')==='on'};commit(d=>{const i=d.tasks.findIndex(t=>t.id===id);if(i>=0)d.tasks[i]=value;else d.tasks.push(value);},'任务已保存');close();}
 if(form.id==='block-form'){const start=Number(f.get('start')),len=Number(f.get('duration')),id=form.dataset.id||uid(),title=String(f.get('title')).trim();if(!title)return;if(start<DAY_START||start+len>DAY_END){$('#form-error').textContent='安排不能超出次日 04:00，请缩短时长或拆到下一个排程日。';return;}if(collision(blocks(),start,len,id)){$('#form-error').textContent='这个时段已有安排，换一个开始时间试试。';return;}const old=blocks().find(b=>b.id===id);const b={id,title,start,duration:len,category:f.get('category'),done:old?.done||false,...(form.dataset.task?{taskId:form.dataset.task}:{})};commit(d=>{const bs=targetBlocks(d),i=bs.findIndex(b=>b.id===id);if(i>=0)bs[i]=b;else bs.push(b);},'安排已保存');close();}
 if(form.id==='template-form'){const name=String(f.get('name')).trim();if(!name)return;const mode=form.dataset.mode,id=form.dataset.id||uid();commit(d=>{if(mode==='rename'){Object.assign(d.templates.find(t=>t.id===id),{name,description:String(f.get('description')).trim()});}else{d.templates.push({id,name,description:String(f.get('description')).trim(),blocks:mode==='save'?clone(resolveDay(d,state.date).blocks).map(b=>({...b,id:uid(),done:false})):[]});state.templateId=id;state.weekTemplateId=null;state.tab='templates';}},'模板已保存');close();}
 if(form.id==='apply-form'){const p=proposedApply(form);if(!/^\d{4}-\d{2}-\d{2}$/.test(p.date))return;commit(d=>{d.days[p.date]=p.out;const applied=d.templates.find(t=>t.id===new FormData(form).get('template'));d.dayMeta[p.date]={templateId:applied.id,templateName:applied.name};state.date=p.date;state.templateId=null;state.tab='day';},'已添加 '+p.added+' 项安排'+(p.skipped?'，跳过 '+p.skipped+' 项':''));close();}
});
document.addEventListener('input',e=>{if(e.target.id==='task-search'){state.search=e.target.value;$('#pool-list').innerHTML=filteredTasks().filter(t=>!t.done||t.reusable).map(taskCard).join('');}});
document.addEventListener('change',async e=>{
 if(e.target.id==='block-task-picker'){if(e.target.value)blockForm({taskId:e.target.value,start:Number($('#start').value)});else $('#block-form').dataset.task='';}
 if(e.target.closest('#apply-form'))previewApply();
 if(e.target.closest('#week-apply-form'))previewWeekApply();
 if(['assign-day-template','assign-week-template-day'].includes(e.target.dataset.action))assignDayForm(e.target);
 if(e.target.id==='date-picker'&&e.target.value){state.date=e.target.value;render();}
 if(e.target.id==='timezone'){commit(d=>d.timezone=e.target.value,'时区已保存');}
 if(e.target.id==='import-file'){try{const file=e.target.files[0];if(!file)return;if(file.size>MAX_STATE_BYTES*4)throw Error();const raw=JSON.parse(await file.text());if(!validateData(raw.data))throw Error();restoreData=migrateData(raw.data);modal('恢复备份预览','<p>此备份包含 '+raw.data.tasks.length+' 个任务、'+raw.data.templates.length+' 个模板和 '+Object.keys(raw.data.days).length+' 天日程。</p><div class="callout">确认后会替换当前全部内容，支持撤销。建议先导出当前备份。</div><div class="modal-actions">'+btn('backup','导出当前备份')+btn('confirm-import','确认恢复','primary')+'</div>');}catch{toast('备份格式不正确或文件过大，未修改数据');}}
});
document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[role=button][data-action]')){e.preventDefault();e.target.click();}});
function dragContainer(column){
 if(column){
  const weekday=Number(column.dataset.weekday);
  return state.weekTemplateId?{kind:'week-template',templateId:state.weekTemplateId,weekday}:{kind:'day',date:column.dataset.date};
 }
 return state.templateId?{kind:'day-template',templateId:state.templateId}:{kind:'day',date:state.date};
}
function dropTarget(e){
 const column=e.target.closest('.week-day-column');
 const timeline=column||e.target.closest('.timeline');
 if(!timeline)return null;
 const rect=timeline.getBoundingClientRect(),gridStart=column?Number(column.dataset.gridStart):DAY_START;
 if(!Number.isFinite(gridStart))return null;
 const height=column?(rect.height||timeline.clientHeight||(DAY_END-gridStart)/30*26):48*26;
 const y=e.clientY-rect.top;
 if(y<0||y>=height)return null;
 const minute=gridStart+Math.floor(y/26)*30;
 if(minute<DAY_START||minute>=DAY_END)return null;
 return {minute,container:dragContainer(column),element:timeline,weekly:!!column};
}
function dropMinute(e){return dropTarget(e)?.minute??null;}
function dragBlocks(data,container,mutable=false){
 if(!container)return null;
 if(container.kind==='day')return mutable?materializeDay(data,container.date):resolveDay(data,container.date).blocks;
 if(container.kind==='day-template')return data.templates.find(t=>t.id===container.templateId)?.blocks||null;
 if(container.kind==='week-template')return data.weekTemplates.find(t=>t.id===container.templateId)?.days[container.weekday]?.blocks||null;
 return null;
}
function sameDragContainer(a,b){
 if(!a||!b||a.kind!==b.kind)return false;
 if(a.kind==='day')return a.date===b.date;
 if(a.kind==='day-template')return a.templateId===b.templateId;
 return a.templateId===b.templateId&&a.weekday===b.weekday;
}
function clearDragTargets(){document.querySelectorAll('.drag-target').forEach(x=>x.classList.remove('drag-target'));}
document.addEventListener('dragstart',e=>{
 if(resize||e.target.closest('[data-resize]')){e.preventDefault();return;}
 const task=e.target.closest('[data-task]'),block=e.target.closest('[data-block]');
 if(block)drag={type:'block',id:block.dataset.block,source:dragContainer(block.closest('.week-day-column'))};
 else if(task)drag={type:'task',id:task.dataset.task};else return;
 e.dataTransfer.setData('text/plain',JSON.stringify(drag));e.dataTransfer.effectAllowed=drag.type==='task'?'copy':'move';
});
document.addEventListener('dragover',e=>{
 const target=dropTarget(e);
 if(target&&drag){e.preventDefault();clearDragTargets();target.element.querySelector((target.weekly?'.week-time-cell':'.time-row')+'[data-minute="'+target.minute+'"]')?.classList.add('drag-target');}
});
document.addEventListener('dragend',()=>{drag=null;clearDragTargets();});
document.addEventListener('drop',e=>{
 const target=dropTarget(e);if(!target||!drag)return;e.preventDefault();clearDragTargets();
 const item=drag;drag=null;
 const source=item.type==='task'?state.data.tasks:dragBlocks(state.data,item.source);
 const b=source?.find(b=>b.id===item.id),destination=dragBlocks(state.data,target.container);
 if(!b||!destination){toast('这项安排已变化，请重新拖动');return;}
 const same=item.type==='block'&&sameDragContainer(item.source,target.container);
 if(target.minute+b.duration>DAY_END||collision(destination,target.minute,b.duration,same?b.id:undefined)){toast('时段重叠或超出当天，请换一个位置');return;}
 if(same&&b.start===target.minute)return;
 const moved={...b,id:item.type==='block'&&!same&&destination.some(other=>other.id===b.id)?uid():b.id,start:target.minute};
 commit(d=>{
  const out=dragBlocks(d,target.container,true);
  if(item.type==='task')out.push({id:uid(),taskId:b.id,title:b.title,start:target.minute,duration:b.duration,category:b.category,done:false});
  else if(same)out.find(block=>block.id===item.id).start=target.minute;
  else{
   const origin=dragBlocks(d,item.source,true),index=origin.findIndex(block=>block.id===item.id);
   if(index<0)return;
   origin.splice(index,1);out.push(moved);
  }
 },'已安排到 '+time(target.minute));
 suppressClickUntil=Date.now()+250;
});
let resize=null;
document.addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-resize]');if(!handle)return;e.preventDefault();e.stopPropagation();const b=blocks().find(b=>b.id===handle.dataset.resize);if(!b)return;resize={id:b.id,y:e.clientY,duration:b.duration,start:b.start,element:handle.closest('.event')};resize.element.draggable=false;handle.setPointerCapture(e.pointerId);});
document.addEventListener('pointermove',e=>{if(!resize)return;const n=Math.max(30,Math.min(1440,DAY_END-resize.start,resize.duration+Math.round((e.clientY-resize.y)/26)*30));resize.next=n;resize.element.style.height=(n/30*26-3)+'px';});
document.addEventListener('pointerup',e=>{if(!resize)return;const r=resize;resize=null;r.element.draggable=true;suppressClickUntil=Date.now()+250;const n=r.next||r.duration;if(collision(blocks(),r.start,n,r.id)){toast('延长后会与其他安排重叠');render(true);return;}if(n!==r.duration)commit(d=>targetBlocks(d).find(b=>b.id===r.id).duration=n,'时长已调整');});
document.addEventListener('pointercancel',()=>{if(resize){resize=null;render(true);}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state.ready)refresh();});
window.addEventListener('online',()=>{if(state.ready)refresh();});
window.addEventListener('beforeunload',e=>{if(state.dirty){cache();if(storageFailed){e.preventDefault();e.returnValue='';}}});
const weekdays=['周一','周二','周三','周四','周五','周六','周日'];
const viewHelpers={esc,icon,btn,time,duration};
const categoryMap=()=>Object.fromEntries(state.data.groups.map(g=>[g.id,g.name]));
const groupFor=id=>state.data.groups.find(g=>g.id===id)||state.data.groups[0];
const groupStyle=id=>{const c=groupFor(id).color;return '--event-bg:'+c+'52;--event-accent:'+c+';--event-text:#324139';};
const emptyWeekDay=()=>({templateId:null,templateName:'',blocks:[]});
const freshBlocks=bs=>bs.map(b=>({...b,id:uid(),done:false}));
function daySnapshot(id){const t=state.data.templates.find(t=>t.id===id);return t?{templateId:t.id,templateName:t.name,blocks:freshBlocks(t.blocks)}:emptyWeekDay();}
function allBlockLists(data){return [...data.templates.map(t=>t.blocks),...Object.values(data.days),...data.weekTemplates.flatMap(w=>w.days.map(d=>d.blocks)),...data.cycle.days.map(d=>d.blocks)];}
function renderWeekPage(){
 const editing=state.data.weekTemplates.find(t=>t.id===state.weekTemplateId),monday=mondayOf(state.date);
 let title=editing?esc(editing.name):monday.slice(5).replace('-','月')+'日 — '+addDays(monday,6).slice(5).replace('-','月')+'日';
 let intro='<div class="intro week-intro"><div><p class="eyebrow">'+(editing?'WEEK TEMPLATE / 周模板':'YOUR WEEK, AT A GLANCE / 一周的节奏')+'</p><h1>'+title+'</h1><p>'+(editing?'选择每天的日模板，也可以直接编辑时间块。每次修改自动保存。':'看见时间的去向，也给生活留一些空白。')+'</p></div><div class="intro-actions">'+(editing?btn('week-template-meta',icon('settings')+'名称')+btn('finish-week-edit','完成编辑','primary'):btn('save-week-template',icon('copy')+'存为周模板')+btn('apply-week-template',icon('layers')+'应用周模板','primary'))+'</div></div>';
 intro+='<div class="week-control"><div class="date-controls">'+(editing?'<span class="template-tag">编辑周模板 · 不改已有日期</span>':btn('prev-week',icon('left'),'icon','aria-label="上一周"')+btn('week-today','本周')+btn('next-week',icon('right'),'icon','aria-label="下一周"'))+btn('undo',icon('undo')+' 撤销','ghost',state.undo.length?'':'disabled')+'</div><div class="cycle-summary"><span class="'+(state.data.cycle.enabled?'cycle-on':'')+'">'+(state.data.cycle.enabled?'● 每周循环已开启':'○ 每周循环未开启')+'</span>'+btn('cycle-settings','设置周循环','ghost')+'</div></div>';
 return intro+renderWeekly({data:state.data,date:state.date,editingWeekId:state.weekTemplateId,groupFilter:state.weekFilter},viewHelpers);
}
function groupsModal(){modal('我的任务分组','<p>给分组起个自己的名字，选择一种颜色。已有任务和日程会一起更新显示。</p><div class="group-list">'+state.data.groups.map(g=>'<div class="group-row"><i style="background:'+g.color+'"></i><span>'+esc(g.name)+'</span>'+btn('edit-group','编辑','ghost','data-id="'+g.id+'"')+btn('delete-group','删除','ghost','data-id="'+g.id+'" '+(state.data.groups.length===1?'disabled':''))+'</div>').join('')+'</div><div class="modal-actions">'+btn('new-group','＋ 新建分组','primary')+'</div>');}
function groupForm(id){const g=state.data.groups.find(g=>g.id===id)||{name:'',color:'#638b73'};modal(id?'编辑分组':'新建分组','<form id="group-form" data-id="'+(id||'')+'"><label for="group-name">分组名称</label><input id="group-name" name="name" maxlength="30" required value="'+esc(g.name)+'" placeholder="例如：强化学习、生活、创作"><label for="group-color">分组颜色</label><input id="group-color" name="color" type="color" value="'+g.color+'"><div class="error" id="form-error"></div><div class="modal-actions"><button class="primary">保存分组</button></div></form>');}
function deleteGroupForm(id){if(state.data.groups.length<2)return;const g=groupFor(id);modal('删除分组','<form id="delete-group-form" data-id="'+id+'"><p>「'+esc(g.name)+'」里的任务、日模板、周模板和日程会转入你选择的分组，不会删除任务。</p><label>转入分组</label><select name="target">'+options(Object.fromEntries(state.data.groups.filter(g=>g.id!==id).map(g=>[g.id,g.name])))+'</select><div class="modal-actions"><button class="primary">转移并删除分组</button></div></form>');}
function weekTemplateForm(mode,id){const t=state.data.weekTemplates.find(w=>w.id===(id||state.weekTemplateId));modal(mode==='meta'?'修改周模板':'保存一份周模板','<form id="week-template-form" data-mode="'+mode+'" data-id="'+(t?.id||'')+'"><label>周模板名称</label><input name="name" maxlength="60" required value="'+esc(mode==='meta'?t.name:'')+'" placeholder="例如：工作学习平衡周"><label>描述（可选）</label><input name="description" maxlength="200" value="'+esc(mode==='meta'?t.description:'')+'"><p>'+(mode==='save'?'保存当前所见一周的安排，之后可独立调整并应用到其他周。':'保存后可给周一到周日选择日模板，也可直接添加任务。')+'</p><div class="modal-actions">'+(mode==='meta'?btn('delete-week-template','删除周模板','danger','data-id="'+t.id+'" type="button"'):'')+'<button class="primary">保存周模板</button></div></form>');}
function cycleSelectors(days){return '<div class="cycle-selectors">'+days.map((d,i)=>'<label>'+weekdays[i]+'<select name="day'+i+'">'+options({'':'留白',...(d.blocks.length?{'__keep':'保留：'+(d.templateName||'自定义安排')}:{}),...Object.fromEntries(state.data.templates.map(t=>[t.id,t.name]))},d.blocks.length?'__keep':'')+'</select></label>').join('')+'</div>';}
let cycleDraft=null;
function cycleForm(id){const selected=state.data.weekTemplates.find(w=>w.id===id);cycleDraft=clone(selected?{...state.data.cycle,sourceWeekTemplateId:selected.id,days:selected.days}:state.data.cycle);modal('每周循环 · 7 天为一个周期','<form id="cycle-form"><label class="check-label"><input type="checkbox" name="enabled" '+(selected||state.data.cycle.enabled?'checked':'')+'>启用每周重复</label><div class="form-row"><div><label>开始日期</label><input name="start" type="date" required value="'+(state.data.cycle.enabled?state.data.cycle.startDate:mondayOf(state.date))+'"></div><div><label>结束日期（可留空）</label><input name="end" type="date" value="'+(state.data.cycle.endDate||'')+'"></div></div>'+cycleSelectors(cycleDraft.days)+'<div class="callout">循环会自动出现在对应日期。已手动调整过的日期保持原样；在日视图中可选择「恢复周循环」。修改日模板后，在这里重新选择该模板才会更新循环。</div><div class="error" id="form-error"></div><div class="modal-actions"><button class="primary">保存周循环</button></div></form>');}
function dayRepeatForm(id){const t=state.data.templates.find(t=>t.id===id);modal('每周应用「'+t.name+'」','<form id="day-repeat-form" data-id="'+id+'"><p>选择每周哪些天使用这个日模板。一周为固定循环周期。</p><div class="weekday-checkboxes">'+weekdays.map((label,i)=>'<label class="check-label"><input type="checkbox" name="weekday" value="'+i+'" '+(state.data.cycle.days[i].templateId===id?'checked':'')+'>'+label+'</label>').join('')+'</div><label>从哪天开始</label><input name="start" type="date" required value="'+(state.data.cycle.enabled?state.data.cycle.startDate:mondayOf(state.date))+'"><div class="callout">选中的星期会改用这个模板；其他星期保留当前设置。已手动调整的具体日期不会被覆盖。</div><div class="error" id="form-error"></div><div class="modal-actions"><button class="primary">保存并启用周循环</button></div></form>');}
function weekApplyForm(id){if(!state.data.weekTemplates.length){weekTemplateForm('new');return;}modal('应用周模板','<form id="week-apply-form"><label>选择周模板</label><select name="template">'+options(Object.fromEntries(state.data.weekTemplates.map(w=>[w.id,w.name])),id||state.data.weekTemplates[0].id)+'</select><div class="form-row"><div><label>从哪一周开始（自动取周一）</label><input name="date" type="date" required value="'+mondayOf(state.date)+'"></div><div><label>应用周数</label><select name="weeks">'+options({1:'1 周',2:'2 周',4:'4 周',8:'8 周'},1)+'</select></div></div><label>遇到已有安排</label><select name="mode"><option value="merge">保留已有安排，跳过重叠</option><option value="replace">替换选定的整周（可撤销）</option></select><div class="callout" id="week-apply-preview"></div><p>此操作应用到具体日期。如果希望每周一直重复，请使用「设置周循环」。</p><div class="modal-actions"><button class="primary">应用周模板</button></div></form>');previewWeekApply();}
function proposeWeekApply(form){const f=new FormData(form),w=state.data.weekTemplates.find(w=>w.id===f.get('template')),start=mondayOf(String(f.get('date'))),weeks=+f.get('weeks'),replace=f.get('mode')==='replace';let added=0,skipped=0,results=[];for(let n=0;n<weeks*7;n++){const date=addDays(start,n),day=w.days[n%7],out=replace?[]:clone(resolveDay(state.data,date).blocks);for(const b of day.blocks){const task=state.data.tasks.find(t=>t.id===b.taskId);if(task?.done&&!task.reusable||collision(out,b.start,b.duration)){skipped++;continue;}out.push({...b,id:uid(),done:false});added++;}results.push({date,blocks:out,meta:{templateId:day.templateId,templateName:day.templateName,weekTemplateId:w.id}});}return {results,added,skipped,start};}
function previewWeekApply(){if(!$('#week-apply-form'))return;try{const p=proposeWeekApply($('#week-apply-form'));$('#week-apply-preview').textContent='将安排 '+p.results.length+' 天，添加 '+p.added+' 项，跳过 '+p.skipped+' 项重叠或已完成任务。';}catch{}}
let assignmentDraft=null;
function assignDayForm(el){const index=+el.dataset.weekday;assignmentDraft={id:el.value,date:el.dataset.date,index,editing:!!state.weekTemplateId};const old=assignmentDraft.editing?state.data.weekTemplates.find(w=>w.id===state.weekTemplateId).days[index].blocks:resolveDay(state.data,assignmentDraft.date).blocks;const t=state.data.templates.find(t=>t.id===el.value);modal(t?'安排「'+t.name+'」':'留白这一天','<form id="assign-day-form"><p>'+ (assignmentDraft.editing?weekdays[index]:assignmentDraft.date)+' 当前有 '+old.length+' 项安排。</p><label>如何应用</label><select name="mode"><option value="merge">保留已有安排，跳过重叠</option><option value="replace">替换这一天（可撤销）</option></select>'+(!t?'<p>选择「替换」才会清空这一天。</p>':'')+'<div class="modal-actions"><button class="primary">确认应用</button></div></form>');}
function weekdayCaption(t){const indexes=state.data.cycle.days.map((d,i)=>d.templateId===t.id?i:-1).filter(i=>i>=0);return indexes.length?'每周 '+indexes.map(i=>'一二三四五六日'[i]).join('、'):'尚未设置每周应用';}
function handleV2Action(a,id,el){
 if(a==='groups')groupsModal();
 else if(a==='new-group')groupForm();
 else if(a==='edit-group')groupForm(id);
 else if(a==='delete-group')deleteGroupForm(id);
 else if(a==='week-group-filter'){state.weekFilter=id;render(true);}
 else if(a==='prev-week'||a==='next-week'){state.date=addDays(state.date,a==='prev-week'?-7:7);render();}
 else if(a==='week-today'){state.date=dayKey();render();}
 else if(a==='template-kind'){state.templateKind=id;render();}
 else if(a==='new-week-template')weekTemplateForm('new');
 else if(a==='save-week-template')weekTemplateForm('save');
 else if(a==='week-template-meta')weekTemplateForm('meta');
 else if(a==='edit-week-template'){state.weekTemplateId=id;state.templateId=null;state.tab='templates';render();}
 else if(a==='finish-week-edit'){state.weekTemplateId=null;state.templateKind='week';render();}
 else if(a==='copy-week-template'){commit(d=>{const w=clone(d.weekTemplates.find(w=>w.id===id));w.id=uid();w.name=w.name.slice(0,54)+' · 副本';w.days.forEach(day=>day.blocks=freshBlocks(day.blocks));d.weekTemplates.push(w);},'周模板已复制');}
 else if(a==='delete-week-template'){commit(d=>{d.weekTemplates=d.weekTemplates.filter(w=>w.id!==id);if(d.cycle.sourceWeekTemplateId===id)d.cycle.sourceWeekTemplateId=null;state.weekTemplateId=null;},'周模板已删除，已启用的循环保留');close();}
 else if(a==='apply-week-template')weekApplyForm(id);
 else if(a==='activate-cycle'||a==='cycle-settings')cycleForm(id);
 else if(a==='repeat-template')dayRepeatForm(id||state.templateId);
 else if(a==='new-week-block'||a==='edit-week-block'){state.editDate=el.dataset.date;state.editWeekday=Number(el.dataset.weekday);blockForm({id:a==='edit-week-block'?id:undefined,start:el.dataset.minute===undefined?540:+el.dataset.minute});}
 else if(a==='open-day'){state.date=el.dataset.date;state.tab='day';state.weekTemplateId=null;render();}
 else if(a==='restore-cycle'){modal('恢复这一天的周循环','<p>这会移除当天的手动调整，重新显示当前周循环安排。可撤销。</p><div class="modal-actions">'+btn('confirm-restore-cycle','恢复周循环','primary')+'</div>');}
 else if(a==='confirm-restore-cycle'){commit(d=>{delete d.days[state.date];delete d.dayMeta[state.date];},'已恢复周循环');close();}
 else if(a==='ics-week'||a==='ics-4weeks'){try{calendarExport(a==='ics-week'?'week':'four');}catch(e){toast(e.message);}}
 else if(a==='windows-calendar'){modal('Windows / Outlook 日历（可选）','<p>先导出本周或未来 4 周，再到 Outlook 网页版「日历 → 添加日历 → 从文件上传」导入。Windows Outlook 登录同一账户即可查看。</p>'+btn('ics-week','导出本周（包含日期例外）','export-option')+btn('ics-4weeks','导出未来 4 周','export-option')+'<div class="callout" style="margin-top:15px">当前是手动导入，不是自动同步。修改周谱后需要重新导出；建议使用单独的「周谱」日历，避免重复导入造成重复日程。旧版 Windows 日历已停止支持。</div><p><a href="https://outlook.live.com/calendar/" target="_blank" rel="noopener noreferrer">打开 Outlook 日历 ↗</a></p>');}
 else return false;return true;
}
function handleV2Submit(form){
 const f=new FormData(form),id=form.dataset.id;
 if(form.id==='group-form'){const name=String(f.get('name')).trim(),color=String(f.get('color'));if(!name)return true;if(state.data.groups.some(g=>g.id!==id&&g.name.toLowerCase()===name.toLowerCase())){$('#form-error').textContent='已有同名分组，换一个名字吧。';return true;}commit(d=>{const old=d.groups.find(g=>g.id===id);if(old)Object.assign(old,{name,color});else d.groups.push({id:uid(),name,color});},'分组已保存');close();}
 else if(form.id==='delete-group-form'){const target=String(f.get('target'));commit(d=>{d.groups=d.groups.filter(g=>g.id!==id);for(const t of d.tasks)if(t.category===id)t.category=target;for(const bs of allBlockLists(d))for(const b of bs)if(b.category===id)b.category=target;state.filter='all';state.weekFilter='all';},'已转移任务并删除分组');close();}
 else if(form.id==='week-template-form'){const mode=form.dataset.mode,name=String(f.get('name')).trim();if(!name)return true;commit(d=>{if(mode==='meta')Object.assign(d.weekTemplates.find(w=>w.id===id),{name,description:String(f.get('description'))});else{const wid=uid();d.weekTemplates.push({id:wid,name,description:String(f.get('description')),days:mode==='save'?snapshotWeek(d,mondayOf(state.date)).map(day=>({...day,blocks:freshBlocks(day.blocks)})):Array.from({length:7},emptyWeekDay)});state.weekTemplateId=wid;state.templateId=null;state.tab='templates';}},'周模板已保存');close();}
 else if(form.id==='cycle-form'){const start=String(f.get('start')),end=String(f.get('end'))||null;if(end&&end<start){$('#form-error').textContent='结束日期不能早于开始日期。';return true;}commit(d=>{d.cycle={...clone(cycleDraft),enabled:f.get('enabled')==='on',startDate:start,endDate:end,days:cycleDraft.days.map((day,i)=>f.get('day'+i)==='__keep'?clone(day):daySnapshot(String(f.get('day'+i))))};},'周循环已保存，日期例外已保留');close();}
 else if(form.id==='day-repeat-form'){const selected=f.getAll('weekday').map(Number),start=String(f.get('start'));commit(d=>{d.cycle.enabled=true;d.cycle.startDate=start;d.cycle.endDate=null;d.cycle.sourceWeekTemplateId=null;d.cycle.days=d.cycle.days.map((day,i)=>selected.includes(i)?daySnapshot(id):day.templateId===id?emptyWeekDay():day);},'每周应用日已保存');close();}
 else if(form.id==='week-apply-form'){const p=proposeWeekApply(form);commit(d=>{for(const r of p.results){d.days[r.date]=r.blocks;d.dayMeta[r.date]=r.meta;}state.date=p.start;state.weekTemplateId=null;state.templateId=null;state.tab='week';},'已应用 '+p.results.length+' 天，跳过 '+p.skipped+' 项');close();}
 else if(form.id==='assign-day-form'){const p=assignmentDraft,day=daySnapshot(p.id),replace=f.get('mode')==='replace';const existing=p.editing?state.data.weekTemplates.find(w=>w.id===state.weekTemplateId).days[p.index].blocks:resolveDay(state.data,p.date).blocks;let out=replace?[]:clone(existing);for(const b of day.blocks)if(!collision(out,b.start,b.duration))out.push(b);commit(d=>{if(p.editing)d.weekTemplates.find(w=>w.id===state.weekTemplateId).days[p.index]={...day,blocks:out};else{d.days[p.date]=out;d.dayMeta[p.date]={templateId:day.templateId,templateName:day.templateName};}},'这一天的安排已更新');close();}
 else return false;return true;
}

document.addEventListener('close',e=>{if(e.target.id==='modal'){state.editDate=null;state.editWeekday=null;}},true);
boot();
