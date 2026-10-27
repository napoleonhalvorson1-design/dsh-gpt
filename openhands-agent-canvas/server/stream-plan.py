"""Capture only explicitly frozen files while their coordinator keeps working."""
import base64,gzip,hashlib,io,json,os,pathlib,stat,sys,tarfile,uuid
def main(spec):
 os.umask(0o077);root=pathlib.Path(spec['root']);workspace=pathlib.Path(spec['workspace']);run=spec['runId'];request=spec['requestId']
 valid=lambda s:isinstance(s,str) and 1<=len(s)<=100 and all(c.isascii() and (c.isalnum() or c in '_-') for c in s)
 if not valid(run) or not valid(request) or workspace.parent!=root/'runs'/run:raise ValueError('workspace')
 for p in [workspace,*workspace.parents]:
  if p.is_symlink():raise ValueError('workspace link')
 def read(relative,limit):
  p=pathlib.PurePosixPath(relative)
  if p.is_absolute() or any(x in ('','..','.') for x in relative.split('/')) or '\\' in relative:raise ValueError('path')
  fd=os.open(workspace,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:
   for part in p.parts[:-1]:
    next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=next_fd
   file=os.open(p.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   with os.fdopen(file,'rb') as f:
    info=os.fstat(f.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('size or type')
    value=f.read(limit+1)
    if len(value)>limit:raise ValueError('size')
    return value,0o755 if info.st_mode&0o111 else 0o644
  finally:os.close(fd)
 try:marker_bytes,_=read('.canvas-collaboration/plan-commit.json',32768)
 except FileNotFoundError:return {'available':False}
 marker=json.loads(marker_bytes)
 if marker.get('schemaVersion')!=1 or marker.get('requestId')!=request or not isinstance(marker.get('files'),dict) or len(marker['files'])>20:raise ValueError('marker')
 plan,_=read('.canvas-collaboration/plan.json',131072)
 if hashlib.sha256(plan).hexdigest()!=marker.get('planSha256'):raise ValueError('plan hash')
 policy,_=read('.canvas-collaboration/runtime-selection.json',16384);selection=json.loads(policy)
 if selection.get('requestId')!=request or selection.get('model')!=spec['model'] or selection.get('effort')!=spec['effort'] or selection.get('modelApplied') is not True or selection.get('effortApplied') is not True:raise ValueError('selection')
 files={'.canvas-collaboration/plan.json':(plan,0o644),'.canvas-collaboration/runtime-selection.json':(policy,0o644)};frozen=[];total=0
 for path,expected in marker['files'].items():
  if not isinstance(path,str) or path.startswith(('.canvas-collaboration/','.git/')) or path=='.git' or any(ord(c)<32 or ord(c)==127 for c in path):raise ValueError('reserved path')
  data,mode=read(path,32*1024*1024);total+=len(data)
  if total>32*1024*1024 or hashlib.sha256(data).hexdigest()!=expected:raise ValueError('file hash')
  files[path]=(data,mode);frozen.append({'path':path,'sha256':expected,'mode':mode})
 folder=root/'runs'/run/'.canvas-stream-plans'
 if folder.is_symlink():raise ValueError('archive directory')
 folder.mkdir(mode=0o700,exist_ok=True)
 temporary=folder/(uuid.uuid4().hex+'.part')
 try:
  with open(temporary,'wb') as output,gzip.GzipFile(filename='',fileobj=output,mode='wb',mtime=0) as gz,tarfile.open(fileobj=gz,mode='w') as tar:
   for path,(data,mode) in sorted(files.items()):
    info=tarfile.TarInfo(run+'/'+path);info.mode=mode;info.size=len(data);tar.addfile(info,io.BytesIO(data))
  sha=hashlib.sha256(temporary.read_bytes()).hexdigest();destination=folder/(sha+'.tar.gz');temporary.replace(destination)
 finally:temporary.unlink(missing_ok=True)
 return {'available':True,'requestId':request,'archive':str(destination),'archiveSha256':sha,'size':destination.stat().st_size,'markerSha256':hashlib.sha256(marker_bytes).hexdigest(),'planSha256':marker['planSha256'],'files':frozen}
if __name__=='__main__':
 try:print(json.dumps(main(json.loads(base64.b64decode(sys.argv[1])))))
 except Exception:print(json.dumps({'available':False,'reason':'invalid-commit'}))
