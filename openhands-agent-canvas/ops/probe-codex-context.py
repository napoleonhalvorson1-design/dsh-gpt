#!/usr/bin/env python3
"""Read effective Codex config in an owned subprocess. No thread or inference."""
import argparse,json,os,select,shutil,signal,subprocess,time

def probe(codex,cwd):
 overrides={'features.apps':False,'features.plugins':False,'features.remote_plugin':False,'skills.max_context_tokens':1024}
 command=[codex]
 for key,value in overrides.items():command+=['-c',key+'='+json.dumps(value)]
 child=subprocess.Popen(command+['app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 buffer=b''
 def call(identifier,method,params):
  nonlocal buffer
  child.stdin.write((json.dumps({'id':identifier,'method':method,'params':params})+'\n').encode());child.stdin.flush();deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   while b'\n' in buffer:
    line,buffer=buffer.split(b'\n',1)
    try:message=json.loads(line)
    except ValueError:continue
    if message.get('id')==identifier:
     if 'error' in message:raise RuntimeError('Codex config probe rejected')
     return message.get('result',{})
   if select.select([child.stdout],[],[],min(1,max(0,deadline-time.monotonic())))[0]:
    data=os.read(child.stdout.fileno(),65536)
    if not data:break
    buffer+=data
  raise RuntimeError('Codex config probe timed out')
 try:
  call(1,'initialize',{'clientInfo':{'name':'canvas-context-probe','version':'1.0.0'},'capabilities':{'experimentalApi':True}})
  child.stdin.write(b'{"method":"initialized","params":{}}\n');child.stdin.flush()
  result=call(2,'config/read',{'includeLayers':False,'cwd':cwd});config=result.get('config',{})
  def value(key):
   if key in config:return config[key]
   current=config
   for part in key.split('.'):
    if not isinstance(current,dict):return None
    current=current.get(part)
   return current
  if any(value(key)!=expected for key,expected in overrides.items()):raise RuntimeError('Codex context overrides were not confirmed')
  return {'verified':True,'scope':'owned-subprocess-config-read','inferenceStarted':False,'threadCreated':False,'overrides':overrides}
 finally:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   child.wait()
  child.stdin.close();child.stdout.close()

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--codex',default=os.environ.get('CODEX_PATH') or shutil.which('codex'));parser.add_argument('--cwd',required=True);args=parser.parse_args()
 if not args.codex:raise SystemExit('Codex executable not found')
 try:print(json.dumps(probe(args.codex,args.cwd)))
 except Exception:raise SystemExit('Codex context configuration was not confirmed; no model called')
