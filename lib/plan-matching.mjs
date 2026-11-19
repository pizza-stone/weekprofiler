const planMatchKey=card=>card.planDate&&card.blockId?JSON.stringify([card.planDate,card.blockId]):null;
const planMatchFamily=card=>card.planDate&&card.category&&(card.taskId||card.title?.trim())
  ?JSON.stringify([card.planDate,card.category,card.taskId?'task':'title',card.taskId||card.title.trim()]):null;
const planMatchOrder=(a,b)=>a.startAt-b.startAt||String(a.recordId||a.blockId).localeCompare(String(b.recordId||b.blockId));
const planMatchSegmentStart=card=>Number.isFinite(card.segmentStart)?card.segmentStart:card.startAt;

function nearestPlanMatchPairs(plans,actuals) {
  plans=[...plans].sort(planMatchOrder);actuals=[...actuals].sort(planMatchOrder);
  const width=actuals.length+1,steps=new Uint8Array((plans.length+1)*width);
  let previousCount=new Uint16Array(width),previousCost=new Float64Array(width),previousReference=new Uint16Array(width);
  const better=(count,cost,reference,bestCount,bestCost,bestReference)=>count>bestCount||count===bestCount&&(cost<bestCost||cost===bestCost&&reference>bestReference);
  for(let i=1;i<=plans.length;i++){
    const counts=new Uint16Array(width),costs=new Float64Array(width),references=new Uint16Array(width);
    for(let j=1;j<width;j++){
      let count=previousCount[j],cost=previousCost[j],reference=previousReference[j],step=1;
      if(!better(count,cost,reference,counts[j-1],costs[j-1],references[j-1])){count=counts[j-1];cost=costs[j-1];reference=references[j-1];step=2;}
      const matchedCount=previousCount[j-1]+1,matchedCost=previousCost[j-1]+Math.abs(plans[i-1].startAt-actuals[j-1].startAt);
      const matchedReference=previousReference[j-1]+Number(plans[i-1].blockId===actuals[j-1].blockId);
      if(better(matchedCount,matchedCost,matchedReference,count,cost,reference)){count=matchedCount;cost=matchedCost;reference=matchedReference;step=3;}
      counts[j]=count;costs[j]=cost;references[j]=reference;steps[i*width+j]=step;
    }
    previousCount=counts;previousCost=costs;previousReference=references;
  }
  const pairs=[];let i=plans.length,j=actuals.length;
  while(i&&j){const step=steps[i*width+j];if(step===3)pairs.push([plans[--i],actuals[--j]]);else if(step===2)j--;else i--;}
  return pairs.reverse();
}

/** Match each displayed plan at most once; explicit ownership wins over legacy nearest matching. */
export function pairPlanLinks(cards) {
  const buckets=new Map(),plans=new Map(),records=new Map(),reasons=new Map(),paired=new Set(),reserved=new Set(),groups=[];
  const bucket=key=>{if(!buckets.has(key))buckets.set(key,{plans:[],actuals:[]});return buckets.get(key);};
  for(const card of cards){
    if(card.role!=='plan')continue;
    const key=planMatchKey(card),family=planMatchFamily(card);
    if(key&&family&&Number.isFinite(card.startAt)&&!plans.has(key)){bucket(family).plans.push(card);plans.set(key,card);}
  }
  for(const card of cards){
    if(card.role!=='actual')continue;
    if(card.unplanned){reasons.set(card,'unplanned');continue;}
    if(card.hasOrigin===false||!planMatchFamily(card)||!Number.isFinite(card.startAt)){reasons.set(card,'unmatched');continue;}
    const recordKey=card.recordId||JSON.stringify([card.planDate,card.blockId,card.startAt]),old=records.get(recordKey);
    if(!old)records.set(recordKey,card);
    else if(planMatchSegmentStart(card)<planMatchSegmentStart(old)){reasons.set(old,'continuation');records.set(recordKey,card);}
    else reasons.set(card,'continuation');
  }
  const explicit=new Map();
  for(const card of records.values()){
    if(card.binding!=='explicit'){bucket(planMatchFamily(card)).actuals.push(card);continue;}
    const key=planMatchKey(card);
    if(!plans.has(key)){reasons.set(card,'unmatched');continue;}
    if(!explicit.has(key))explicit.set(key,[]);explicit.get(key).push(card);
  }
  for(const [key,actuals] of explicit){
    const plan=plans.get(key),ordered=[...actuals].sort((a,b)=>Math.abs(a.startAt-plan.startAt)-Math.abs(b.startAt-plan.startAt)||planMatchOrder(a,b));
    const actual=ordered[0];paired.add(actual);reserved.add(key);groups.push({key,plan,actuals:[actual]});
    for(const extra of ordered.slice(1))reasons.set(extra,'additional');
  }
  for(const {plans,actuals} of buckets.values())for(const [plan,actual] of nearestPlanMatchPairs(plans.filter(plan=>!reserved.has(planMatchKey(plan))),actuals)){
    paired.add(actual);groups.push({key:planMatchKey(plan),plan,actuals:[actual]});
  }
  groups.sort((a,b)=>planMatchOrder(a.plan,b.plan));
  const unmatched=cards.filter(card=>card.role==='actual'&&!paired.has(card)).map(card=>({card,reason:reasons.get(card)||'unmatched'}));
  return {groups:groups.map((group,index)=>({...group,label:String(index+1)})),unmatched};
}
