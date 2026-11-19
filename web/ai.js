import { resolveDay, materializeDay, mondayOf, addDays, validateData } from '/model.js';
import { validateAIContext, validateAIProposal } from '/ai-model.js';

// These functions also run in unit tests; confirmation always uses current data.
export function aiContextFor(data,startDate,scope='day',group='all') {
  const start=scope==='week'?mondayOf(startDate):startDate;
  const days=Array.from({length:scope==='week'?7:1},(_,i)=>{const date=addDays(start,i);return {date,blocks:resolveDay(data,date).blocks};});
  const scheduled=new Set(days.flatMap(day=>day.blocks.map(b=>b.taskId).filter(Boolean)));
  const tasks=data.tasks.filter(t=>(group==='all'||t.category===group)&&(t.reusable||!t.done&&!scheduled.has(t.id)));
  return {tasks,groups:data.groups,timezone:data.timezone,days,startDate:start,endDate:days.at(-1).date};
}
export function aiApplyCandidate(data,proposal,context,uid) {
  if(!validateAIProposal(proposal,context))throw Error('日程或任务已变化，方案存在冲突。请重新生成后再应用。');
  const next=JSON.parse(JSON.stringify(data));
  for(const item of proposal.assignments){
    const task=next.tasks.find(t=>t.id===item.taskId);
    if(!task)throw Error('任务已删除，请重新生成方案。');
    materializeDay(next,item.date).push({id:uid(),taskId:task.id,title:task.title,category:task.category,start:item.start,duration:item.duration,done:false});
  }
  if(!validateData(next))throw Error('方案超出日程容量或存在无效安排，未作修改。');
  return next;
}

