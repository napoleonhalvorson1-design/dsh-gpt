// Run as the profiles-file owner. Keys stay in memory and HTTP headers.
import {readFile,writeFile,rename,copyFile,stat,chown,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {uploadArchive} from '../server/bulk-handoff.mjs';
import {upstream} from '../shared/openhands.mjs';
const path=process.argv[2];if(!path)throw Error('Usage: node ops/install-fast-handoff.mjs /protected/profiles.json');
const source=new URL('./handoff-fast.py',import.meta.url),bytes=await readFile(source),sha256=createHash('sha256').update(bytes).digest('hex'),original=await readFile(path),profiles=JSON.parse(original),results=new Map();
for(const entry of profiles.items){const c=entry.config,key=c.baseUrl+'|'+c.workspace;if(results.has(key))continue;const helper=c.workspace.replace(/\/$/,'')+'/.canvas-runtime/handoff-fast-'+sha256.slice(0,12)+'.py';
 await uploadArchive(c,source,helper);
 const boot='import hashlib,runpy,sys; p=sys.argv.pop(1); expected=sys.argv.pop(1); assert hashlib.sha256(open(p,"rb").read()).hexdigest()==expected; sys.argv=[p,"--probe"]; runpy.run_path(p,run_name="__main__")',quote=s=>"'"+s.replaceAll("'","'\\''")+"'",command=['python3','-c',boot,helper,sha256].map(quote).join(' '),reply=await upstream(c,'/api/bash/execute_bash_command',{method:'POST',body:{command,timeout:15}});let probe;try{probe=JSON.parse(reply.stdout)}catch{}if(reply.exit_code!==0||probe?.bulkHandoff!==true||probe.schemaVersion!==1)throw Error('Helper verification failed: '+entry.id);
 results.set(key,{version:1,fileModes:probe.fileModes===true,root:c.workspace.replace(/\/$/,''),helper,sha256});console.log(JSON.stringify({profile:entry.id,installed:true,verified:true,version:1}));
}
// No partial profile switch if any server failed its verification.
if(!(await readFile(path)).equals(original))throw Error('Profiles changed during installation; reload and retry');
for(const entry of profiles.items)entry.bulkHandoff=results.get(entry.config.baseUrl+'|'+entry.config.workspace);
const attrs=await stat(path),backup=path+'.before-bulk-'+new Date().toISOString().replaceAll(':','-');await copyFile(path,backup);await chown(backup,attrs.uid,attrs.gid);await chmod(backup,attrs.mode&0o777);const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(profiles,null,2)+'\n',{mode:attrs.mode&0o777});await chown(temporary,attrs.uid,attrs.gid);await rename(temporary,path);console.log(JSON.stringify({profilesUpdated:profiles.items.length,servers:results.size,credentialsRetained:true}));
