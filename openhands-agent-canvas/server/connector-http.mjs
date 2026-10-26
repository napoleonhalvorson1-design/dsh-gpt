import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns';
import {isIP,BlockList} from 'node:net';
const denied=new BlockList(),privateNet=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['169.254.0.0',16],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['127.0.0.0',8],['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10]])privateNet.addSubnet(ip,bits,'ipv4');
denied.addAddress('100.100.100.200','ipv4');
denied.addSubnet('fe80::',10,'ipv6');denied.addSubnet('ff00::',8,'ipv6');denied.addAddress('::','ipv6');denied.addAddress('fd00:ec2::254','ipv6');privateNet.addAddress('::1','ipv6');privateNet.addSubnet('fc00::',7,'ipv6');
import {ApiError} from '../shared/openhands.mjs';

export const MAX_BYTES=2*1024*1024;
export function endpoint(value,{allowPrivate=false}={}){
 let u;try{u=new URL(value)}catch{throw new ApiError('连接地址无效。')}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new ApiError('连接地址必须是无凭据、查询和片段的 HTTP(S) 地址。');
 if(u.protocol!=='https:'&&!allowPrivate)throw new ApiError('公网接口必须使用 HTTPS；自建服务需明确启用私有网络。');
 if(['metadata.google.internal','metadata','instance-data'].includes(u.hostname.toLowerCase()))throw new ApiError('不允许连接实例元数据服务。');
 const host=u.hostname.replace(/^\[|\]$/g,'');if(isIP(host))checkAddress(host,allowPrivate);
 return u.href.replace(/\/$/,'');
}
export function checkAddress(ip,allowPrivate){
 const family=isIP(ip);if(!family||denied.check(ip,family===6?'ipv6':'ipv4'))throw new ApiError('不允许访问此网络地址。');
 if(!allowPrivate&&privateNet.check(ip,family===6?'ipv6':'ipv4'))throw new ApiError('私有网络未启用。');
}
export const safeLookup=allowPrivate=>(host,opts,cb)=>lookup(host,{all:true},(error,items)=>{if(error)return cb(error);try{if(!items.length)throw new ApiError('无法解析接口域名。');for(const a of items)checkAddress(a.address,allowPrivate);if(opts.all)cb(null,items);else cb(null,items[0].address,items[0].family)}catch(e){cb(e)}});
export const networkAgents=c=>({httpAgent:new http.Agent({lookup:safeLookup(c.allowPrivate)}),httpsAgent:new https.Agent({lookup:safeLookup(c.allowPrivate)}),requestTimeout:c.timeoutMs||30000,connectionTimeout:10000,throwOnRequestTimeout:true});
export function target(base,path){
 if(typeof path!=='string'||path.length>6000||/^[a-z]+:/i.test(path)||path.startsWith('//')||/[\\#]/.test(path))throw new ApiError('操作路径必须相对于连接地址。');
 let decoded=path;for(let i=0;i<3;i++){try{decoded=decodeURIComponent(decoded)}catch{throw new ApiError('路径编码无效。')}if(decoded.split(/[/?]/).some(s=>s==='..'||s==='.')||/[\\\x00-\x1f]/.test(decoded))throw new ApiError('操作路径不能越过连接根目录。')}
 const root=new URL(base.replace(/\/$/,'')+'/'),u=new URL(path.replace(/^\//,''),root);
 if(u.origin!==root.origin||!u.pathname.startsWith(root.pathname))throw new ApiError('操作不能跳转到其他连接。');return u;
}
export function request(c,path,{method='GET',headers={},body,signal,timeout=30000}={}){
 const u=target(endpoint(c.baseUrl,c),path),lookupSafe=safeLookup(c.allowPrivate);
 return new Promise((resolve,reject)=>{
  const req=(u.protocol==='https:'?https:http).request(u,{method,headers,signal,lookup:lookupSafe},res=>{
   const chunks=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES){res.destroy();reject(new ApiError('接口响应超过 2 MiB，请分页或缩小读取范围。',413))}else chunks.push(chunk)});
   res.on('error',()=>reject(new ApiError('接口响应中断。',502)));
   res.on('end',()=>{if(res.statusCode>=300&&res.statusCode<400)return reject(new ApiError('接口返回重定向；请配置最终 API 地址，凭据不会转发到其他地址。',502));if(res.statusCode<200||res.statusCode>=300)return reject(new ApiError('外部接口返回 HTTP '+res.statusCode+'。请检查权限、参数和服务状态。',502));const text=Buffer.concat(chunks).toString('utf8');let data=text;if(/json/i.test(res.headers['content-type']||'')){try{data=JSON.parse(text)}catch{return reject(new ApiError('接口返回了无效 JSON。',502))}}resolve({status:res.statusCode,data,contentType:res.headers['content-type']||'',etag:res.headers.etag||null})});
  });
  const deadline=setTimeout(()=>req.destroy(new ApiError('外部接口请求超时。',504)),timeout);req.on('close',()=>clearTimeout(deadline));req.setTimeout(timeout,()=>req.destroy(new ApiError('外部接口请求超时。',504)));req.on('error',e=>reject(e instanceof ApiError?e:new ApiError(signal?.aborted?'调用已取消。':'无法连接外部接口，请检查地址、网络和凭据。',502)));
  if(body!==undefined){const value=Buffer.isBuffer(body)?body:String(body);if(Buffer.byteLength(value)>MAX_BYTES){req.destroy();return reject(new ApiError('请求内容超过 2 MiB。',413))}req.write(value)}req.end();
 });
}