export function createAIPlanner(h) {
  const {getData,getDate,getScope,getGroup,commit,modal,toast,time,esc,uid}=h;
  let active=false,busy=false,status=null,thread=[],proposal=null,error='',draft='',controller=null;
  let scope='day',date='',group='all',baseline='',requestId=0;
  const query=s=>document.querySelector(s);
  const context=()=>aiContextFor(getData(),date,scope,group);
  const contextHash=c=>JSON.stringify(c);
  const formState=()=>{if(query('#ai-prompt'))draft=query('#ai-prompt').value;};
  const opt=(v,label,current)=>'<option value="'+esc(v)+'" '+(v===current?'selected':'')+'>'+esc(label)+'</option>';
  function setupNote(){
    if(location.protocol==='file:')return '<strong>用 Codex 订阅连接 AI</strong><p>解压后运行 <code>start-weekprofiler.cmd</code>，在它提供的本机网址打开周谱。首次先安装 Codex CLI，运行 <code>codex login</code> 并选择 ChatGPT 登录。</p><p>当前直接打开的 HTML 仍可正常排程。切换本机网址前，请先导出 JSON 备份，在新页面导入。</p>';
    if(status?.configured)return '<strong>已连接 Codex · ChatGPT 订阅</strong><p>只在发送时调用。草案经你确认才写入日程，不会切换到付费 API。</p>';
    return '<strong>尚未连接 Codex</strong><p>'+esc(status?.message||'请在电脑上安装 Codex CLI，并运行 codex login，使用 ChatGPT 账号登录。')+'</p><p>连接成功后点击「检查连接」。不会要求 API Key。</p>';
  }
  function render(){
    if(!active)return;
    const c=context(),data=getData(),ready=!!status?.configured&&location.protocol!=='file:';
    const controls='<div class="ai-controls"><label>安排范围<select id="ai-scope" '+(busy?'disabled':'')+'>'+opt('day','选定的一天',scope)+opt('week','选定日期所在周',scope)+'</select></label><label>日期<input id="ai-date" type="date" value="'+date+'" '+(busy?'disabled':'')+'></label><label>任务分组<select id="ai-group" '+(busy?'disabled':'')+'>'+opt('all','全部分组',group)+data.groups.map(g=>opt(g.id,g.name,group)).join('')+'</select></label></div>';
    const conversation=thread.map(m=>'<div class="ai-message '+m.role+'"><span>'+ (m.role==='user'?'你':'Codex')+'</span><p>'+esc(m.content)+'</p></div>').join('');
    const p=proposal;
    const preview=p?'<section class="ai-proposal"><div class="panel-title"><h3>安排草案 · '+p.assignments.length+' 项</h3><small>尚未应用</small></div>'+(p.explanation?'<p>'+esc(p.explanation)+'</p>':'')+(p.assignments.length?'<div class="ai-table-scroll"><table><thead><tr><th>排程日</th><th>时间</th><th>任务</th></tr></thead><tbody>'+p.assignments.map(a=>{const t=c.tasks.find(t=>t.id===a.taskId);return '<tr><td>'+esc(a.date)+'</td><td>'+time(a.start)+' – '+time(a.start+a.duration)+'</td><td>'+esc(t?.title||'任务已变化')+'</td></tr>';}).join('')+'</tbody></table></div>':'')+(p.unscheduledTaskIds.length?'<p class="ai-muted">未安排：'+p.unscheduledTaskIds.map(id=>esc(c.tasks.find(t=>t.id===id)?.title||'已变化任务')).join('、')+'</p>':'')+'<div class="modal-actions"><button type="button" data-ai="discard">舍弃草案</button><button type="button" data-ai="apply" class="primary" '+(!p.assignments.length||busy?'disabled':'')+'>确认应用 '+p.assignments.length+' 项</button></div></section>':'';
    modal('✦ 和 Codex 一起安排时间','<div class="ai-panel"><div class="ai-connection '+(ready?'ready':'')+'">'+setupNote()+'<button type="button" data-ai="status" '+(busy?'disabled':'')+'>检查连接</button></div>'+controls+'<p class="ai-context">'+c.startDate+(c.endDate!==c.startDate?' — '+c.endDate:'')+' · '+c.tasks.length+' 项待安排任务 · 每天 04:00 至次日 04:00</p><div class="ai-thread">'+(conversation||'<div class="ai-empty">告诉我这一周想怎么过。<small>例如：把学习安排在下午，每天最多两小时，周末留一天休息。</small></div>')+'</div>'+preview+(error?'<p class="error" role="alert">'+esc(error)+'</p>':'')+'<form id="ai-chat-form"><label for="ai-prompt">你的想法</label><textarea id="ai-prompt" maxlength="2000" rows="3" placeholder="把已有任务安排到本周的空闲时间……" '+(busy?'disabled':'')+'>'+esc(draft)+'</textarea><p class="ai-muted">发送所选分组的任务、所选日期范围内的已有安排和本次对话；其他日期不发送。保留已有安排，只填空闲。</p><div class="modal-actions">'+(busy?'<button type="button" data-ai="cancel">停止生成</button>':'<button type="button" data-ai="reset">新对话</button>')+'<button class="primary" '+(busy||!ready?'disabled':'')+'>'+(busy?'正在整理…':'发送给 Codex')+'</button></div></form></div>');
    query('#modal').classList.add('ai-dialog');
    if(!busy)query('#ai-prompt')?.focus();
  }
  async function checkStatus(){
    if(location.protocol==='file:'){status={configured:false};render();return;}
    const token=++requestId;
    try{const r=await globalThis.fetch('/api/ai/status',{cache:'no-store'});const s=await r.json();if(active&&token===requestId)status=r.ok?s:{configured:false,message:s.error||'连接不可用'};}
    catch{if(active&&token===requestId)status={configured:false,message:'无法连接本机服务，请保持 start-weekprofiler.cmd 窗口运行。'};}
    if(active&&token===requestId){formState();render();}
  }
  async function send(){
    if(busy||!status?.configured)return;formState();const text=draft.trim();if(!text)return;
    const c=context();
    if(!c.tasks.length){error='这个范围没有可安排的任务。请先添加任务，或选择其他分组。';render();return;}
    if(c.tasks.length>100){error='一次最多整理 100 个任务，请选择更小的分组。';render();return;}
    let messages=[...thread,{role:'user',content:text}].slice(-11);
    while(messages.reduce((n,m)=>n+m.content.length,0)>10000)messages.shift();
    if(messages[0]?.role==='assistant')messages.shift();
    const body={messages,context:c};
    if(!validateAIContext(body)){error='本次任务或对话内容超出限制，请缩小范围或开始新对话。';render();return;}
    thread=messages;draft='';proposal=null;error='';baseline=contextHash(c);busy=true;controller=new AbortController();const token=++requestId;render();
    try{
      const r=await globalThis.fetch('/api/ai/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      const result=await r.json();if(!active||token!==requestId)return;
      if(!r.ok)throw Error(result.error||'Codex 暂时未能完成，请稍后重试。');
      if(!validateAIProposal(result.proposal,c))throw Error('返回方案未通过日期、任务和冲突检查，未修改日程。');
      proposal=result.proposal;thread.push({role:'assistant',content:proposal.reply});
    }catch(e){if(active&&token===requestId)error=e.name==='AbortError'?'已停止生成，日程未修改。':e.message;}
    finally{if(active&&token===requestId){busy=false;controller=null;render();}}
  }
  function apply(){
    if(!proposal||busy)return;
    try{
      const c=context();if(contextHash(c)!==baseline)throw Error('任务或日程在生成后发生了变化，请重新生成方案。');
      const next=aiApplyCandidate(getData(),proposal,c,uid),count=proposal.assignments.length;
      const ok=commit(d=>Object.assign(d,next),'已应用 '+count+' 项 AI 安排，可撤销');
      if(ok){proposal=null;baseline='';thread.push({role:'assistant',content:'已确认应用 '+count+' 项安排。可以继续告诉我后续想法。'});error='';render();}
    }catch(e){error=e.message;render();}
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest('[data-ai]');if(!button||!active)return;e.preventDefault();formState();
    const action=button.dataset.ai;
    if(action==='status')checkStatus();
    else if(action==='apply')apply();
    else if(action==='cancel'){controller?.abort();}
    else if(action==='discard'){proposal=null;error='';render();}
    else if(action==='reset'&&!busy){thread=[];proposal=null;error='';draft='';render();}
  });
  document.addEventListener('submit',e=>{if(e.target.id==='ai-chat-form'){e.preventDefault();send();}});
  document.addEventListener('change',e=>{if(!active||busy)return;const id=e.target.id;if(!['ai-scope','ai-date','ai-group'].includes(id))return;formState();if(id==='ai-scope')scope=e.target.value;else if(id==='ai-date'){if(!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value))return;date=e.target.value;}else group=e.target.value;thread=[];proposal=null;error='';render();});
  document.addEventListener('close',e=>{if(e.target.id==='modal'){active=false;requestId++;controller?.abort();controller=null;busy=false;e.target.classList.remove('ai-dialog');}},true);
  return {open(){scope=getScope();date=getDate();group=getGroup();thread=[];proposal=null;error='';draft='';active=true;render();checkStatus();}};
}
