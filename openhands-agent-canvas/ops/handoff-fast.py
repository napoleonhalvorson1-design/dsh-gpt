#!/usr/bin/env python3
"""Authenticated SDK command helper: checked, idempotent whole-workspace import."""
import argparse,fcntl,hashlib,json,os,pathlib,re,shutil,stat,sys,tarfile,tempfile,uuid
VERSION=1;FILE_LIMIT=32*1024*1024;TOTAL_LIMIT=128*1024*1024

def digest(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def safe(name):return bool(name) and len(name)<=1000 and not name.startswith('/') and '\\' not in name and all(p not in ('','..','.') for p in name.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in name)
def no_links(path,recursive=True):
 p=pathlib.Path(path)
 for current in [p,*p.parents]:
  if current.is_symlink():raise ValueError('Symlink in target path')
 if p.exists():
  if not p.is_dir():raise ValueError('Target is not a directory')
  if not recursive:return
  count=0
  for folder,dirs,files in os.walk(p,followlinks=False):
   for name in dirs+files:
    count+=1
    if count>15000:raise ValueError('Destination has too many entries')
    entry=pathlib.Path(folder)/name
    if entry.is_symlink():raise ValueError('Symlink in destination')
    if not entry.is_file() and not entry.is_dir():raise ValueError('Unsupported destination entry')
def atomic_json(path,data):
 temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp');temporary.write_text(json.dumps(data,ensure_ascii=False));temporary.chmod(0o600);temporary.replace(path)
def tree_matches(path,items):
 found={str((pathlib.Path(folder)/f).relative_to(path)) for folder,_,files in os.walk(path,followlinks=False) for f in files}
 return found=={x['path'] for x in items} and all((path/x['path']).is_file() and (path/x['path']).stat().st_size==x['size'] and digest(path/x['path'])==x['sha256'] and bool((path/x['path']).stat().st_mode&0o111)==x.get('executable',False) for x in items)
def apply(root,target,archive,archive_root,expected_sha,request_id):
 root=pathlib.Path(root);target=pathlib.Path(target);archive=pathlib.Path(archive)
 if not root.is_absolute() or not target.is_absolute() or root.resolve()!=root or target.resolve()!=target:raise ValueError('Workspace path must be canonical')
 if not target.is_relative_to(root/'runs') or len(target.relative_to(root/'runs').parts) not in (1,2):raise ValueError('Target must be an isolated run workspace')
 if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',archive_root) or not re.fullmatch(r'[a-f0-9]{64}',request_id) or not re.fullmatch(r'[a-f0-9]{64}',expected_sha):raise ValueError('Invalid transfer identity')
 runtime=root/'.canvas-runtime';runtime.mkdir(mode=0o700,parents=True,exist_ok=True);no_links(runtime,False)
 transfers=runtime/'transfers';transfers.mkdir(mode=0o700,exist_ok=True);no_links(transfers,False)
 if archive.resolve()!=archive or not archive.is_relative_to(transfers) or not archive.is_file() or archive.stat().st_size>TOTAL_LIMIT:raise ValueError('Invalid input archive')
 if digest(archive)!=expected_sha:raise ValueError('Input checksum mismatch')
 no_links(target.parent,False);locks=runtime/'locks';locks.mkdir(mode=0o700,exist_ok=True);no_links(locks,False);receipts=runtime/'receipts';receipts.mkdir(mode=0o700,exist_ok=True);no_links(receipts,False)
 lock_name=hashlib.sha256(str(target).encode()).hexdigest();receipt_file=receipts/(request_id+'.json')
 with os.fdopen(os.open(locks/(lock_name+'.lock'),os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600),'a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);no_links(target)
  if receipt_file.exists():
   if receipt_file.is_symlink() or not receipt_file.is_file():raise ValueError('Invalid receipt path')
   receipt=json.loads(receipt_file.read_text())
   if receipt.get('fileModes')==1 and receipt.get('archiveSha256')==expected_sha and receipt.get('target')==str(target) and tree_matches(target,receipt['items']):return {k:v for k,v in receipt.items() if k!='items'}|{'reused':True}
  stage=pathlib.Path(tempfile.mkdtemp(prefix='stage-',dir=transfers));payload=stage/'payload';payload.mkdir(mode=0o700);backup=None;total=0;items=[];seen=set();entries=0
  try:
   with tarfile.open(archive,'r:gz') as tar:
    for member in tar:
     entries+=1;name=member.name.rstrip('/')
     if entries>15000 or not safe(name):raise ValueError('Unsafe archive path or too many entries')
     if name==archive_root:
      if not member.isdir():raise ValueError('Invalid archive root')
      continue
     if not name.startswith(archive_root+'/'):raise ValueError('Unexpected archive root')
     relative=name[len(archive_root)+1:]
     if relative in seen:raise ValueError('Duplicate archive path')
     seen.add(relative)
     if member.isdir():(payload/relative).mkdir(mode=0o700,parents=True,exist_ok=True);continue
     if not member.isfile():raise ValueError('Only regular files may be imported')
     if relative=='archive_manifest.json':continue
     if member.size<0 or member.size>FILE_LIMIT:raise ValueError('File exceeds limit')
     total+=member.size
     if total>TOTAL_LIMIT or len(items)>=5000:raise ValueError('Workspace exceeds limit')
     destination=payload/relative;destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True);source=tar.extractfile(member);h=hashlib.sha256();count=0
     with open(destination,'xb') as f:
      os.chmod(destination,0o700 if member.mode&0o111 else 0o600)
      for chunk in iter(lambda:source.read(1024*1024),b''):count+=len(chunk);h.update(chunk);f.write(chunk)
     if count!=member.size:raise ValueError('Truncated archive member')
     items.append({'path':relative,'size':count,'sha256':h.hexdigest(),'executable':bool(member.mode&0o111)})
   no_links(target);target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
   if target.exists():backup=target.with_name('.'+target.name+'-previous-'+uuid.uuid4().hex);target.rename(backup)
   try:payload.rename(target)
   except BaseException:
    if backup is not None and not target.exists():backup.rename(target);backup=None
    raise
   manifest_sha=hashlib.sha256(json.dumps(sorted(items,key=lambda x:x['path']),sort_keys=True,separators=(',',':')).encode()).hexdigest()
   receipt={'schemaVersion':VERSION,'fileModes':1,'requestId':request_id,'archiveSha256':expected_sha,'manifestSha256':manifest_sha,'target':str(target),'files':len(items),'bytes':total,'committed':True,'items':items};atomic_json(receipt_file,receipt)
   if backup is not None:shutil.rmtree(backup);backup=None
   return {k:v for k,v in receipt.items() if k!='items'}|{'reused':False}
  finally:
   shutil.rmtree(stage,ignore_errors=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('--probe',action='store_true');p.add_argument('--root');p.add_argument('--target');p.add_argument('--archive');p.add_argument('--archive-root');p.add_argument('--sha256');p.add_argument('--request-id');args=p.parse_args()
 if args.probe:print(json.dumps({'schemaVersion':VERSION,'bulkHandoff':True,'fileModes':True,'fileLimit':FILE_LIMIT,'workspaceLimit':TOTAL_LIMIT}));return
 try:result=apply(args.root,args.target,args.archive,args.archive_root,args.sha256,args.request_id);print(json.dumps(result));pathlib.Path(args.archive).unlink(missing_ok=True)
 except Exception as error:print(json.dumps({'schemaVersion':VERSION,'error':str(error)}));raise SystemExit(1)
if __name__=='__main__':main()
