import http from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
const env=process.env,origin=new URL(env.CANVAS_PUBLIC_ORIGIN||'http://localhost:18120');
const worker=(await import(pathToFileURL(resolve(env.CANVAS_WORKER_PATH||'dist/server/index.js')).href)).default;
http.createServer(async(req,res)=>{
 try{
  if(!req.url.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);res.end();return}
  if(req.url.split('?')[0]==='/mcp'){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'MCP 请使用网站同名插件连接；此服务器入口支持网页和 canvas 命令行。'}));return}
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1500000){res.writeHead(413);res.end();return}chunks.push(chunk)}
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers)){if(v&&!k.startsWith('oai-')&&!['host','cf-connecting-ip','content-length','connection'].includes(k))headers.set(k,Array.isArray(v)?v.join(','):v)}headers.set('CF-Connecting-IP',req.headers['x-real-ip']||req.socket.remoteAddress);
  const request=new Request(origin.origin+req.url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  const result=await worker.fetch(request,env),out=Object.fromEntries(result.headers);const cookies=result.headers.getSetCookie();if(cookies.length)out['set-cookie']=cookies;
  res.writeHead(result.status,out);if(!result.body){res.end();return}Readable.fromWeb(result.body).on('error',()=>res.destroy()).pipe(res);
 }catch{if(res.headersSent){res.destroy();return}res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:'工作台服务暂时不可用，请稍后重试。'}))}
}).listen(Number(env.CANVAS_WEB_PORT)||18120,'127.0.0.1',()=>console.log('Canvas web gateway listening on loopback.'));
