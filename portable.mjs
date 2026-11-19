// Local-only preview is explicitly separate from the cloud-backed site.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
let html=readFileSync('web/index.html','utf8');
const license=readFileSync(new URL('./LICENSE',import.meta.url),'utf8').trim();
html=html.replace('</head>','<script type="text/plain" id="project-license">'+license+'</script>\n</head>');
const trackingModel=readFileSync('lib/plan-matching.mjs','utf8').replace(/^export /gm,'')+'\n'+readFileSync('lib/tracking.mjs','utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const model=readFileSync('lib/planner.mjs','utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
let app=readFileSync('web/app.js','utf8').replace(/^import .+;\r?\n/gm,'');
app=app.replaceAll('已同步','仅存本机').replaceAll('正在同步','正在保存').replaceAll('等待同步','等待保存');
app=app.replace('在两端用同一个 ChatGPT 账户打开本网站。打开页面时同步，并每 12 秒检查更新。','这是可试用的本机预览版，数据仅保存在当前浏览器。跨设备同步需要网站上线后才能使用。');
app=app.replace('电脑与手机同步','本机预览 · 尚未联网同步');
app=app.replace('华为浏览器打开此网址，在菜单中选择「添加至 → 桌面」。首次加载需要网络；已打开的页面支持断网编辑，恢复联网后补同步。','当前是独立文件预览。正式网站上线后可在华为浏览器中添加到桌面。请定期导出 JSON 备份，浏览器清理数据可能移除本机记录。');
app=app.replace('A LITTLE MORE INTENTION / 把时间留给重要的事','本机预览 · 尚未开启跨端同步');
const weekly=readFileSync('web/week.js','utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const aiModel=readFileSync('lib/ai-planner.mjs','utf8').replace(/^export /gm,'');
const aiUI=readFileSync('web/ai.js','utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const trackingUI=readFileSync('web/tracking.js','utf8').replace(/^export /gm,'');
const timeSharesUI=readFileSync('web/time-shares.js','utf8').replace(/^export /gm,'');
const planLinksUI=readFileSync('web/plan-links.js','utf8').replace(/^import .+;\r?\n/gm,'').replace(/^export \{.+\};\r?\n/gm,'').replace(/^export /gm,'');
const trackingExports='const trackingModel={validateTracking,startTracking,pauseTracking,resumeTracking,stopTracking,summarizeTracking,trackingRecordAssignments,actualSegments,timeInputValue,parseTimeInput};';
const code=(trackingModel+'\n'+trackingExports+'\n'+model+'\n'+weekly+'\n'+aiModel+'\n'+aiUI+'\n'+trackingUI+'\n'+timeSharesUI+'\n'+planLinksUI+'\n'+readFileSync('portable-adapter.js','utf8')+'\n'+app).replace(/<\/script/gi,'<\\/script');
const brandData='data:image/svg+xml;base64,'+readFileSync('web/brand/weekmark.svg').toString('base64');
html=html.replace('href="/icon.svg"','href="'+brandData+'"').replace(/<link rel="apple-touch-icon"[^>]*>/,'').replace('<link rel="manifest" href="/manifest.webmanifest">','');
html=html.replace('<link rel="stylesheet" href="/style.css">','<style>'+readFileSync('web/style.css','utf8').replace('url("/icon.svg")','url("'+brandData+'")')+'\n'+readFileSync('web/week.css','utf8')+'\n'+readFileSync('web/ai.css','utf8')+'\n'+readFileSync('web/time-shares.css','utf8')+'\n'+readFileSync('web/plan-links.css','utf8')+'</style>');
html=html.replace('<script type="module" src="/app.js"></script>','<script type="module">'+code+'</script>');
mkdirSync('outputs',{recursive:true});
// Preserve the original file path as a compatibility entry for browser-local data.
for(const name of ['weekprofiler-preview.html','dayloom-preview.html']){
  writeFileSync(name,html);
  writeFileSync('outputs/'+name,html);
}
console.log('Created local-only preview, explicitly labeled with no cloud synchronization.');
