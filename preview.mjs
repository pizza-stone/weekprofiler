// Local-only preview. Simulated identity is never included in the hosted Worker.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import worker from './dist/server/index.js';
mkdirSync('.sites-runtime',{recursive:true});
const db=new DatabaseSync('.sites-runtime/preview.sqlite');
if(!db.prepare("SELECT name FROM sqlite_master WHERE name='planner_states'").get())db.exec(readFileSync('drizzle/0000_planner.sql','utf8'));
const env={DB:{prepare(sql){return {bind(...params){return {async first(){return db.prepare(sql).get(...params)||null;}};}};}}};
const server=createServer(async(req,res)=>{try{
 const chunks=[];for await(const c of req)chunks.push(c);
 const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-preview-owner');
 const request=new Request('http://127.0.0.1:5173'+req.url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
 const response=await worker.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(err){res.writeHead(500);res.end(String(err));}});
server.listen(5173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:5173'));
