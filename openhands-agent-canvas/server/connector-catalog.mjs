import {ApiError} from '../shared/openhands.mjs';
export const objectSchema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const str=(description='')=>({type:'string',description}),integer={type:'integer',minimum:1,maximum:1000};
const op=(id,label,readOnly,properties={},required=[])=>({id,label,readOnly,inputSchema:objectSchema(properties,required)});
export const TYPES=[
 {id:'agent',label:'服务器 AI Agent',category:'ai',description:'复用已登录的 Codex、Claude 和 DeepSeek 执行入口',system:true},
 {id:'canvas-storage',label:'工作台数据桶',category:'storage',description:'复用现有七彩云桶与环境变量凭据',system:true},
 {id:'openai',label:'OpenAI 兼容 AI',category:'ai',description:'DeepSeek、Ollama、vLLM 等 Chat Completions 接口',baseUrl:'https://api.openai.com/v1'},
 {id:'anthropic',label:'Anthropic API',category:'ai',description:'Claude Messages API',baseUrl:'https://api.anthropic.com/v1'},
 {id:'s3',label:'S3 兼容数据桶',category:'storage',description:'七彩云、R2、AWS、MinIO，使用 Signature V4'},
 {id:'github',label:'GitHub',category:'code',description:'开发分支、多文件提交、CI、PR 与 Codex 批准后合并',baseUrl:'https://api.github.com'},
 {id:'webdav',label:'WebDAV 网盘',category:'drive',description:'坚果云、Nextcloud、Alist 等 WebDAV 服务'},
 {id:'google-drive',label:'Google Drive',category:'drive',description:'使用 OAuth Access Token 或服务器环境变量访问文件',baseUrl:'https://www.googleapis.com/drive/v3'},
 {id:'onedrive',label:'OneDrive / SharePoint',category:'drive',description:'Microsoft Graph，使用 OAuth Access Token',baseUrl:'https://graph.microsoft.com/v1.0'},
 {id:'http',label:'通用 HTTP / OpenAPI',category:'api',description:'自定义 REST、Webhook 或导入 OpenAPI 3 JSON；无需修改引擎代码'}
];
export function operations(c){
 const path=str('相对文件路径'),cursor=str('分页标识'),limit=integer;
 switch(c.type){
 case 'agent':return [op('test','检查执行入口',true),op('run','执行 AI 任务',false,{task:str('任务与交付要求')},['task'])];
 case 'canvas-storage':case 's3':return [op('list','列出文件',true,{prefix:str(),cursor,limit}),op('read','读取文件',true,{key:str()},['key']),op('put','写入文件',false,{key:str(),content:str(),contentType:str()},['key','content'])];
 case 'openai':return [op('models','列出模型',true),op('chat','调用 AI',false,{model:str(),prompt:str(),system:str(),maxTokens:{type:'integer',minimum:1,maximum:131072}},['prompt'])];
 case 'anthropic':return [op('models','列出模型',true),op('chat','调用 Claude',false,{model:str(),prompt:str(),system:str(),maxTokens:{type:'integer',minimum:1,maximum:131072}},['prompt'])];
 case 'github':return [op('repos','列出仓库',true,{page:integer,limit}),op('contents','读取仓库文件',true,{owner:str(),repo:str(),path,ref:str()},['owner','repo']),op('issues','列出 Issue',true,{owner:str(),repo:str(),page:integer,limit},['owner','repo']),op('create_issue','创建 Issue',false,{owner:str(),repo:str(),title:str(),body:str()},['owner','repo','title']),op('put_file','提交仓库文件',false,{owner:str(),repo:str(),path,content:str(),message:str(),branch:str(),sha:str()},['owner','repo','path','content','message']),op('repo','仓库信息',true,{owner:str(),repo:str()},['owner','repo']),op('branch','读取分支',true,{owner:str(),repo:str(),branch:str()},['owner','repo','branch']),op('create_branch','创建开发分支',false,{owner:str(),repo:str(),branch:str(),base:str()},['owner','repo','branch']),op('commit_files','原子提交多文件',false,{owner:str(),repo:str(),branch:str(),expectedHeadSha:str(),message:str(),files:{type:'array',items:objectSchema({path:str(),content:str(),mode:{type:'string',enum:['100644','100755']},encoding:{type:'string',enum:['utf-8','base64']},delete:{type:'boolean'}},['path'])}},['owner','repo','branch','expectedHeadSha','message','files']),op('pull_request','读取 PR',true,{owner:str(),repo:str(),number:{type:'integer',minimum:1}},['owner','repo','number']),op('create_pull_request','创建 PR',false,{owner:str(),repo:str(),head:str(),base:str(),title:str(),body:str(),draft:{type:'boolean'}},['owner','repo','head','title']),op('workflow_runs','查询提交 CI',true,{owner:str(),repo:str(),headSha:str(),page:integer},['owner','repo','headSha']),op('dispatch_workflow','运行 CI 工作流',false,{owner:str(),repo:str(),workflow:str(),ref:str(),inputs:{type:'object',additionalProperties:{type:'string'}}},['owner','repo','workflow','ref']),op('ci_status','核对当前 PR 的完整 CI',true,{owner:str(),repo:str(),number:{type:'integer',minimum:1},expectedHeadSha:str()},['owner','repo','number']),op('merge_pull_request','Codex 批准后合并',false,{owner:str(),repo:str(),number:{type:'integer',minimum:1},expectedHeadSha:str(),approvedHeadSha:str(),method:{type:'string',enum:['squash','merge','rebase']},title:str(),message:str()},['owner','repo','number','expectedHeadSha','approvedHeadSha'])];
 case 'webdav':return [op('list','列出目录',true,{path}),op('read','读取文件',true,{path},['path']),op('put','写入文件',false,{path,content:str()},['path','content']),op('mkdir','创建目录',false,{path},['path'])];
 case 'google-drive':return [op('list','列出或搜索文件',true,{q:str(),cursor,limit}),op('read','读取文件内容',true,{fileId:str(),exportMimeType:str()},['fileId']),op('create','创建文本文件',false,{name:str(),content:str(),parentId:str(),mimeType:str()},['name','content']),op('update','更新文件内容',false,{fileId:str(),content:str()},['fileId','content'])];
 case 'onedrive':return [op('list','列出目录',true,{path,cursor}),op('read','读取文件内容',true,{path},['path']),op('put','写入文件',false,{path,content:str()},['path','content'])];
 case 'http':return (c.config.operations||[]).map(o=>({...o,label:o.label||o.id,readOnly:['GET','HEAD','OPTIONS','PROPFIND'].includes(o.method),inputSchema:o.inputSchema||{type:'object',additionalProperties:true}}));
 default:throw new ApiError('不支持的连接器类型。');
 }
}
export function validateInput(value,schema,path='input'){
 if(!schema||schema.$ref||schema.oneOf||schema.anyOf||schema.allOf)throw new ApiError('参数 Schema 含未支持的引用或组合，请改为普通 object/array/string/number/integer/boolean。');
 const type=schema.type;if(type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(path+' 必须是对象。');
  for(const key of schema.required||[])if(value[key]===undefined)throw new ApiError(path+'.'+key+' 为必填。');
  for(const [key,v] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new ApiError('参数名称无效。');const child=schema.properties?.[key];if(child)validateInput(v,child,path+'.'+key);else if(schema.additionalProperties===false)throw new ApiError(path+'.'+key+' 不是允许的参数。')}
 }else if(type==='array'){if(!Array.isArray(value))throw new ApiError(path+' 必须是数组。');if(value.length>500)throw new ApiError('数组过长。');if(schema.items)for(const v of value)validateInput(v,schema.items,path+'[]')}
 else if(type==='string'){if(typeof value!=='string'||value.length>(schema.maxLength??200000)||value.length<(schema.minLength??0))throw new ApiError(path+' 文本长度或类型无效。')}
 else if(type==='integer'||type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||type==='integer'&&!Number.isInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw new ApiError(path+' 数值无效。')}
 else if(type==='boolean'&&typeof value!=='boolean')throw new ApiError(path+' 必须是布尔值。');
 if(schema.enum&&!schema.enum.includes(value))throw new ApiError(path+' 不在允许的值中。');
}
export function reference(context,key){
 if(!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(key)||key.split('.').some(k=>['__proto__','constructor','prototype'].includes(k)))throw new ApiError('引用路径无效：'+key);
 let value=context;for(const part of key.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,part))throw new ApiError('引用不存在：'+key);value=value[part]}return value;
}
export function template(value,context,{encode=false}={}){
 if(typeof value==='string'){
  const whole=value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);if(whole&&!encode)return reference(context,whole[1]);
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g,(_,key)=>{const v=reference(context,key),s=typeof v==='object'?JSON.stringify(v):String(v);return encode?encodeURIComponent(s):s});
 }if(Array.isArray(value))return value.map(v=>template(v,context));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,template(v,context)]));return value;
}
export function importOpenApi(document){
 if(!document||!/^3\./.test(document.openapi||'')||!document.paths)throw new ApiError('请提供 OpenAPI 3.x JSON 文档。');
 const items=[];
 for(const [path,entry] of Object.entries(document.paths))for(const [m,spec] of Object.entries(entry)){
  if(!['get','post','put','patch','delete','head','options'].includes(m))continue;
  if(spec.servers||entry.servers||spec.callbacks)throw new ApiError('暂不支持操作级 servers/callbacks，请转换为同一 Base URL。');
  const id=(spec.operationId||m+'_'+path.replace(/[^\w]/g,'_')).slice(0,80);if(!/^[\w-]+$/.test(id)||items.some(x=>x.id===id))throw new ApiError('OpenAPI 操作 ID 无效或重复。');
  const properties={},required=[],query={},headers={};let operationPath=path;
  for(const p of [...(entry.parameters||[]),...(spec.parameters||[])]){
   if(p.$ref||!['path','query','header'].includes(p.in)||!p.name||p.name in properties)throw new ApiError('请展开参数引用并使用唯一的 path/query/header 参数。');
   properties[p.name]=p.schema||{type:'string'};if(p.required)required.push(p.name);
   if(p.in==='path')operationPath=operationPath.replaceAll('{'+p.name+'}','{{input.'+p.name+'}}');else (p.in==='query'?query:headers)[p.name]='{{input.'+p.name+'}}';
  }
  let body;if(spec.requestBody){if(spec.requestBody.$ref)throw new ApiError('请展开 requestBody 引用。');const schema=spec.requestBody.content?.['application/json']?.schema;if(!schema)throw new ApiError('OpenAPI 导入目前支持 application/json 请求体。');properties.body=schema;if(spec.requestBody.required)required.push('body');body='{{input.body}}'}
  items.push({id,label:spec.summary||id,method:m.toUpperCase(),path:operationPath,query,headers,...(body?{body}:{}),inputSchema:objectSchema(properties,required)});
 }
 if(!items.length||items.length>80)throw new ApiError('OpenAPI 文档必须包含 1 至 80 个操作。');return items;
}
