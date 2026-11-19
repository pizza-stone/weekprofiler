// The build injects model, API, and self-hosted static files above this handler.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userId = request.headers.get('oai-authenticated-user-id');
    if (url.pathname.startsWith('/api/')) {
      if (!userId) return Response.json({error:'请先登录'}, {status:401,headers:{'Cache-Control':'no-store'}});
      if (url.pathname === '/api/session') return Response.json({userId}, {headers:{'Cache-Control':'no-store'}});
      if (url.pathname === '/api/planner') return handlePlanner(request,env,userId);
      if (url.pathname === '/api/ai/status') return Response.json({configured:false,provider:'codex',message:'Codex 订阅接入需要电脑上的本机服务。请运行 start-weekprofiler.cmd 后在本机网址使用。'}, {headers:{'Cache-Control':'no-store'}});
      return new Response('Not found',{status:404});
    }
    if (url.pathname === '/' && !userId) return Response.redirect(new URL('/signin-with-chatgpt?return_to=/',url).href,302);
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const asset = STATIC_FILES[url.pathname];
    if (!asset) return new Response('Not found',{status:404});
    const body=request.method==='HEAD'?null:asset.base64?Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)):asset.body;
    return new Response(body,{headers:{
      'Content-Type':asset.type,
      'Cache-Control':'private, no-cache',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    }});
  }
};
