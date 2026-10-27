#!/usr/bin/env python3
"""Durable, request-bound native command execution. No model or account access."""
import base64,hashlib,json,os,pathlib,select,signal,subprocess,sys,time,uuid

def atomic(path,value):
 temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp');temp.write_text(json.dumps(value));temp.chmod(0o600);temp.replace(path)
def fingerprint(pid):
 try:
  parts=pathlib.Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()
  return parts[19] if parts[0] not in ('Z','X','x') else None
 except (OSError,IndexError):return None
def alive(state):return state.get('pid') and fingerprint(state['pid'])==state.get('pidStart')
def terminate(process):
 if process.poll() is None:
  try:os.killpg(process.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:process.wait(timeout=1)
  except subprocess.TimeoutExpired:
   try:os.killpg(process.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   process.wait()
def main(spec):
 os.umask(0o077)
 root=pathlib.Path(spec['root']);workspace=pathlib.Path(spec['workspace']);run=spec['runId'];request=spec['requestId']
 valid=lambda s:isinstance(s,str) and 1<=len(s)<=100 and all(c.isascii() and (c.isalnum() or c in '_-') for c in s)
 if not valid(run) or not valid(request) or workspace.parent!=root/'runs'/run or not workspace.name.startswith('delivery-check-'):raise ValueError('Invalid check workspace')
 for p in [workspace,*workspace.parents]:
  if p.is_symlink():raise ValueError('Check workspace must not contain links')
 if not workspace.is_dir():raise ValueError('Check workspace missing')
 folder=root/'runs'/run/'.canvas-delivery-checks'/request
 for p in [folder.parent,folder]:
  if p.is_symlink():raise ValueError('Invalid receipt directory')
 folder.mkdir(parents=True,exist_ok=True,mode=0o700)
 claim=folder/'claim.json';state_path=folder/'state.json';cancel=folder/'cancel'
 identity={k:spec[k] for k in ['runId','requestId','artifactSha256','command','timeoutSeconds','workspace']}
 binding={k:identity[k] for k in ['requestId','artifactSha256']};binding['commandSha256']=hashlib.sha256(spec['command'].encode()).hexdigest()
 def status():
  if not claim.exists():return {**binding,'status':'missing'}
  if json.loads(claim.read_text())!=identity:raise ValueError('Check identity mismatch')
  if not state_path.exists():return {**binding,'status':'starting' if time.time()-claim.stat().st_mtime<30 else 'uncertain'}
  state=json.loads(state_path.read_text())
  if state['status']=='running' and not alive(state):return {**binding,'status':'uncertain'}
  return {**binding,**{k:v for k,v in state.items() if k not in ['pid','pidStart']}}
 operation=spec.get('operation','status')
 if operation=='cancel':cancel.touch(mode=0o600,exist_ok=True);return status()
 if operation!='start':return status()
 try:
  fd=os.open(claim,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 except FileExistsError:return status()
 with os.fdopen(fd,'w') as f:json.dump(identity,f);f.flush();os.fsync(f.fileno())
 if os.fork():return status()
 os.setsid()
 null=os.open('/dev/null',os.O_RDWR)
 for fd in (0,1,2):os.dup2(null,fd)
 if null>2:os.close(null)
 started=time.monotonic();state={'status':'running','pid':os.getpid(),'pidStart':fingerprint(os.getpid()),'startedAtMs':round(time.time()*1000)};atomic(state_path,state)
 process=None;tail=b''
 try:
  if cancel.exists():state['status']='cancelled'
  else:
   process=subprocess.Popen(['/bin/bash','-lc',spec['command']],cwd=workspace,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
   os.set_blocking(process.stdout.fileno(),False)
   while True:
    if cancel.exists():terminate(process);state['status']='cancelled';break
    if time.monotonic()-started>spec['timeoutSeconds']:terminate(process);state['status']='failed';state['reason']='timeout';break
    ready,_,_=select.select([process.stdout],[],[],0.05)
    if ready:
     chunk=os.read(process.stdout.fileno(),8192)
     if chunk:tail=(tail+chunk)[-8192:]
    if process.poll() is not None:
     while True:
      try:chunk=os.read(process.stdout.fileno(),8192)
      except BlockingIOError:break
      if not chunk:break
      tail=(tail+chunk)[-8192:]
     state['status']='passed' if process.returncode==0 else 'failed';break
   state['exitCode']=process.returncode
 except Exception:state['status']='uncertain'
 finally:
  if process is not None:terminate(process)
  state['elapsedMs']=round((time.monotonic()-started)*1000);state['finishedAtMs']=round(time.time()*1000)
  if state['status']=='failed':state['output']=tail.decode(errors='replace')[-4000:]
  atomic(state_path,state)
 os._exit(0)

if __name__=='__main__':
 try:print(json.dumps(main(json.loads(base64.b64decode(sys.argv[1])))))
 except Exception:print(json.dumps({'status':'invalid','reason':'Invalid delivery check request or receipt'}));sys.exit(1)
