// Real authenticated file I/O only; no model inference. Run with the protected profiles path.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {transferWorkspace} from '../server/handoff.mjs';
import {upstream} from '../shared/openhands.mjs';
const profiles=JSON.parse(await readFile(process.argv[2],'utf8')),directory=await mkdtemp(join(tmpdir(),'canvas-native-bulk-')),seen=new Set(),results=[],exec=promisify(execFile),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const hash=b=>createHash('sha256').update(b).digest('hex');
try{for(const profile of profiles.items){const config=profile.config;if(seen.has(config.baseUrl))continue;seen.add(config.baseUrl);
 for(const count of [16,80,400]){const id='bulk-bench-'+count+'-'+randomUUID(),source=join(directory,id),archive=join(directory,id+'.tar.gz'),expected=[];await mkdir(source);
  for(let n=0;n<count;n++){const path=n===0?'src/中文.bin':'src/f-'+n+'.txt',bytes=n===0?Buffer.from([0,255,13,10,128]):Buffer.from(('module '+n+'\n').repeat(200));await mkdir(dirname(join(source,path)),{recursive:true});await writeFile(join(source,path),bytes);expected.push({path,sha256:hash(bytes),size:bytes.length})}
  await exec('python3',['-c','import sys,tarfile,pathlib\np=pathlib.Path(sys.argv[1])\nwith tarfile.open(sys.argv[2],"w:gz") as t:t.add(p,arcname=p.name)',source,archive]);const pair={server:profile.id,files:count};
  for(const mode of ['legacy','bulk']){console.log(JSON.stringify({server:profile.id,files:count,mode,state:'started'}));const targetWorkspace=config.workspace+'/runs/'+id+'/'+mode;await upstream(config,'/api/file/create_directory?'+new URLSearchParams({path:targetWorkspace}),{method:'POST',allowEmpty:true});const start=performance.now(),metrics=await transferWorkspace({runId:id,nodeId:mode,source:config,target:{...config,...(mode==='bulk'?{bulkHandoff:profile.bulkHandoff}:{})},sourceWorkspace:'/unused',targetWorkspace,directory,sourceArchive:archive,targetRoot:mode});const elapsedMs=Math.round(performance.now()-start);
   const program='import pathlib,sys,hashlib,json\np=pathlib.Path(sys.argv[1]); print(json.dumps([{ "path":str(f.relative_to(p)),"size":f.stat().st_size,"sha256":hashlib.sha256(f.read_bytes()).hexdigest()} for f in p.rglob("*") if f.is_file()],ensure_ascii=False))',verification=await upstream(config,'/api/bash/execute_bash_command',{method:'POST',body:{command:['python3','-c',program,targetWorkspace].map(quote).join(' '),timeout:15}});assert.equal(verification.exit_code,0);const actual=JSON.parse(verification.stdout).sort((a,b)=>a.path.localeCompare(b.path));assert.deepEqual(actual,expected.sort((a,b)=>a.path.localeCompare(b.path)));pair[mode]={elapsedMs,verifiedFiles:actual.length,bytes:metrics.bytes};console.log(JSON.stringify({server:profile.id,files:count,mode,...pair[mode]}));
  }
  pair.speedup=Number((pair.legacy.elapsedMs/pair.bulk.elapsedMs).toFixed(2));results.push(pair);
 }
}await writeFile(process.env.CANVAS_BENCH_REPORT||'/tmp/canvas-native-handoff-report.json',JSON.stringify({scope:'real three-server handoff, all file bytes verified, no model inference',results},null,2));console.log(JSON.stringify({results}));}finally{await rm(directory,{recursive:true,force:true})}
