import https from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';import {once} from 'node:events';
export async function startBrowserFixture(worker,env,{intercept}={}){
 const folder=await mkdtemp(join(tmpdir(),'canvas-browser-ssl-')),key=join(folder,'test.key'),cert=join(folder,'test.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
 let origin;
 const server=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  try{const chunks=[];for await(const b of req)chunks.push(b);const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),response=await intercept?.(request)||await worker.fetch(request,env),headers=Object.fromEntries(response.headers),cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies;res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()))}
  catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}
 });server.listen(0,'127.0.0.1');await once(server,'listening');origin='https://127.0.0.1:'+server.address().port;
 return {origin,close:async()=>{await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true})}};
}
