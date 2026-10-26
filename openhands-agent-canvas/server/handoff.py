import sys,tarfile,json,posixpath,hashlib,io,os,shutil,tempfile,atexit,gzip

# Keep aggregate payload memory bounded across the common base and every parent.
# Larger content shares one spool file per archive; comparisons use size + SHA-256.
scratch=tempfile.TemporaryDirectory(prefix='canvas-merge-');atexit.register(scratch.cleanup)
memory_used=0;MEMORY_LIMIT=8*1024*1024
class Content:
 def __init__(self,size,sha,data=None,path=None,offset=0,mode=0o644):self.size=size;self.sha=sha;self.data=data;self.path=path;self.offset=offset;self.mode=mode
 def __len__(self):return self.size
 def __hash__(self):return hash((self.size,self.sha,self.mode))
 def __eq__(self,other):return isinstance(other,Content) and self.size==other.size and self.sha==other.sha and self.mode==other.mode
 def open(self):
  if self.data is not None:return io.BytesIO(self.data)
  file=open(self.path,'rb');file.seek(self.offset);return file
 def read(self):
  with self.open() as file:return file.read(self.size)
def raw(value):return value.read() if isinstance(value,Content) else value

def safe(name):
 return bool(name) and not name.startswith('/') and not any(x in ('.','..','') for x in name.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in name)

def load(archive,root,protocol=True):
 global memory_used
 files={};total=0;seen=set();spool_path=os.path.join(scratch.name,str(len(os.listdir(scratch.name))))
 with open(spool_path,'wb') as spool,tarfile.open(archive,'r:gz') as tar:
  for m in tar:
   name=m.name.rstrip('/')
   if not safe(name):raise RuntimeError('Unsafe archive path')
   if name==root:continue
   if not name.startswith(root+'/'):
    if name=='archive_manifest.json':continue
    raise RuntimeError('Unexpected archive root')
   name=name[len(root)+1:]
   if name in seen:raise RuntimeError('Duplicate archive path')
   seen.add(name)
   if m.isdir():continue
   if not m.isfile():raise RuntimeError('Unsupported archive entry')
   if name=='archive_manifest.json' or (not protocol and name.startswith('.canvas-collaboration/')):continue
   if m.size>32*1024*1024:raise RuntimeError('A file exceeds the 32 MiB transfer limit')
   total+=m.size
   if total>128*1024*1024 or len(files)>=5000:raise RuntimeError('Workspace transfer is too large')
   source=tar.extractfile(m);h=hashlib.sha256();count=0
   if m.size<=65536 and memory_used+m.size<=MEMORY_LIMIT:
    data=source.read();count=len(data);h.update(data);memory_used+=count;files[name]=Content(count,h.hexdigest(),data=data,mode=0o755 if m.mode&0o111 else 0o644)
   else:
    offset=spool.tell()
    for chunk in iter(lambda:source.read(1024*1024),b''):count+=len(chunk);h.update(chunk);spool.write(chunk)
    files[name]=Content(count,h.hexdigest(),path=spool_path,offset=offset,mode=0o755 if m.mode&0o111 else 0o644)
   if count!=m.size:raise RuntimeError('Truncated archive member')
 return files

