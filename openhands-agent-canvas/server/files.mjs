import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ApiError} from '../shared/openhands.mjs';
import {archiveRun} from './storage.mjs';
const execute=promisify(execFile);
const validPath=name=>typeof name==='string'&&name.length>0&&name.length<=1000&&!name.startsWith('/')&&!name.startsWith('-')&&!/[\x00-\x1f\x7f]/.test(name)&&!name.split('/').some(x=>x==='..'||x==='');
export async function listFiles(store,id,directory){
 const archive=await archiveRun(store,id,directory);let stdout;try{({stdout}=await execute('tar',['-tzf',archive.path],{maxBuffer:1000000,timeout:20000,encoding:'utf8'}))}catch{throw new ApiError('产物目录读取失败，请下载完整压缩包。',502)}
 const names=stdout.split('\n').filter(n=>!n.endsWith('/')&&validPath(n)),root=id+'/';
 return {archive:archive.path,partial:!!archive.partial,sourceStage:archive.sourceStage||null,items:names.filter(n=>n.startsWith(root)).slice(0,1500).map(n=>({path:n.slice(root.length),text:/\.(html?|css|[cm]?js|jsx|tsx?|md|txt|json|ya?ml|toml|py|sh|csv|svg|xml)$/i.test(n)}))};
}
export async function readFileResult(store,id,directory,name){
 if(!validPath(name))throw new ApiError('文件路径无效。');const files=await listFiles(store,id,directory),file=files.items.find(f=>f.path===name);if(!file)throw new ApiError('文件不存在。',404);if(!file.text)throw new ApiError('此文件请通过完整压缩包下载。',415);
 try{const {stdout}=await execute('tar',['-xOzf',files.archive,'--',id+'/'+name],{maxBuffer:2000000,timeout:20000,encoding:'utf8'});return {path:name,content:stdout,html:/\.html?$/i.test(name)}}catch{throw new ApiError('文件较大或无法预览，请下载完整压缩包。',413)}
}

export async function downloadFileResult(store,id,directory,name){
 if(!validPath(name))throw new ApiError('文件路径无效。');const files=await listFiles(store,id,directory);if(!files.items.some(f=>f.path===name))throw new ApiError('文件不存在。',404);
 try{const {stdout}=await execute('tar',['-xOzf',files.archive,'--',id+'/'+name],{maxBuffer:8*1024*1024,timeout:20000,encoding:'buffer'});return {name:name.split('/').at(-1),content:stdout}}catch{throw new ApiError('文件较大，请下载完整压缩包。',413)}
}
