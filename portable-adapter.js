// Adapter for the separately labeled local-only preview.
const fetch = async (path,options={}) => {
  const key='dayloom-portable-db';
  if(path==='/api/session')return Response.json({userId:'portable-preview'});
  if(path==='/api/planner'){
    let row=JSON.parse(localStorage.getItem(key)||'null');
    if(options.method!=='PUT')return Response.json(row?{data:row.data,revision:row.revision}:{data:null,revision:0});
    const body=JSON.parse(options.body);
    if(!validateData(body.data))return Response.json({error:'数据格式不正确'},{status:400});
    if(row?.mutationId===body.mutationId)return Response.json({revision:row.revision});
    if((row?.revision||0)!==body.baseRevision)return Response.json({error:'另一窗口已修改数据'},{status:409});
    row={data:body.data,revision:(row?.revision||0)+1,mutationId:body.mutationId};
    localStorage.setItem(key,JSON.stringify(row));return Response.json({revision:row.revision});
  }
  return Response.json({error:'本机预览没有连接网络服务'},{status:503});
};
