import {pairPlanLinks} from '../lib/plan-matching.mjs';
export {pairPlanLinks};
const planLinkNamespace='http://www.w3.org/2000/svg';
const planLinkBoards=new WeakMap(),planLinkInstalls=new WeakMap(),planLinkAnnotations=new WeakMap();
export function planLinkPath(start,end) {
  const number=value=>Number(value.toFixed(2));
  const reach=Math.min(80,Math.max(4,Math.abs(end.x-start.x)*.35));
  return 'M '+number(start.x)+' '+number(start.y)+' C '+number(start.x+reach)+' '+number(start.y)+', '+number(end.x-reach)+' '+number(end.y)+', '+number(end.x)+' '+number(end.y);
}

function planLinkContainers(root) {
  return [...(root.matches?.('[data-plan-links]')?[root]:[]),...root.querySelectorAll('[data-plan-links]')];
}
function planLinkNode(document,name,attributes) {
  const node=document.createElementNS(planLinkNamespace,name);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  return node;
}
function annotatePlanLink(card,description,label,state) {
  let saved=planLinkAnnotations.get(card);
  const current=card.getAttribute('title');
  if(!saved||current!==saved.annotated)saved={original:current};
  saved.annotated=(saved.original?saved.original+'\n':'')+description;
  card.setAttribute('title',saved.annotated);card.setAttribute('data-link-label',label);card.setAttribute('data-link-state',state);
  planLinkAnnotations.set(card,saved);
}
function clearPlanLinkAnnotation(card) {
  const saved=planLinkAnnotations.get(card);
  if(saved&&card.getAttribute('title')===saved.annotated){
    if(saved.original===null)card.removeAttribute('title');else card.setAttribute('title',saved.original);
  }
  planLinkAnnotations.delete(card);card.removeAttribute('data-link-label');card.removeAttribute('data-link-state');card.classList.remove('plan-link-active');
}
function emphasizePlanLink(board,key) {
  if(board.activeKey===key)return;
  board.activeKey=key;
  for(const [card,cardKey] of board.cardKeys)card.classList.toggle('plan-link-active',cardKey===key);
  for(const [path,pathKey] of board.pathKeys)path.classList.toggle('is-active',pathKey===key);
}
function planLinkCard(element,root) {
  const card=element?.closest?.('[data-link-role]');
  return card&&root.contains(card)?card:null;
}

/** Call after rendering plans or actual cards; geometry is local to the shared scroll canvas. */
export function refreshPlanLinks(root=document) {
  for(const container of planLinkContainers(root)){
    const previous=planLinkBoards.get(container);
    previous?.layer.remove();
    for(const card of previous?.cards||[])clearPlanLinkAnnotation(card);
    const cards=[...container.querySelectorAll('[data-link-role]')].filter(card=>card.closest('[data-plan-links]')===container);
    const readNumber=value=>value===undefined||value===''?NaN:Number(value);
    const records=cards.map(element=>({element,role:element.dataset.linkRole,planDate:element.dataset.planDate,blockId:element.dataset.linkOwner||element.dataset.planBlock,
      binding:element.dataset.linkOwner!==undefined?'explicit':undefined,
      taskId:element.dataset.linkTask,title:element.dataset.linkTitle,category:element.dataset.linkCategory,
      startAt:readNumber(element.dataset.linkInstant),recordId:element.dataset.linkRecord,segmentStart:readNumber(element.dataset.linkSegment),
      hasOrigin:element.dataset.linkOrigin!=='false'&&(element.dataset.linkOwner===undefined||!!element.dataset.linkOwner),unplanned:element.dataset.unplanned==='true'}));
    const {groups,unmatched}=pairPlanLinks(records),bounds=container.getBoundingClientRect();
    const document=container.ownerDocument;
    const layer=planLinkNode(document,'svg',{'class':'plan-links-layer','aria-hidden':'true','focusable':'false',viewBox:'0 0 '+Math.max(1,bounds.width)+' '+Math.max(1,bounds.height),preserveAspectRatio:'none'});
    const board={container,layer,cards,cardKeys:new Map(),pathKeys:new Map(),activeKey:null};
    planLinkBoards.set(container,board);
    for(const group of groups){
      const plan=group.plan.element,from=plan.getBoundingClientRect();
      board.cardKeys.set(plan,group.key);
      annotatePlanLink(plan,'就近对照 '+group.label+' · 一对一匹配执行记录',group.label,'matched');
      for(const actual of group.actuals){
        const card=actual.element,to=card.getBoundingClientRect();
        board.cardKeys.set(card,group.key);
        annotatePlanLink(card,'就近对照 '+group.label+' · 计划日期 '+group.plan.planDate,group.label,'matched');
        if(!bounds.width||!bounds.height||!from.width||!to.width)continue;
        const path=planLinkNode(document,'path',{'class':'plan-link-path',d:planLinkPath({x:from.right-bounds.left,y:from.top+from.height/2-bounds.top},{x:to.left-bounds.left,y:to.top+to.height/2-bounds.top}),'vector-effect':'non-scaling-stroke'});
        layer.append(path);board.pathKeys.set(path,group.key);
      }
    }
    for(const {card,reason} of unmatched)annotatePlanLink(card.element,reason==='unplanned'?'临时任务 · 无计划时段':reason==='continuation'?'同一执行记录的分段 · 连线只使用一个片段':reason==='additional'?'同一计划的其他执行片段 · 用时已累计，连线仅显示最近一条':'未参与连线 · 当前没有对应的可见计划',reason==='unplanned'?'临时':'未连线',reason);
    container.append(layer);
    const active=cards.find(card=>card.contains(document.activeElement))||cards.find(card=>card.matches?.(':hover'));
    if(active)emphasizePlanLink(board,board.cardKeys.get(active)||null);
  }
}

