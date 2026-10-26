#!/usr/bin/env python3
"""Session-scoped ACP model/effort bridge. Never writes CLI account configuration."""
import argparse,asyncio,json,os,signal,sys,uuid,pathlib,time
parser=argparse.ArgumentParser();parser.add_argument('--provider',required=True,choices=['codex','claude-code','deepseek']);parser.add_argument('--model',default='');parser.add_argument('--effort',default='');parser.add_argument('--request-id',default='');parser.add_argument('--catalog-output',default='');parser.add_argument('command',nargs=argparse.REMAINDER);args=parser.parse_args()
command=args.command[1:] if args.command[:1]==['--'] else args.command
if not command:raise SystemExit('ACP command is required')
if args.effort not in ('','none','low','medium','high','xhigh','max'):raise SystemExit('Invalid reasoning effort')

def options(state):return state.get('configOptions',[]) or []
def option(state,kind):return next((o for o in options(state) if o.get('category')==kind or (kind=='model' and o.get('id')=='model') or (kind=='thought_level' and o.get('id') in ('reasoning_effort','effort'))),None)
def values(items):
 result=[]
 for item in items or []:
  if 'options' in item:result.extend(values(item['options']))
  elif isinstance(item.get('value'),str):result.append({k:item[k] for k in ('value','name','description') if k in item})
 return result

def catalog(state,info):
 model=option(state,'model');thought=option(state,'thought_level');models=values(model.get('options',[])) if model else [{'value':m['modelId'],'name':m.get('name',m['modelId'])} for m in state.get('models',{}).get('availableModels',[]) if isinstance(m.get('modelId'),str)]
 return {'schemaVersion':1,'provider':args.provider,'agent':info,'models':models,'currentModel':model.get('currentValue') if model else state.get('models',{}).get('currentModelId'),'efforts':[v['value'] for v in values(thought.get('options',[]))] if thought else (['low','medium','high','xhigh','max'] if args.provider=='claude-code' else ['low','medium','high','xhigh'] if args.provider=='codex' else []),'effortSource':'acp' if thought else 'process_environment' if args.provider in ('claude-code','codex') else 'unsupported'}

def atomic_json(path,data):
 p=pathlib.Path(path);p.parent.mkdir(parents=True,exist_ok=True);temporary=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp');temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(p)

