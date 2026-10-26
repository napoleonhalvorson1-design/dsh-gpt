import {ApiError} from '../shared/openhands.mjs';

export function validateRuntimeContext(value){
 if(value!==undefined&&!['inherit','focused'].includes(value))throw new ApiError('运行上下文须为 inherit 或 focused。');
}
export function compileRuntimeContext(config,node={},flow={}){
 const mode=flow.runtimeContext??node.runtimeContext;validateRuntimeContext(mode);
 if(mode===undefined)return config;
 if(mode==='focused'&&(config.mode!=='remote'||config.model!=='acp:codex'||config.runtimeContextVersion!==1||!config.selection?.verified))throw new ApiError('此入口尚未验证精简运行上下文及模型策略，请使用 inherit。',409);
 return {...config,runtimeContext:mode};
}
