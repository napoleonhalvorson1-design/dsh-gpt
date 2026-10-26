import {transferWorkspace} from './handoff.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {ApiError,cleanText,validateConfig,upstream,conversation,eventSummary,startConversation} from '../shared/openhands.mjs';
import {validateModelPolicy} from '../shared/model-policy.mjs';
import {validateExecutionPolicy} from './execution-policy.mjs';
import {validateRuntimeContext} from './runtime-context.mjs';
export const ACTIVE=new Set(['queued','running','reconnecting','stopping']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function validateWorkflow(input){
  if(!input||typeof input.title!=='string'||!Array.isArray(input.nodes)||!Array.isArray(input.edges)||input.nodes.length>100||input.edges.length>300)throw new ApiError('工作流格式无效。');
  validateModelPolicy(input);validateRuntimeContext(input.runtimeContext);
  if(input.plannerPolicy!==undefined&&!["strongest","manual"].includes(input.plannerPolicy))throw new ApiError("规划模型策略无效。");
  if(input.coordinationPolicy!==undefined&&!["lean","standard"].includes(input.coordinationPolicy))throw new ApiError("协作开销设置无效。");
  if(input.collaborationMode!==undefined&&!["fixed","adaptive"].includes(input.collaborationMode))throw new ApiError("协作模式无效。");
  if(input.repository&&(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(input.repository)||['.','..'].includes(input.repository.split('/')[1])))throw new ApiError('仓库名称格式应为 owner/repository。');
  if(input.githubConnectionId!==undefined&&!/^[a-zA-Z0-9_-]{1,80}$/.test(input.githubConnectionId))throw new ApiError('GitHub 连接标识无效。');
  if(input.baseRunId!==undefined&&!safeId(input.baseRunId))throw new ApiError('上轮运行标识无效。');
  if(input.baseRunId&&input.nodes.some(n=>n?.id==='_canvas_previous_run_source'))throw new ApiError('继承成果保留 _canvas_previous_run_source 标识。');
  if(input.repository&&input.nodes.some(n=>n?.id==='_canvas_repository_source'))throw new ApiError('仓库运行保留 _canvas_repository_source 标识。');
  const nodes=input.nodes.map(n=>{validateExecutionPolicy(n.executionPolicy);validateRuntimeContext(n.runtimeContext);if((n.executionPolicy||n.runtimeContext)&&['start','end'].includes(n.type))throw new ApiError('执行预算或运行上下文只适用于智能体节点。');if(!safeId(n.id)||!['start','end','planner','research','code','review','custom'].includes(n.type)||typeof n.name!=='string'||!Number.isFinite(n.x)||!Number.isFinite(n.y))throw new ApiError('智能体节点格式无效。');return {...n,name:n.name.slice(0,100),prompt:cleanText(n.prompt,15000),liveModel:cleanText(n.liveModel,160),tools:Array.isArray(n.tools)?n.tools.filter(t=>typeof t==='string').slice(0,15):[],output:typeof n.output==='string'?n.output.slice(0,30000):null}});
  const ids=new Set(nodes.map(n=>n.id));if(ids.size!==nodes.length)throw new ApiError('智能体标识不能重复。');
  const edges=input.edges.map(e=>{if(!Array.isArray(e)||e.length!==2||!e.every(id=>ids.has(id))||e[0]===e[1])throw new ApiError('连接格式无效。');return [e[0],e[1]]});
  const degree=new Map(nodes.map(n=>[n.id,0]));edges.forEach(([,b])=>degree.set(b,degree.get(b)+1));const queue=nodes.filter(n=>!degree.get(n.id)),order=[];
  while(queue.length){const n=queue.shift();order.push(n);for(const [a,b] of edges)if(a===n.id){degree.set(b,degree.get(b)-1);if(!degree.get(b))queue.push(nodes.find(n=>n.id===b))}}
  if(order.length!==nodes.length)throw new ApiError('工作流包含循环连接。');
  return {title:input.title.trim().slice(0,100)||'未命名工作流',nodes,edges,task:cleanText(input.task,20000),baseRunId:input.baseRunId,repository:cleanText(input.repository,160),branch:cleanText(input.branch,150),githubConnectionId:cleanText(input.githubConnectionId,80)||undefined,executionProfile:cleanText(input.executionProfile,80),modelMode:input.modelMode,runtimeContext:input.runtimeContext,reasoningEffort:input.reasoningEffort,taskComplexity:input.taskComplexity,plannerPolicy:input.plannerPolicy,coordinationPolicy:input.coordinationPolicy,collaborationMode:input.collaborationMode,executionMode:input.executionMode==='parallel'?'parallel':'auto',maxParallelNodes:Math.min(5,Math.max(1,Math.floor(Number(input.maxParallelNodes)||5))),maxIterations:Math.min(100,Math.max(1,Number(input.maxIterations)||30)),order};
}
export class Engine {
  constructor(store,{pollMs=3000,maxActive=1,handoffDirectory}={}){this.store=store;this.handoffDirectory=handoffDirectory;this.pollMs=pollMs;this.maxActive=maxActive;this.active=new Set();this.closed=false;this.timer=null}
  start(){this.timer=setInterval(()=>this.tick(),1000);this.tick()}
  close(){this.closed=true;if(this.timer)clearInterval(this.timer)}
  tick(){if(this.closed)return;for(const id of this.store.runnable()){if(this.active.size>=this.maxActive)break;if(this.active.has(id))continue;this.active.add(id);this.execute(id).catch(error=>{const run=this.store.run(id);if(run&&ACTIVE.has(run.status)){run.status='failed';run.error=error.message;for(const node of Object.values(run.nodes||{}))if(node.status==='running')node.status='failed';this.store.saveRun(run);this.log(id,'workflow',error.message)}}).finally(()=>this.active.delete(id))}}
  log(id,nodeId,text,extra={}){this.store.addEvent(id,nodeId,{text,kind:'WorkflowEvent',...extra})}
  enqueue(input,config){
    if(!safeId(input.id)||!safeId(input.projectId))throw new ApiError('项目或运行标识无效。');
    const old=this.store.run(input.id);if(old)return old;if(!this.store.project(input.projectId))throw new ApiError('请先保存项目再运行。',404);
    const busy=this.store.listRuns(input.projectId).find(r=>ACTIVE.has(r.status));if(busy)throw new ApiError('这个项目已有后台运行中的任务，请先查看或停止它。',409);
    const flow=validateWorkflow(input.workflow);if(!flow.task)throw new ApiError('请填写本次任务。');
    const reachable=new Set(flow.nodes.filter(n=>n.type==='start').map(n=>n.id));for(const n of flow.order)if(flow.edges.some(([a,b])=>b===n.id&&reachable.has(a)))reachable.add(n.id);
    const agents=flow.order.filter(n=>!['start','end'].includes(n.type));if(!agents.length||agents.length>12||agents.some(n=>!reachable.has(n.id)))throw new ApiError('请连接 1 至 12 个智能体，并确保它们都能从起点到达。');
    if(config.mode==='demo')throw new ApiError('真实后台运行需要连接 OpenHands。',409);
    const run={id:input.id,projectId:input.projectId,title:flow.title,status:'queued',workflow:flow,order:agents.map(n=>n.id),index:0,workspace:config.workspace.replace(/\/$/,'')+'/runs/'+input.id,workspaceReady:false,sandboxId:null,cancelRequested:false,error:null,nodes:Object.fromEntries(agents.map(n=>[n.id,{id:n.id,name:n.name,status:'pending',conversationId:randomUUID(),handle:null,output:'',cursor:null,since:null,fatal:null,profileId:(config.nodeConfigs?.[n.id]||config).profileId||'custom',profileLabel:(config.nodeConfigs?.[n.id]||config).profileLabel||'',server:(config.nodeConfigs?.[n.id]||config).server||'',workspace:(config.nodeConfigs?.[n.id]||config).workspace.replace(/\/$/,'')+'/runs/'+input.id,modelUsed:n.liveModel||(config.nodeConfigs?.[n.id]||config).acpModel||(config.nodeConfigs?.[n.id]||config).model}]))};
    for(const node of Object.values(run.nodes)){const resolved=config.nodeConfigs?.[node.id]||config;if(resolved.runtimeContext)node.runtimeContextRequested=resolved.runtimeContext;const selected=resolved.selection;if(selected){node.modelSelection=selected;node.modelRequested=selected.model;node.reasoningEffort=selected.effort;node.modelUsed=selected.model}}delete run.workflow.order;this.store.createRun(run,config);this.log(run.id,'workflow','任务已进入服务器队列。关闭页面后仍会继续执行。');this.tick();return this.store.run(run.id);
  }
  stop(id){const run=this.store.run(id);if(!run)throw new ApiError('运行记录不存在。',404);if(!ACTIVE.has(run.status)&&run.status!=='awaiting_input'&&!(run.status==='failed'&&run.cancelRequested))return run;run.cancelRequested=true;if(run.status==='queued'&&!this.active.has(id)){run.status='cancelled';this.log(id,'workflow','排队中的任务已取消，未调用模型。')}else run.status='stopping';return this.store.saveRun(run)}
  async resume(id,config){const run=this.store.run(id);if(!run)throw new ApiError('运行记录不存在。',404);if(ACTIVE.has(run.status))return run;if(run.status==='succeeded')throw new ApiError('此工作流已完成，请创建新的运行。',409);const currentNodeId=run.order[run.index],oldBundle=this.store.config(id),nextNodeConfig=config.nodeConfigs?.[currentNodeId]||config,oldNodeConfig=oldBundle.nodeConfigs?.[currentNodeId]||oldBundle;if(nextNodeConfig.baseUrl!==oldNodeConfig.baseUrl)throw new ApiError('请连接此任务原来的后端后再重试。',409);this.store.setConfig(id,config);config=nextNodeConfig;const n=run.nodes[run.order[run.index]];if(n&&n.status!=='succeeded'){let info;try{info=await conversation(config,n.handle?.conversationId||n.conversationId)}catch(e){if(e.status!==404)throw e}if(info&&['finished','error','stuck'].includes(info.execution_status)){n.conversationId=randomUUID();n.handle=null;n.output='';n.cursor=null;n.since=null;n.fatal=null}if(info?.execution_status==='paused'&&config.mode==='remote'){try{await upstream(config,'/api/conversations/'+n.conversationId+'/run',{method:'POST',allowEmpty:true})}catch(e){if(e.status!==409)throw e}}n.status='pending'}run.error=null;run.cancelRequested=false;run.status='queued';this.store.saveRun(run,{resetCancel:true});this.log(id,'workflow','已请求从未完成的节点继续；已完成节点不会重复执行。');this.tick();return this.store.run(id)}
  async pullEvents(run,node,config){
    const query=new URLSearchParams({limit:'100',sort_order:'TIMESTAMP'});if(node.cursor)query.set('page_id',node.cursor);else if(node.since)query.set('timestamp__gte',node.since);
    const path=(config.mode==='cloud'?'/api/v1/conversation/':'/api/conversations/')+node.handle.conversationId+'/events/search?'+query;
    const page=await upstream(config,path);
    for(const raw of page.items||[]){if(raw.timestamp&&(!node.since||raw.timestamp>node.since))node.since=raw.timestamp;const event=eventSummary(raw,config);if(!event)continue;this.store.addEvent(run.id,node.id,event);if(event.output&&event.text&&!node.output.includes(event.text)){node.output=(node.output?node.output+'\n\n':'')+event.text;node.output=node.output.slice(-120000)}if(event.fatal)node.fatal=event.text}
    node.cursor=page.next_page_id||null;this.store.saveRun(run);return !!node.cursor;
  }
  async pauseBackend(run,node,config){
    let confirmations=0,lastRequest=0,attempts=0;
    while(!this.closed){
      const saved=this.store.config(run.id);config=saved?.nodeConfigs?.[node.id]||saved||config;
      try{
        if(Date.now()-lastRequest>Math.max(50,Math.min(5000,this.pollMs*2))){
          if(config.mode==='remote'){
            try{await upstream(config,'/api/conversations/'+node.conversationId+'/interrupt',{method:'POST',allowEmpty:true})}
            catch(error){if(![404,405].includes(error.status))throw error;await upstream(config,'/api/conversations/'+node.conversationId+'/pause',{method:'POST',allowEmpty:true})}
          }else{let sandboxId=run.sandboxId;if(!sandboxId&&node.handle?.kind==='start-task'){const tasks=await upstream(config,'/api/v1/app-conversations/start-tasks?ids='+node.handle.id);sandboxId=tasks[0]?.sandbox_id}if(!sandboxId)throw new ApiError('云端仍在启动，正在等待可停止的沙箱。',409);await upstream(config,'/api/v1/sandboxes/'+sandboxId+'/pause',{method:'POST',allowEmpty:true})}
          lastRequest=Date.now();
        }
        const info=await conversation(config,node.handle?.conversationId||node.conversationId),stopped=['paused','finished','error','stuck','idle'].includes(info.execution_status)||info.sandbox_status==='PAUSED';
        confirmations=stopped?confirmations+1:0;
        if(confirmations>=2){run.status='cancelled';node.status='paused';run.error=null;this.store.saveRun(run);this.log(run.id,'workflow','后端已确认任务停止，后续节点不会启动。');return}
        run.error=attempts>10?'后端仍在处理停止请求，服务器会继续跟踪。':null;
      }catch(error){confirmations=0;run.error='停止请求尚未确认，服务器会自动重试。请勿将此状态视为已停止。';if(attempts===0)this.log(run.id,'workflow',run.error)}
      attempts++;run.status='stopping';this.store.saveRun(run);await sleep(Math.max(50,Math.min(1000,this.pollMs)));
    }
  }
  async persistStage(run,node,config){if(!this.storage?.config().enabled)return;const checkpoint=await this.storage.checkpoint(run,node,config);if(checkpoint&&node.checkpoint?.key!==checkpoint.key){node.checkpoint=checkpoint;this.store.saveRun(run);this.log(run.id,node.id,'阶段文件已保存到对象存储。',{success:true})}}
  async execute(id){
    let run=this.store.run(id),rootConfig=this.store.config(id);if(!run)return;
    if(run.status!=='stopping'){run.status='running';this.store.saveRun(run)}
    for(;run.index<run.order.length;run.index++){
      if(this.closed)return;run.cancelRequested=this.store.run(id).cancelRequested;const node=run.nodes[run.order[run.index]],config=rootConfig.nodeConfigs?.[node.id]||rootConfig;if(node.status==='succeeded'){if(run.cancelRequested){run.status='cancelled';this.store.saveRun(run);this.log(id,'workflow','已完成阶段保留，后续节点已停止。');return}await this.persistStage(run,node,config);continue}const definition=run.workflow.nodes.find(n=>n.id===node.id);node.workspace??=config.workspace.replace(/\/$/,'')+'/runs/'+id;const agentConfig={...config,workspace:node.workspace};if(!node.workspaceReady&&config.mode==='remote'){await upstream(config,'/api/file/create_directory?'+new URLSearchParams({path:node.workspace}),{method:'POST',allowEmpty:true});node.workspaceReady=true;this.store.saveRun(run)}
      if(run.cancelRequested&&!node.handle){run.status='cancelled';this.store.saveRun(run);this.log(id,'workflow','工作流已停止，未开始的节点已取消。');return}
      node.status='running';node.startedAt??=new Date().toISOString();this.store.saveRun(run);
      if(!node.handle){
        let existing=null;try{existing=await conversation(config,node.conversationId)}catch(error){if(error.status!==404)throw error}
        if(existing)node.handle={kind:'conversation',id:existing.id,conversationId:existing.id};
        else {
          if(!node.handoffReady&&run.index>0){const previous=run.nodes[run.order[run.index-1]],source=rootConfig.nodeConfigs?.[previous.id]||rootConfig;if(source.baseUrl!==config.baseUrl||previous.workspace!==node.workspace){this.log(id,node.id,'正在交接上一个智能体生成的文件。');await transferWorkspace({runId:id,nodeId:node.id,source,target:config,sourceWorkspace:previous.workspace||run.workspace,targetWorkspace:node.workspace,directory:this.handoffDirectory,sourceArchive:previous.checkpoint&&this.storage?.config().enabled?await this.storage.restoreCheckpoint(previous.checkpoint):undefined,onProgress:count=>this.log(id,node.id,'已完成跨服务器文件交接：'+count+' 个文件。')})}node.handoffReady=true;this.store.saveRun(run)}
          const parents=run.workflow.edges.filter(([,b])=>b===node.id).map(([a])=>run.nodes[a]).filter(n=>n?.output).map(n=>'【'+n.name+' 的交接信息】\n'+n.output.slice(-25000)).join('\n\n');
          const prompt='用户任务：\n'+run.workflow.task+'\n\n你的职责：\n'+definition.prompt+(parents?'\n\n'+parents:'')+'\n\n工作目录：'+node.workspace+'。只处理你负责的阶段，保留其他阶段的产物。完成后给出结果与文件路径。';
          this.log(id,node.id,'正在向 OpenHands 提交任务。');
          try{node.handle=await startConversation(agentConfig,{conversationId:node.conversationId,prompt,system:definition.prompt,model:definition.liveModel,temperature:definition.temperature,tools:definition.tools,repository:run.workflow.repository,branch:run.workflow.branch,sandboxId:run.sandboxId,maxIterations:run.workflow.maxIterations})}
          catch(error){let recovered=null;try{recovered=await conversation(config,node.conversationId)}catch{}if(recovered)node.handle={kind:'conversation',id:recovered.id,conversationId:recovered.id};else throw error}
        }this.store.saveRun(run);
      }
      let reconnects=0;
      for(;;){
        if(this.closed)return;run.cancelRequested=this.store.run(id).cancelRequested;
        if(run.cancelRequested){run.status='stopping';this.store.saveRun(run);await this.pauseBackend(run,node,config);return}
        try{
          if(node.handle.kind==='start-task'){const tasks=await upstream(config,'/api/v1/app-conversations/start-tasks?ids='+node.handle.id),task=Array.isArray(tasks)?tasks[0]:tasks;if(task.status==='ERROR')throw new ApiError(task.detail||'云端启动失败。',400);if(task.sandbox_id)run.sandboxId=task.sandbox_id;if(task.status!=='READY'||!task.app_conversation_id){this.store.saveRun(run);await sleep(this.pollMs);continue}node.handle={kind:'conversation',id:task.app_conversation_id,conversationId:task.app_conversation_id};this.store.saveRun(run)}
          const info=await conversation(config,node.handle.conversationId);if(info.current_model_id)node.modelUsed=info.current_model_id;if(info.sandbox_id)run.sandboxId=info.sandbox_id;let more=await this.pullEvents(run,node,config);for(let page=0;page<10&&more;page++)more=await this.pullEvents(run,node,config);if(more)continue;
          if(node.fatal)throw new ApiError(node.fatal,400);
          if(['ERROR','MISSING'].includes(info.sandbox_status))throw new ApiError('执行沙箱不可用：'+info.sandbox_status,400);
          if(info.execution_status==='finished'){if(!node.output.trim())throw new ApiError('模型没有返回可用的文本结果，请检查后端配置。',400);node.status='succeeded';node.finishedAt=new Date().toISOString();this.log(id,node.id,'节点执行完成。',{success:true});break}
          if(['error','stuck'].includes(info.execution_status))throw new ApiError(node.output||'智能体执行失败：'+info.execution_status,400);
          if(['waiting_for_confirmation','paused'].includes(info.execution_status)){run.status='awaiting_input';node.status='paused';run.error='后端正在等待确认或补充输入。处理后可继续此工作流。';this.store.saveRun(run);this.log(id,node.id,run.error);return}
          reconnects=0;run.status='running';this.store.saveRun(run);await sleep(this.pollMs);
        }catch(error){if(error.status>=500&&reconnects++<12){run.status='reconnecting';run.error='连接暂时中断，服务器会自动恢复同步。';this.store.saveRun(run);if(reconnects===1)this.log(id,node.id,run.error);await sleep(Math.min(15000,2000*reconnects));continue}node.status='failed';run.status='failed';run.error=error.message;for(const node of Object.values(run.nodes||{}))if(node.status==='running')node.status='failed';this.store.saveRun(run);this.log(id,node.id,error.message,{error:true});return}
      }
      run.error=null;this.store.saveRun(run);await this.persistStage(run,node,config);
    }
    run.status='succeeded';run.finishedAt=new Date().toISOString();this.store.saveRun(run);this.log(id,'workflow',this.storage?.config().enabled?'所有节点已真实完成，阶段文件已保存到对象存储，运行记录自动同步。':'所有节点已真实完成。产物和记录已保存在服务器。',{success:true});
  }
}