async def main():
 environment=os.environ.copy()
 if args.provider=='claude-code' and args.effort:environment['CLAUDE_CODE_EFFORT_LEVEL']=args.effort
 if args.provider=='codex' and args.effort:
  config=json.loads(environment.get('CODEX_CONFIG','{}'));config['model_reasoning_effort']=args.effort;environment['CODEX_CONFIG']=json.dumps(config)
 child=await asyncio.create_subprocess_exec(*command,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,env=environment,start_new_session=True,limit=8*1024*1024)
 pending={};sessions={};session_cwds={};prompt_contexts={};usage_totals={};waiters={};agent={};tasks=set();stopped=asyncio.Event();write_lock=asyncio.Lock()
 loop=asyncio.get_running_loop()
 for s in (signal.SIGTERM,signal.SIGINT):loop.add_signal_handler(s,stopped.set)
 async def child_write(message):
  async with write_lock:child.stdin.write((json.dumps(message,separators=(',',':'))+'\n').encode());await child.stdin.drain()
 def parent_write(message):sys.stdout.write(json.dumps(message,separators=(',',':'))+'\n');sys.stdout.flush()
 async def call(method,params):
  rid='canvas-policy-'+uuid.uuid4().hex;future=loop.create_future();waiters[rid]=future
  try:
   await child_write({'jsonrpc':'2.0','id':rid,'method':method,'params':params});reply=await asyncio.wait_for(future,25)
   if 'error' in reply:raise RuntimeError('ACP rejected '+method+' for selected model/effort')
   return reply.get('result',{})
  finally:waiters.pop(rid,None)
 async def configure(reply,context):
  state=reply.get('result',{});sid=state.get('sessionId') or context.get('sessionId');cwd=context.get('cwd');configured=False
  try:
   current=catalog(state,agent)
   if args.catalog_output:atomic_json(args.catalog_output,current)
   if (args.model or args.effort) and not sid:raise RuntimeError('ACP did not return a session')
   if args.model:
    model=option(state,'model')
    if model:
     allowed=[v['value'] for v in values(model.get('options',[]))]
     if allowed and args.model not in allowed:raise RuntimeError('Requested model is not in this server catalog')
     updated=await call('session/set_config_option',{'sessionId':sid,'configId':model['id'],'value':args.model})
    else:updated=await call('session/set_model',{'sessionId':sid,'modelId':args.model})
    state.update(updated);selected=option(state,'model')
    if selected and selected.get('currentValue')!=args.model:raise RuntimeError('ACP model acknowledgement does not match request')
    if state.get('models'):state['models']['currentModelId']=args.model
   thought=option(state,'thought_level');source='acp' if thought else 'process_environment' if args.provider in ('claude-code','codex') else 'unsupported'
   if args.effort:
    if thought:
     if args.effort not in [v['value'] for v in values(thought.get('options',[]))]:raise RuntimeError('Requested thinking depth is not supported by this model')
     updated=await call('session/set_config_option',{'sessionId':sid,'configId':thought['id'],'value':args.effort});state.update(updated);confirmed=option(state,'thought_level')
     if not confirmed or confirmed.get('currentValue')!=args.effort:raise RuntimeError('ACP thinking acknowledgement does not match request')
    elif args.provider not in ('claude-code','codex'):raise RuntimeError('This ACP adapter does not expose thinking controls')
   configured=True
   if cwd and args.model and args.effort:atomic_json(pathlib.Path(cwd)/'.canvas-collaboration'/'runtime-selection.json',{'schemaVersion':1,'requestId':args.request_id,'provider':args.provider,'requestedModel':args.model,'model':args.model,'effort':args.effort,'effortSource':source,'modelApplied':True,'effortApplied':True})
   if args.catalog_output:atomic_json(args.catalog_output,catalog(state,agent))
   if sid:
    sessions[sid]=True
    if cwd:session_cwds[sid]=cwd
   reply['result']=state;parent_write(reply)
  except Exception as error:
   if sid:sessions[sid]=False
   # Do not include child stderr, credentials or provider responses in errors.
   parent_write({'jsonrpc':'2.0','id':reply.get('id'),'error':{'code':-32602,'message':'Canvas model policy: '+str(error)}})
  finally:pending.pop(reply.get('id'),None)
 async def read_child():
  nonlocal agent
  while line:=await child.stdout.readline():
   try:message=json.loads(line)
   except Exception:continue
   rid=message.get('id')
   if rid in prompt_contexts and ('result' in message or 'error' in message):
    sid,started=prompt_contexts.pop(rid);cwd=session_cwds.get(sid)
    if cwd:
     try:
      keys=('totalTokens','inputTokens','cachedReadTokens','cachedWriteTokens','outputTokens','thoughtTokens')
      result=message.get('result') if isinstance(message.get('result'),dict) else {}
      reported=result.get('usage') if isinstance(result.get('usage'),dict) else {}
      valid=lambda v:isinstance(v,int) and not isinstance(v,bool) and 0<=v<=9007199254740991
      tokens={k:reported.get(k) if valid(reported.get(k)) else None for k in keys}
      state=usage_totals.setdefault(sid,{'completedPrompts':0,'elapsedMs':0,'tokens':{k:0 for k in keys}})
      state['completedPrompts']+=1;state['elapsedMs']+=round((time.monotonic()-started)*1000)
      for k in keys:
       a,b=state['tokens'][k],tokens[k];state['tokens'][k]=a+b if a is not None and b is not None and valid(a+b) else None
      stop=result.get('stopReason')
      stop=stop if stop in ('end_turn','max_tokens','max_turn_requests','refusal','cancelled') else 'error' if 'error' in message else 'unknown'
      atomic_json(pathlib.Path(cwd)/'.canvas-collaboration'/'runtime-usage.json',{'schemaVersion':1,'requestId':args.request_id,'provider':args.provider,'model':args.model,'effort':args.effort,'scope':'acp-prompts-including-tools','stopReason':stop,**state})
     except (OSError,ValueError,TypeError):pass
   if rid in waiters:
    if not waiters[rid].done():waiters[rid].set_result(message)
    continue
   if isinstance(message.get('result'),dict) and message['result'].get('agentInfo'):agent=message['result']['agentInfo']
   if rid in pending and 'result' in message:
    task=asyncio.create_task(configure(message,pending[rid]));tasks.add(task);task.add_done_callback(tasks.discard)
   else:parent_write(message)
  stopped.set()
 async def read_parent():
  reader=asyncio.StreamReader(limit=8*1024*1024);await loop.connect_read_pipe(lambda:asyncio.StreamReaderProtocol(reader),sys.stdin)
  while line:=await reader.readline():
   try:message=json.loads(line)
   except Exception:continue
   method=message.get('method');params=message.get('params',{})
   if method in ('session/new','session/load','session/resume'):pending[message.get('id')]=params
   if method=='session/prompt' and (args.model or args.effort) and not sessions.get(params.get('sessionId')):
    parent_write({'jsonrpc':'2.0','id':message.get('id'),'error':{'code':-32602,'message':'Model policy was not confirmed; inference blocked'}});continue
   if method=='session/prompt' and session_cwds.get(params.get('sessionId')):prompt_contexts[message.get('id')]=(params['sessionId'],time.monotonic())
   if method in ('session/set_config_option','session/set_model') and args.provider=='deepseek':
    value=params.get('value',params.get('modelId'));target=args.effort if params.get('configId') in ('reasoning_effort','effort') else args.model
    if target and value!=target:parent_write({'jsonrpc':'2.0','id':message.get('id'),'error':{'code':-32602,'message':'DeepSeek is locked to V4.1 Flash / max'}});continue
   await child_write(message)
  stopped.set()
 readers=[asyncio.create_task(read_child()),asyncio.create_task(read_parent())]
 for reader in readers:reader.add_done_callback(lambda _:stopped.set())
 try:await stopped.wait()
 finally:
  for t in readers+list(tasks):t.cancel()
  for future in waiters.values():
   if not future.done():future.cancel()
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:await asyncio.wait_for(child.wait(),5)
  except asyncio.TimeoutError:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
  await asyncio.gather(*readers,*list(tasks),return_exceptions=True)
asyncio.run(main())
