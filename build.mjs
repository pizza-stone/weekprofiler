import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const licenseHeader='/*!\n'+read('LICENSE').trimEnd()+'\n*/\n';
const icon=read('web/brand/weekmark.svg');
const launcherIcons=[180,192,512].map(size=>`weekmark-${size}.png`);
const files={
 '/':{body:read('web/index.html'),type:'text/html; charset=utf-8'},
 '/app.js':{body:read('web/app.js'),type:'application/javascript; charset=utf-8'},
 '/week.js':{body:read('web/week.js'),type:'application/javascript; charset=utf-8'},
 '/tracking.js':{body:read('web/tracking.js'),type:'application/javascript; charset=utf-8'},
 '/time-shares.js':{body:read('web/time-shares.js'),type:'application/javascript; charset=utf-8'},
 '/plan-links.js':{body:read('web/plan-links.js').replaceAll("'../lib/plan-matching.mjs'","'/plan-matching.mjs'"),type:'application/javascript; charset=utf-8'},
 '/plan-matching.mjs':{body:read('lib/plan-matching.mjs'),type:'application/javascript; charset=utf-8'},
 '/tracking-model.js':{body:read('lib/tracking.mjs'),type:'application/javascript; charset=utf-8'},
 '/tracking.mjs':{body:read('lib/tracking.mjs'),type:'application/javascript; charset=utf-8'},
 '/cloud-sync.js':{body:read('web/cloud-sync.js'),type:'application/javascript; charset=utf-8'},
 '/sync-storage.js':{body:read('web/sync-storage.js'),type:'application/javascript; charset=utf-8'},
 '/sync-model.js':{body:read('lib/sync.mjs').replaceAll("'./planner.mjs'","'/model.js'"),type:'application/javascript; charset=utf-8'},
 '/sw.js':{body:read('web/sw.js'),type:'application/javascript; charset=utf-8'},
 '/ai.js':{body:read('web/ai.js'),type:'application/javascript; charset=utf-8'},
 '/ai-model.js':{body:read('lib/ai-planner.mjs'),type:'application/javascript; charset=utf-8'},
 '/model.js':{body:read('lib/planner.mjs'),type:'application/javascript; charset=utf-8'},
 '/style.css':{body:read('web/style.css')+'\n'+read('web/week.css')+'\n'+read('web/ai.css')+'\n'+read('web/time-shares.css')+'\n'+read('web/plan-links.css'),type:'text/css; charset=utf-8'},
 '/icon.svg':{body:icon,type:'image/svg+xml'},
 ...Object.fromEntries(launcherIcons.map(name=>['/'+name,{base64:readFileSync(new URL('web/brand/'+name,import.meta.url)).toString('base64'),type:'image/png'}])),
 '/manifest.webmanifest':{body:JSON.stringify({name:'周谱 · weekprofiler',short_name:'周谱',lang:'zh-CN',id:'/',start_url:'/',display:'standalone',background_color:'#f7f8f5',theme_color:'#f7f8f5',icons:[192,512].map(size=>({src:`/weekmark-${size}.png`,sizes:`${size}x${size}`,type:'image/png',purpose:'any maskable'}))}),type:'application/manifest+json'}
};
const model=read('lib/plan-matching.mjs').replace(/^export /gm,'')+'\n'+read('lib/tracking.mjs').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'')+'\n'+read('lib/planner.mjs').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const api=read('worker/api.mjs').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
mkdirSync('dist/server',{recursive:true});
writeFileSync('dist/server/index.js',licenseHeader+model+'\n'+api+'\nconst STATIC_FILES='+JSON.stringify(files)+';\n'+read('worker/index.js'));
if (existsSync('.openai/hosting.json')) {
  mkdirSync('dist/.openai',{recursive:true});
  cpSync('.openai/hosting.json','dist/.openai/hosting.json');
  cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
}
const strip=p=>read(p).replace(/^import .+;\r?\n/gm,'').replace(/^export (?!default)/gm,'');
const cloudFiles={...files,'/':{...files['/'],body:files['/'].body.replace('<head>','<head><meta name="weekprofiler-cloud" content="true">')}};
mkdirSync('dist/cloudflare',{recursive:true});
writeFileSync('dist/cloudflare/index.js',licenseHeader+model+'\n'+strip('lib/sync.mjs')+'\n'+strip('worker/sync-api.mjs')+'\n'+strip('worker/auth.mjs')+'\n'+strip('worker/google-auth.mjs')+'\nconst STATIC_FILES='+JSON.stringify(cloudFiles)+';\n'+strip('worker/cloudflare.js'));
console.log('Built Sites-compatible and direct Cloudflare Workers; portable data remains local-only.');
