import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {ApiError,upstream} from '../shared/openhands.mjs';
const quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export async function uploadArchive(config,path,destination){
 const boundary='canvas-'+randomUUID(),head=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="input.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`),tail=Buffer.from(`\r\n--${boundary}--\r\n`),size=(await stat(path)).size;
 async function* body(){yield head;for await(const chunk of createReadStream(path))yield chunk;yield tail}
 const r=await fetch(config.baseUrl+'/api/file/upload?'+new URLSearchParams({path:destination}),{method:'POST',headers:{'X-Session-API-Key':config.apiKey,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(head.length+size+tail.length)},body:Readable.from(body()),duplex:'half',redirect:'manual',signal:AbortSignal.timeout(90000)});
 if(!r.ok)throw new ApiError('整包交接上传失败（HTTP '+r.status+'），请重试当前阶段。',502);await r.arrayBuffer();return size;
}
export async function bulkTransfer({runId,nodeId,target,targetWorkspace,sourceArchive,inspect}){
 const capability=target.bulkHandoff;if(capability?.version!==1||!capability.helper||!/^\/[\w./ -]+$/.test(capability.helper)||!/^[a-f0-9]{64}$/.test(capability.sha256||''))throw new ApiError('整包交接能力尚未配置或版本无效。',409);
 const checked=await inspect(sourceArchive,runId);if(checked.blocked?.length)throw new ApiError('交接压缩包包含符号链接。',400);
 const hash=createHash('sha256');for await(const chunk of createReadStream(sourceArchive))hash.update(chunk);const sha=hash.digest('hex'),requestId=createHash('sha256').update(JSON.stringify([runId,nodeId,targetWorkspace,sha])).digest('hex'),root=capability.root||target.workspace,remoteArchive=root+'/.canvas-runtime/transfers/'+randomUUID()+'.tar.gz';
 const started=performance.now();await uploadArchive(target,sourceArchive,remoteArchive);
 const boot='import hashlib,runpy,sys; p=sys.argv.pop(1); expected=sys.argv.pop(1); actual=hashlib.sha256(open(p,"rb").read()).hexdigest(); assert actual==expected,"helper version mismatch"; sys.argv[0]=p; runpy.run_path(p,run_name="__main__")',args=['/usr/bin/python3','-c',boot,capability.helper,capability.sha256,'--root',root,'--target',targetWorkspace,'--archive',remoteArchive,'--archive-root',runId,'--sha256',sha,'--request-id',requestId],command=args.map(quote).join(' ');
 let result;try{result=await upstream(target,'/api/bash/execute_bash_command',{method:'POST',body:{command,timeout:75},timeoutMs:90000})}catch(error){throw new ApiError('整包交接确认尚未完成，请重试；模型尚未启动。',error.status>=500?502:400)}
 let receipt;try{receipt=JSON.parse(result.stdout||'{}')}catch{}if(result.exit_code!==0||!receipt?.committed||receipt.requestId!==requestId||receipt.archiveSha256!==sha||receipt.target!==targetWorkspace||receipt.files!==checked.items.length||receipt.bytes!==checked.total)throw new ApiError('整包交接校验失败：'+String(receipt?.error||'缺少匹配的提交回执').slice(0,200),400);
 return {files:receipt.files,bytes:receipt.bytes,durationMs:Math.round(performance.now()-started),mode:'bulk',requests:2,archiveSha256:sha,manifestSha256:receipt.manifestSha256,reused:receipt.reused};
}