/** Install once. Existing click, drag, timer and keyboard actions remain untouched. */
export function installPlanLinks(root=document) {
  if(planLinkInstalls.has(root))return planLinkInstalls.get(root);
  const document=root.ownerDocument||root,view=document.defaultView||globalThis;
  let hovered=null,frame=null,disposed=false;
  const highlight=()=>{
    const focused=planLinkCard(document.activeElement,root),target=hovered&&root.contains(hovered)?hovered:focused;
    for(const container of planLinkContainers(root)){
      const board=planLinkBoards.get(container);if(board)emphasizePlanLink(board,board.cardKeys.get(target)||null);
    }
  };
  const over=event=>{hovered=planLinkCard(event.target,root);highlight();};
  const out=event=>{hovered=planLinkCard(event.relatedTarget,root);highlight();};
  const focus=event=>{
    const target=planLinkCard(event.target,root);
    for(const container of planLinkContainers(root)){
      const board=planLinkBoards.get(container);if(board)emphasizePlanLink(board,board.cardKeys.get(target)||null);
    }
  };
  const blur=event=>{
    // activeElement is still the old card during focusout in some browsers.
    const next=planLinkCard(event.relatedTarget,root);
    for(const container of planLinkContainers(root)){
      const board=planLinkBoards.get(container);if(board)emphasizePlanLink(board,board.cardKeys.get(hovered||next)||null);
    }
  };
  const resize=()=>{
    if(frame!==null)return;
    frame=view.requestAnimationFrame(()=>{frame=null;if(!disposed)refreshPlanLinks(root);});
  };
  root.addEventListener('pointerover',over);root.addEventListener('pointerout',out);
  root.addEventListener('focusin',focus);root.addEventListener('focusout',blur);view.addEventListener('resize',resize);
  const dispose=()=>{
    disposed=true;if(frame!==null)view.cancelAnimationFrame(frame);
    root.removeEventListener('pointerover',over);root.removeEventListener('pointerout',out);
    root.removeEventListener('focusin',focus);root.removeEventListener('focusout',blur);view.removeEventListener('resize',resize);
    for(const container of planLinkContainers(root)){
      const board=planLinkBoards.get(container);board?.layer.remove();for(const card of board?.cards||[])clearPlanLinkAnnotation(card);planLinkBoards.delete(container);
    }
    planLinkInstalls.delete(root);
  };
  planLinkInstalls.set(root,dispose);refreshPlanLinks(root);return dispose;
}
