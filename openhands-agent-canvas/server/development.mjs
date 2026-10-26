import {readFileSync} from 'node:fs';
import {ApiError} from '../shared/openhands.mjs';
import {validateModelPolicy} from '../shared/model-policy.mjs';
import {validateWorkflow} from './serial-engine.mjs';
const template=JSON.parse(readFileSync(new URL('../shared/five-ai-workflow.json',import.meta.url),'utf8'));
export function createDevelopmentProject(store,profiles,input){
 validateModelPolicy(input);
 if(typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)||typeof input.title!=='string'||!input.title.trim()||input.title.length>100||typeof input.task!=='string'||!input.task.trim()||input.task.length>20000)throw new ApiError('请提供有效的项目 ID、项目名称和开发需求。');
 const required=['deepseek-shanghai','codex-shanghai','codex-silicon','codex-seoul','claude-silicon'],missing=required.filter(id=>!profiles.entries.has(id));if(missing.length)throw new ApiError('五 AI 团队尚未配置完整：'+missing.join('、'),409);
 const title=input.title.trim(),task=input.task.trim(),old=store.project(input.id),source={};for(const key of ['repository','branch','githubConnectionId','runtimeContext'])if(input[key]!==undefined){if(typeof input[key]!=='string')throw new ApiError('仓库连接、分支与运行上下文须为文本。');source[key]=input[key].trim()}
 const state={...structuredClone(template),...source,title,task,modelMode:input.modelMode||'auto',reasoningEffort:input.reasoningEffort||'auto',projectId:input.id};validateWorkflow(state);
 if(old){if(old.state.title!==title||old.state.task!==task||Object.keys(source).some(k=>(old.state[k]||'')!==source[k])||(input.modelMode!==undefined&&old.state.modelMode!==input.modelMode)||(input.reasoningEffort!==undefined&&old.state.reasoningEffort!==input.reasoningEffort))throw new ApiError('此项目 ID 已被其他内容使用，请读取已有项目或使用新的 ID。',409);return old}
 return store.putProject(input.id,state,0);
}
