import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {basename,join} from 'node:path';
import {mkdir,unlink} from 'node:fs/promises';
import {snapshotWorkspace} from './handoff.mjs';
import {ApiError} from '../shared/openhands.mjs';
import {withArchiveWorker} from './archive-pool.mjs';
const helper=fileURLToPath(new URL('./handoff.py',import.meta.url));
export function archiveOperation(mode,path,args=[],input){
 return withArchiveWorker(()=>new Promise((resolve,reject)=>{const child=spawn('python3',[helper,mode,path,...args],{stdio:['pipe','pipe','pipe']});let output='',error='',done=false;const timer=setTimeout(()=>{child.kill();error='协作文件处理超时。'},90000);child.stdout.on('data',b=>{output+=b;if(output.length>2000000)child.kill()});child.stderr.on('data',b=>error=(error+b).slice(-4000));child.on('error',e=>{clearTimeout(timer);done=true;reject(e)});child.on('exit',code=>{clearTimeout(timer);if(done)return;if(code!==0)return reject(new ApiError('协作文件检查失败：'+(error.split('\n').filter(Boolean).at(-1)||'无效压缩包'),400));try{resolve(output.trim()?JSON.parse(output):null)}catch{reject(new ApiError('协作文件报告无效。',502))}});child.stdin.on('error',()=>{});child.stdin.end(input?JSON.stringify(input):undefined)}));
}
export async function captureNode(config,node,runId,directory){
 const folder=join(directory,'parallel',runId);await mkdir(folder,{recursive:true,mode:0o700});const raw=join(folder,node.id+'-raw.tar.gz'),path=join(folder,node.id+'.tar.gz');
 try{await snapshotWorkspace(config,node.workspace,raw);await archiveOperation('normalize',raw,[basename(node.workspace),path,runId]);return path}finally{await unlink(raw).catch(()=>{})}
}
export async function mergeArchives({runId,nodeId,directory,parents,base,baseId,sources=[],lineage=[],repository,scheduler}){
 const folder=join(directory,'parallel',runId);await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,nodeId+'-input.tar.gz'),report=await archiveOperation('merge',path,[],{runId,nodeId,parents,base,baseId,sources,lineage,repository,scheduler});return {path,report};
}
export async function validateMerge(path,runId,report){return archiveOperation('validate',path,[runId],report||{conflicts:[]})}