def write(path,root,files):
 if sum(map(len,files.values()))>128*1024*1024 or len(files)>5000:raise RuntimeError('Merged workspace is too large')
 part=path+'.part'
 with open(part,'wb') as output,gzip.GzipFile(filename='',mode='wb',fileobj=output,mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w') as tar:
  info=tarfile.TarInfo(root+'/');info.type=tarfile.DIRTYPE;info.mode=0o755;tar.addfile(info)
  for name,data in sorted(files.items()):
   if not safe(name):raise RuntimeError('Unsafe output path')
   info=tarfile.TarInfo(root+'/'+name);info.size=len(data);info.mode=getattr(data,'mode',0o644)
   with data.open() if isinstance(data,Content) else io.BytesIO(data) as source:tar.addfile(info,source)
 os.replace(part,path)

def digest(data):return data.sha if isinstance(data,Content) else hashlib.sha256(data).hexdigest() if data is not None else None
mode=sys.argv[1];archive=sys.argv[2]
if mode=='normalize':
 files=load(archive,sys.argv[3]);write(sys.argv[4],sys.argv[5],files)
elif mode=='repository':
 roots=set();entries=0
 with tarfile.open(archive,'r:gz') as tar:
  for member in tar:
   entries+=1
   if entries>15000 or not safe(member.name.rstrip('/')):raise RuntimeError('Unsafe repository archive')
   roots.add(member.name.split('/')[0])
 if len(roots)!=1:raise RuntimeError('Repository archive must have one root')
 files=load(archive,next(iter(roots)),False);write(sys.argv[3],sys.argv[4],files);print(json.dumps({'files':len(files),'bytes':sum(map(len,files.values()))}))
elif mode=='merge':
 spec=json.load(sys.stdin);root=spec['runId'];base=load(spec['base'],root,False) if spec.get('base') else {};parents={p['id']:load(p['archive'],root,False) for p in spec['parents']};out={};conflicts=[]
 for path in sorted(set(base).union(*(set(f) for f in parents.values()))):
  original=base.get(path);versions={k:f.get(path) for k,f in parents.items()};changed={k:v for k,v in versions.items() if v!=original};unique=set(changed.values())
  if not changed:
   if original is not None:out[path]=original
  elif len(unique)==1:
   value=next(iter(unique))
   if value is not None:out[path]=value
  else:
   variants=[]
   for k,value in versions.items():
    target='.canvas-collaboration/inputs/'+k+'/'+path
    if value is not None:out[target]=value
    variants.append({'parent':k,'sha256':digest(value),'deleted':value is None,'path':target if value is not None else None})
   if original is not None:out['.canvas-collaboration/base/'+path]=original
   conflicts.append({'path':path,'baseSha256':digest(original),'variants':variants})
 # File/directory collisions cannot be represented in a filesystem. Preserve every candidate separately.
 paths=sorted(p for p in out if not p.startswith('.canvas-collaboration/'))
 structural=set()
 for path in paths:
  bits=path.split('/')
  for i in range(1,len(bits)):
   prefix='/'.join(bits[:i])
   if prefix in out:structural.update((prefix,path))
 for path in sorted(structural):
  value=out.pop(path);target='.canvas-collaboration/structural/'+hashlib.sha256(path.encode()).hexdigest();out[target]=value
  conflicts.append({'path':path,'structural':True,'variants':[{'parent':'merged','sha256':digest(value),'deleted':False,'path':target}]})
 report={'schemaVersion':1,'runId':root,'nodeId':spec['nodeId'],'base':spec.get('baseId'),'parents':[p['id'] for p in spec['parents']],'conflicts':conflicts,'sources':spec.get('sources',[]),'lineage':spec.get('lineage',[]),'scheduler':spec.get('scheduler')}
 if spec.get('repository'):report['repository']=spec['repository']
 if spec.get('sourceRun'):report['sourceRun']=spec['sourceRun']
 out['.canvas-collaboration/handoff.json']=(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode()
 write(archive,root,out);print(json.dumps(report))
elif mode=='plan':
 files=load(archive,sys.argv[3]);raw=files.get('.canvas-collaboration/plan.json')
 if not raw or len(raw)>128*1024:raise RuntimeError('Missing or oversized .canvas-collaboration/plan.json')
 print(json.dumps(json.loads(raw.read())))
elif mode=='validate':
 files=load(archive,sys.argv[3]);report=json.load(sys.stdin);conflicts=report.get('conflicts',[])
 if report.get('selection'):
  selection=report['selection'];receipt=json.loads(raw(files.get('.canvas-collaboration/runtime-selection.json',b'{}')))
  if any(receipt.get(k)!=selection[k] for k in ('model','effort','requestId')) or receipt.get('modelApplied') is not True or receipt.get('effortApplied') is not True:raise RuntimeError('Model/thinking policy was not confirmed for this conversation')
 if conflicts:
  resolution_file=files.get('.canvas-collaboration/resolutions.json')
  if not resolution_file:raise RuntimeError('Conflicting files require .canvas-collaboration/resolutions.json')
  resolutions=json.loads(raw(resolution_file)).get('resolutions',{})
  for conflict in conflicts:
   path=conflict['path'];resolution=resolutions.get(path)
   if not isinstance(resolution,dict) or not str(resolution.get('reason','')).strip():raise RuntimeError('Every conflict requires a resolution and reason: '+path)
   value=files.get(path);actual=digest(value)
   if resolution.get('sha256')!=actual:raise RuntimeError('Resolution checksum mismatch: '+path)
   source=resolution.get('source')
   if source=='delete':
    if value is not None:raise RuntimeError('Deleted file still exists: '+path)
   elif source=='base':
    if actual!=conflict.get('baseSha256'):raise RuntimeError('Base resolution mismatch')
   elif source=='custom':
    if value is None:raise RuntimeError('Custom resolution file missing')
   else:
    variant=next((v for v in conflict['variants'] if v['parent']==source),None)
    if not variant or actual!=variant['sha256']:raise RuntimeError('Unknown or mismatched branch resolution')
 usage=None
 # Optional telemetry must never invalidate otherwise valid deliverables.
 try:
  record=files.get('.canvas-collaboration/runtime-usage.json')
  data=json.loads(raw(record)) if record and len(record)<=32768 else {}
  valid=lambda v:isinstance(v,int) and not isinstance(v,bool) and 0<=v<=9007199254740991
  expected=report.get('selection') or {}
  if expected and isinstance(data,dict) and data.get('schemaVersion')==1 and all(data.get(k)==expected[k] for k in ('requestId','model','effort')) and data.get('scope')=='acp-prompts-including-tools' and valid(data.get('elapsedMs')) and valid(data.get('completedPrompts')) and 0<data['completedPrompts']<=1000:
   tokens=data.get('tokens') if isinstance(data.get('tokens'),dict) else {}
   usage={k:data[k] for k in ('schemaVersion','requestId','model','effort','scope','elapsedMs','completedPrompts')}
   usage['stopReason']=data.get('stopReason') if data.get('stopReason') in ('end_turn','max_tokens','max_turn_requests','refusal','cancelled','error') else 'unknown'
   usage['tokens']={k:tokens.get(k) if valid(tokens.get(k)) else None for k in ('totalTokens','inputTokens','cachedReadTokens','cachedWriteTokens','outputTokens','thoughtTokens')}
 except (ValueError,TypeError,KeyError):pass
 print(json.dumps({'ok':True,'conflictsResolved':len(conflicts),'modelUsage':usage}))
elif mode in ('inspect','export'):
 # Legacy transfer API exposes blocked links, rather than following them.
 with tarfile.open(archive,'r:gz') as tar:
  prefix=sys.argv[3]+'/';items=[];blocked=[];total=0;seen=set()
  for m in tar:
   if not m.name.startswith(prefix):continue
   name=m.name[len(prefix):].rstrip('/')
   if not name:continue
   if not safe(name):raise RuntimeError('Unsafe archive path')
   if name in seen:raise RuntimeError('Duplicate archive path')
   seen.add(name)
   if m.issym() or m.islnk():blocked.append(name);continue
   if not m.isfile() or name=='archive_manifest.json':continue
   if m.size>32*1024*1024:raise RuntimeError('A file exceeds the 32 MiB transfer limit')
   total+=m.size
   if total>128*1024*1024 or len(items)>=5000:raise RuntimeError('Workspace transfer is too large')
   items.append({'path':name,'size':m.size})
   if mode=='export':
    target=os.path.join(sys.argv[4],*name.split('/'));os.makedirs(os.path.dirname(target),mode=0o700,exist_ok=True)
    with open(target,'xb') as output:
     os.chmod(target,0o600)
     with tar.extractfile(m) as source:shutil.copyfileobj(source,output,1024*1024)
  print(json.dumps({'items':items,'blocked':blocked,'total':total}))
elif mode=='read':
 member=sys.argv[3]
 if not safe(member):raise RuntimeError('Unsafe archive member')
 with tarfile.open(archive,'r:gz') as tar:
  m=tar.getmember(member)
  if not m.isfile() or m.size>32*1024*1024:raise RuntimeError('Unsupported archive member')
  file=tar.extractfile(m)
  while True:
   chunk=file.read(65536)
   if not chunk:break
   sys.stdout.buffer.write(chunk)
else:raise RuntimeError('Unknown archive operation')
