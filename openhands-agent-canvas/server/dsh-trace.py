"""Bounded numeric DSH v4 diagnostics. Never emit model, prompt or tool text."""
import base64,json,pathlib,subprocess,sys,time
LIMIT=16*1024*1024
NUMBERS=('inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens')
def integer(v):return isinstance(v,int) and not isinstance(v,bool) and 0<=v<=9007199254740991

def summarize(rows,now):
 steps=[];current=None;tokens={k:0 for k in NUMBERS};metered=unmetered=0;ended=False;last=None
 for row in rows:
  kind=row.get('type');data=row.get('data',{});stamp=row.get('time');last=stamp if integer(stamp) else last
  if kind=='turn/start':ended=False
  elif kind=='turn/end':ended=True
  elif kind=='step/start':
   current={'index':len(steps)+1,'startMs':stamp if integer(stamp) else None,'endMs':None,'toolCallMs':None,'toolResultMs':None,'tool':'none','outputTokens':None,'_calls':{}};steps.append(current)
  elif kind=='assistant/message':
   usage=data.get('usage')
   if isinstance(usage,dict) and integer(usage.get('outputTokens')):
    metered+=1
    for key in NUMBERS:
     value=usage.get(key)
     if tokens[key] is not None:tokens[key]=tokens[key]+value if integer(value) and integer(tokens[key]+value) else None
    if current:current['outputTokens']=(current['outputTokens'] or 0)+usage['outputTokens']
   else:unmetered+=1
  elif kind=='tool/call' and current:
   calls=current['_calls'];identifier=data.get('callId') if isinstance(data.get('callId'),str) else '@'+str(len(calls));name=data.get('name');tool=name if name in ('bash','pwsh','read','write','edit','search','glob','grep') else 'other'
   if identifier not in calls:calls[identifier]={'start':stamp if integer(stamp) else None,'end':None,'tool':tool}
  elif kind=='tool/result' and current:
   calls=current['_calls'];identifier=data.get('callId');pending=[key for key,c in calls.items() if c['end'] is None]
   if identifier not in calls:identifier=pending[0] if len(pending)==1 else None
   if identifier in calls:calls[identifier]['end']=stamp if integer(stamp) else None
  elif kind=='step/end' and current:current['endMs']=stamp if integer(stamp) else None
 def elapsed(a,b):return b-a if integer(a) and integer(b) and b>=a else None
 for step in steps:
  calls=list(step.pop('_calls').values());step['toolCalls']=len(calls);names={c['tool'] for c in calls};step['tool']=next(iter(names)) if len(names)==1 else 'multiple' if names else 'none'
  starts=[c['start'] for c in calls if c['start'] is not None];ends=[c['end'] for c in calls if c['end'] is not None];step['toolCallMs']=min(starts,default=None);step['toolResultMs']=max(ends,default=None)
  intervals=sorted((c['start'],c['end']) for c in calls if elapsed(c['start'],c['end']) is not None);merged=[]
  for start,end in intervals:
   if merged and start<=merged[-1][1]:merged[-1][1]=max(merged[-1][1],end)
   else:merged.append([start,end])
  step['beforeToolMs']=elapsed(step['startMs'],step['toolCallMs']);step['toolMs']=sum(end-start for start,end in merged) if merged else None;step['durationMs']=elapsed(step['startMs'],step['endMs'])
 if metered==0:tokens={k:None for k in NUMBERS}
 active=elapsed(current['startMs'],now) if current and current['endMs'] is None and not ended else None
 return {'stepCount':len(steps),'meteredMessages':metered,'unmeteredMessages':unmetered,'knownTokens':tokens,'usageIsLowerBound':True,'turnEnded':ended,'activeStepMs':active,'maxStepOutputTokens':max((s['outputTokens'] for s in steps if s['outputTokens'] is not None),default=None),'maxBeforeToolMs':max((s['beforeToolMs'] for s in steps if s['beforeToolMs'] is not None),default=None),'knownToolMs':sum(s['toolMs'] or 0 for s in steps),'lastEventMs':last,'steps':steps[-20:]}

def read_log(path):
 if path.is_symlink() or not path.is_file() or path.stat().st_size>LIMIT:raise ValueError('trace-limit')
 child=subprocess.Popen(['/usr/bin/zstd','-dc','--',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 try:
  data=bytearray()
  while chunk:=child.stdout.read(65536):
   data.extend(chunk)
   if len(data)>LIMIT:raise ValueError('trace-limit')
  code=child.wait(timeout=2)
 finally:
  if child.poll() is None:child.kill();child.wait()
  child.stdout.close()
 # A live append can leave an incomplete frame. Only complete JSONL rows count.
 lines=bytes(data).splitlines(keepends=True);rows=[]
 for line in lines:
  if not line.endswith(b'\n'):continue
  value=json.loads(line)
  if not isinstance(value,dict):raise ValueError('invalid-trace')
  rows.append(value)
 if not rows or rows[0].get('type')!='session' or rows[0].get('version')!=4:raise ValueError('unsupported-trace')
 return rows,code==0

def inspect(spec):
 root=pathlib.Path(spec['root']);workspace=pathlib.Path(spec['workspace']);receipt=workspace/'.canvas-collaboration/runtime-selection.json'
 if not root.is_absolute() or root.resolve()!=root or not workspace.is_absolute() or workspace.resolve()!=workspace or receipt.resolve().parent!=workspace/'.canvas-collaboration' or receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_size>16384:return {'available':False,'reason':'binding-unavailable'}
 selection=json.loads(receipt.read_text())
 if any(selection.get(k)!=spec[k] for k in ('requestId','model','effort')) or selection.get('provider')!='deepseek' or selection.get('modelApplied') is not True or selection.get('effortApplied') is not True:return {'available':False,'reason':'binding-mismatch'}
 if any(c not in '/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in str(workspace)):return {'available':False,'reason':'unsupported-workspace'}
 directory=root/('--'+str(workspace).strip('/').replace('/','-')+'--')
 if directory.is_symlink() or not directory.is_dir():return {'available':False,'reason':'trace-not-found'}
 candidates=[]
 for index,entry in enumerate(directory.iterdir()):
  if index>=50:return {'available':False,'reason':'trace-limit'}
  if entry.is_symlink() or not entry.is_dir():continue
  path=entry/'session.v4.jsonl.zstd'
  if path.exists():candidates.append(path)
 # Do not choose by clock or guess which session belongs to a reused workspace.
 if len(candidates)!=1:return {'available':False,'reason':'ambiguous-trace' if candidates else 'trace-not-found'}
 rows,complete=read_log(candidates[0]);header=rows[0]
 if header.get('cwd')!=str(workspace) or header.get('id')!=candidates[0].parent.name:return {'available':False,'reason':'binding-mismatch'}
 return {'available':True,'binding':'unique-workspace-and-request-receipt','traceReadComplete':complete,'observedAtMs':round(time.time()*1000),'summary':summarize(rows,round(time.time()*1000))}

if __name__=='__main__':
 try:result=inspect(json.loads(base64.b64decode(sys.argv[1],validate=True)))
 except Exception:result={'available':False,'reason':'trace-unavailable'}
 print(json.dumps(result,separators=(',',':')))
