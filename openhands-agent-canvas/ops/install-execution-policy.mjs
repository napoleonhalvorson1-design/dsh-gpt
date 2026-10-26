// No model call or account edits. Publish immutable per-run policy paths only
// after all three native servers have confirmed exactly the uploaded bytes.
import {readFile,writeFile,rename,copyFile,stat,chown,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {uploadArchive} from '../server/bulk-handoff.mjs';
import {upstream} from '../shared/openhands.mjs';
const path=process.argv[2];if(!path)throw Error('Usage: node ops/install-execution-policy.mjs /protected/profiles.json');
const source=new URL('./acp-policy.py',import.meta.url),bytes=await readFile(source),sha256=createHash('sha256').update(bytes).digest('hex'),original=await readFile(path),profiles=JSON.parse(original),results=new Map(),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
for(const entry of profiles.items){
 const c=entry.config,key=c.baseUrl+'|'+c.workspace;if(results.has(key))continue;
 const policy=c.workspace.replace(/\/$/,'')+'/.canvas-runtime/acp-policy-'+sha256.slice(0,12)+'.py';
 await uploadArchive(c,source,policy);
 const program='import sys,hashlib,json; p=sys.argv[1]; data=open(p,"rb").read(); assert hashlib.sha256(data).hexdigest()==sys.argv[2]; compile(data,p,"exec"); print(json.dumps({"verified":True}))',command=['python3','-c',program,policy,sha256].map(quote).join(' '),reply=await upstream(c,'/api/bash/execute_bash_command',{method:'POST',body:{command,timeout:15}});
 let probe;try{probe=JSON.parse(reply.stdout)}catch{}if(reply.exit_code!==0||probe?.verified!==true)throw Error('Execution policy verification failed: '+entry.id);
 results.set(key,policy);console.log(JSON.stringify({profile:entry.id,installed:true,verified:true,sha256}));
}
if(!(await readFile(path)).equals(original))throw Error('Profiles changed during installation; reload before switching');
for(const entry of profiles.items)entry.policyRuntimePath=results.get(entry.config.baseUrl+'|'+entry.config.workspace);
const attrs=await stat(path),backup=path+'.before-execution-policy-'+new Date().toISOString().replaceAll(':','-');await copyFile(path,backup);await chown(backup,attrs.uid,attrs.gid);await chmod(backup,attrs.mode&0o777);
const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(profiles,null,2)+'\n',{mode:attrs.mode&0o777});await chown(temporary,attrs.uid,attrs.gid);await rename(temporary,path);
console.log(JSON.stringify({profilesUpdated:profiles.items.length,servers:results.size,oldPoliciesRetained:true,credentialsRetained:true}));
