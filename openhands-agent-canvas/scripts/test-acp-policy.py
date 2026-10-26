import json,os,pathlib,select,subprocess,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent
FAKE=r'''
import sys,json,os
mode=sys.argv[1];model='original';effort='low'
def state():
 o=[{'id':'model','category':'model','currentValue':model,'options':[{'value':v,'name':v} for v in ['target','original']]}]
 if mode!='env':o.append({'id':'reasoning_effort','category':'thought_level','currentValue':effort,'options':[{'value':v,'name':v} for v in ['low','max']]})
 return {'sessionId':'s','configOptions':o}
for line in sys.stdin:
 m=json.loads(line);method=m['method'];p=m.get('params',{});result={}
 if method=='initialize':result={'agentInfo':{'name':'fake'}}
 elif method=='session/new':result=state()
 elif method=='session/set_config_option':
  if mode=='reject':print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-1,'message':'private provider error'}}),flush=True);continue
  if p['configId']=='model':model=p['value'] if mode!='mismatch' else 'original'
  else:effort=p['value']
  result=state()
 elif method=='session/prompt':result={'stopReason':'end_turn','environment':{k:os.environ.get(k) for k in ['CLAUDE_CODE_EFFORT_LEVEL','CODEX_CONFIG']}}
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
'''
class Policy(unittest.TestCase):
 def run_case(self,provider='codex',mode='normal'):
  folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);root=pathlib.Path(folder.name);fake=root/'fake.py';fake.write_text(FAKE)
  env={**os.environ,'CODEX_CONFIG':json.dumps({'preserved':'yes'})};p=subprocess.Popen([sys.executable,str(ROOT/'ops/acp-policy.py'),'--provider',provider,'--model','target','--effort','max','--request-id','run-123','--',sys.executable,str(fake),mode],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
  def cleanup():
   p.stdin.close()
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait()
   p.stdout.close();p.stderr.close()
  self.addCleanup(cleanup)
  def call(method,params={}):
   p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})+'\n');p.stdin.flush();self.assertTrue(select.select([p.stdout],[],[],5)[0],'ACP response timed out');return json.loads(p.stdout.readline())
  self.assertIn('error',call('session/prompt',{'sessionId':'s'}));call('initialize');reply=call('session/new',{'cwd':str(root)})
  return root,call,reply
 def test_ack_before_prompt(self):
  root,call,reply=self.run_case();self.assertIn('result',reply);r=json.loads((root/'.canvas-collaboration/runtime-selection.json').read_text());self.assertEqual(r['model'],'target');self.assertEqual(r['effort'],'max');self.assertEqual(r['requestId'],'run-123');self.assertTrue(r['modelApplied'] and r['effortApplied']);self.assertIn('result',call('session/prompt',{'sessionId':'s'}));self.assertEqual((root/'.canvas-collaboration/runtime-selection.json').stat().st_mode & 0o777,0o600)
 def test_failed_ack_blocks_inference(self):
  for mode in ['reject','mismatch']:
   with self.subTest(mode=mode):
    root,call,reply=self.run_case(mode=mode);self.assertIn('error',reply);self.assertNotIn('private provider error',json.dumps(reply));self.assertIn('error',call('session/prompt',{'sessionId':'s'}));self.assertFalse((root/'.canvas-collaboration/runtime-selection.json').exists())
 def test_deepseek_pinned(self):
  root,call,reply=self.run_case(provider='deepseek');self.assertIn('result',reply);self.assertIn('error',call('session/set_config_option',{'sessionId':'s','configId':'model','value':'original'}));self.assertIn('error',call('session/set_config_option',{'sessionId':'s','configId':'reasoning_effort','value':'low'}))
 def test_process_overrides(self):
  for provider in ['codex','claude-code']:
   with self.subTest(provider=provider):
    root,call,reply=self.run_case(provider=provider,mode='env');self.assertIn('result',reply);r=call('session/prompt',{'sessionId':'s'})['result']['environment'];self.assertEqual(json.loads(r['CODEX_CONFIG'])['preserved'],'yes');self.assertEqual(json.loads(r['CODEX_CONFIG']).get('model_reasoning_effort') if provider=='codex' else r['CLAUDE_CODE_EFFORT_LEVEL'],'max')
if __name__=='__main__':unittest.main()
