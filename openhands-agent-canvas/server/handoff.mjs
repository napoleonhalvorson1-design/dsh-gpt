import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,rename,unlink,mkdtemp,rm,readFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ApiError} from '../shared/openhands.mjs';
import {bulkTransfer} from './bulk-handoff.mjs';
import {withArchiveWorker} from './archive-pool.mjs';
const execute=promisify(execFile),helper=fileURLToPath(new URL('./handoff.py',import.meta.url));
// Shared across workflows: cap open transfers and source buffers, including large binary files.
let uploadSlots=0,uploadBytes=0;const uploadQueue=[];
function drainUploads(){while(uploadQueue.length&&uploadSlots<4){const next=uploadQueue[0];if(uploadBytes+next.bytes>32*1024*1024)break;uploadQueue.shift();uploadSlots++;uploadBytes+=next.bytes;let released=false;next.resolve(()=>{if(released)return;released=true;uploadSlots--;uploadBytes-=next.bytes;drainUploads()})}}
function reserveUpload(size){return new Promise(resolve=>{uploadQueue.push({bytes:Math.max(65536,size),resolve});drainUploads()})}
const inspectArchive=(args,options)=>withArchiveWorker(()=>execute('python3',[helper,...args],options));
export async function snapshotWorkspace(config,workspace,destination){
 const query=new URLSearchParams({path:workspace,format:'tar.gz',use_default_excludes:'true'}),url=config.baseUrl+'/api/file/archive?'+query;
 const response=await fetch(url,{headers:{'X-Session-API-Key':config.apiKey},redirect:'manual',signal:AbortSignal.timeout(90000)});if(!response.ok||!response.body)throw new ApiError('跨服务器交接时无法打包工作目录。',502);
 let bytes=0;const limit=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>128*1024*1024?Error('Archive exceeds transfer limit'):null,chunk)}});const partial=destination+'.part';try{await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(partial,{mode:0o600}));await rename(partial,destination)}catch(e){await unlink(partial).catch(()=>{});throw new ApiError('工作目录传输中断或超过大小限制，请重试。',502)}return destination;
}
export async function transferWorkspace({runId,nodeId,source,target,sourceWorkspace,targetWorkspace,directory,sourceArchive,targetRoot=runId,onProgress=()=>{}}){
 if(source.baseUrl===target.baseUrl&&sourceWorkspace===targetWorkspace)return {files:0,skipped:true};if(source.mode!=='remote'||target.mode!=='remote')throw new ApiError('跨服务器文件交接目前需要两个自托管执行入口。',409);
 const folder=join(directory,'handoff',runId);await mkdir(folder,{recursive:true,mode:0o700});
 if(target.bulkHandoff?.version===1){const archive=sourceArchive||await snapshotWorkspace(source,sourceWorkspace,join(folder,nodeId+'-source.tar.gz'));return bulkTransfer({runId,nodeId,target,targetWorkspace,sourceArchive:archive,inspect:async(path,root)=>JSON.parse((await inspectArchive(['inspect',path,root],{maxBuffer:1500000,timeout:30000})).stdout)})}
 const started=performance.now(),temporary=await mkdtemp(join(folder,nodeId+'-upload-'));
 try{
  const snapshots=await Promise.allSettled([sourceArchive||snapshotWorkspace(source,sourceWorkspace,join(folder,nodeId+'-source.tar.gz')),snapshotWorkspace(target,targetWorkspace,join(folder,nodeId+'-destination.tar.gz'))]);
  const error=snapshots.find(r=>r.status==='rejected');if(error)throw error.reason;const [from,to]=snapshots.map(r=>r.value);
  const inspected=await Promise.allSettled([inspectArchive(['export',from,runId,temporary],{maxBuffer:1500000,timeout:90000}),inspectArchive(['inspect',to,targetRoot],{maxBuffer:1500000,timeout:30000})]);
  if(inspected.some(r=>r.status==='rejected'))throw new ApiError('产物交接检查失败：目录中存在不安全路径或文件超过传输限制。',400);
  const [manifest,destination]=inspected.map(r=>JSON.parse(r.value.stdout));
  for(const file of manifest.items)if(destination.blocked.some(link=>file.path===link||file.path.startsWith(link+'/')))throw new ApiError('交接目标包含符号链接，请处理后重试。',400);
  let index=0,failure;
  await Promise.all(Array.from({length:Math.min(4,manifest.items.length)},async()=>{
   while(!failure&&index<manifest.items.length){const file=manifest.items[index++],release=await reserveUpload(file.size);
    try{if(failure)return;const bytes=await readFile(join(temporary,file.path)),body=new FormData();body.append('file',new Blob([bytes]),file.path.split('/').at(-1));const response=await fetch(target.baseUrl+'/api/file/upload?'+new URLSearchParams({path:targetWorkspace+'/'+file.path}),{method:'POST',headers:{'X-Session-API-Key':target.apiKey},body,redirect:'manual',signal:AbortSignal.timeout(90000)});if(!response.ok)throw new ApiError('文件交接上传失败，请从当前节点重试。',502);await response.arrayBuffer()}
    catch(error){failure??=error}finally{release()}
   }
  }));
  if(failure)throw failure;onProgress(manifest.items.length);return {files:manifest.items.length,bytes:manifest.total,durationMs:Math.round(performance.now()-started),maxParallelUploads:4};
 }finally{await rm(temporary,{recursive:true,force:true})}
}
