import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const icon='<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="48" fill="#416b57"/><circle cx="96" cy="96" r="55" fill="none" stroke="#fff" stroke-width="9"/><path d="M96 50v46l32 20" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/></svg>';
const files={
 '/':{body:read('web/index.html'),type:'text/html; charset=utf-8'},
 '/app.js':{body:read('web/app.js'),type:'application/javascript; charset=utf-8'},
 '/week.js':{body:read('web/week.js'),type:'application/javascript; charset=utf-8'},
 '/ai.js':{body:read('web/ai.js'),type:'application/javascript; charset=utf-8'},
 '/ai-model.js':{body:read('lib/ai-planner.mjs'),type:'application/javascript; charset=utf-8'},
 '/model.js':{body:read('lib/planner.mjs'),type:'application/javascript; charset=utf-8'},
 '/style.css':{body:read('web/style.css')+'\n'+read('web/week.css')+'\n'+read('web/ai.css'),type:'text/css; charset=utf-8'},
 '/icon.svg':{body:icon,type:'image/svg+xml'},
 '/manifest.webmanifest':{body:JSON.stringify({name:'周谱 · weekprofiler',short_name:'周谱',lang:'zh-CN',id:'/',start_url:'/',display:'standalone',background_color:'#f7f8f5',theme_color:'#f7f8f5',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]}),type:'application/manifest+json'}
};
const model=read('lib/planner.mjs').replace(/^export /gm,'');
const api=read('worker/api.mjs').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
mkdirSync('dist/server',{recursive:true});
writeFileSync('dist/server/index.js',model+'\n'+api+'\nconst STATIC_FILES='+JSON.stringify(files)+';\n'+read('worker/index.js'));
if (existsSync('.openai/hosting.json')) {
  mkdirSync('dist/.openai',{recursive:true});
  cpSync('.openai/hosting.json','dist/.openai/hosting.json');
  cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
}
console.log('Built dependency-free Worker with private D1 storage and all assets.');
