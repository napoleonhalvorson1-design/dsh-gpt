import base64,json,pathlib,subprocess,sys,tempfile,time,unittest,uuid

HELPER=pathlib.Path(__file__).resolve().parent.parent/'server/delivery-check.py'
class CheckTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.workspace=self.root/'runs/run/delivery-check-0';self.workspace.mkdir(parents=True)
 def tearDown(self):self.temp.cleanup()
 def spec(self,command):return {'root':str(self.root),'workspace':str(self.workspace),'runId':'run','requestId':uuid.uuid4().hex,'artifactSha256':'a'*64,'command':command,'timeoutSeconds':5}
 def call(self,spec,operation='status'):
  p=subprocess.run([sys.executable,str(HELPER),base64.b64encode(json.dumps({**spec,'operation':operation}).encode()).decode()],capture_output=True,text=True,timeout=3)
  return json.loads(p.stdout)
 def wait(self,spec,statuses=('passed','failed','cancelled'),seconds=8):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   result=self.call(spec)
   if result['status'] in statuses:return result
   time.sleep(.03)
  self.fail('Check did not reach '+str(statuses))
 def test_ack_loss_idempotence_and_binding(self):
  spec=self.spec("printf x >> counter; sleep 0.15")
  self.call(spec,'start');self.call(spec,'start');result=self.wait(spec)
  self.assertEqual(result['status'],'passed');self.assertEqual(result['exitCode'],0)
  self.assertEqual((self.workspace/'counter').read_text(),'x')
  self.assertEqual(self.call(spec,'start')['status'],'passed')
  self.assertEqual(self.call({**spec,'command':'printf bad'},'start')['status'],'invalid')
  self.assertEqual(self.call({**spec,'artifactSha256':'b'*64})['status'],'invalid')
 def test_actual_failure_output_is_bounded(self):
  spec=self.spec("python3 -c 'print(\"x\"*20000);print(\"specific failure\");raise SystemExit(7)'")
  self.call(spec,'start');result=self.wait(spec)
  self.assertEqual(result['status'],'failed');self.assertEqual(result['exitCode'],7)
  self.assertIn('specific failure',result['output']);self.assertLessEqual(len(result['output']),4000)
 def test_cancel_confirms_worker_stop(self):
  spec=self.spec('sleep 20; printf bad > completed')
  self.call(spec,'start');self.wait(spec,('running',));self.call(spec,'cancel');result=self.wait(spec)
  self.assertEqual(result['status'],'cancelled');self.assertFalse((self.workspace/'completed').exists())
 def test_timeout_is_terminal_not_replayed(self):
  spec=self.spec('sleep 20; printf bad > completed')
  self.call(spec,'start');result=self.wait(spec)
  self.assertEqual(result['status'],'failed');self.assertEqual(result['reason'],'timeout');self.assertNotEqual(result['exitCode'],0)
  self.assertEqual(self.call(spec,'start')['status'],'failed');self.assertFalse((self.workspace/'completed').exists())
 def test_dead_worker_with_unreaped_pid_is_uncertain(self):
  process=subprocess.Popen(['/bin/sleep','20'])
  try:
   start=pathlib.Path('/proc',str(process.pid),'stat').read_text().rsplit(')',1)[1].split()[19];process.kill()
   deadline=time.monotonic()+2
   while time.monotonic()<deadline and pathlib.Path('/proc',str(process.pid),'stat').read_text().rsplit(')',1)[1].split()[0]!='Z':time.sleep(.01)
   spec=self.spec('printf bad > repeated');folder=self.root/'runs/run/.canvas-delivery-checks'/spec['requestId'];folder.mkdir(parents=True)
   (folder/'claim.json').write_text(json.dumps({k:spec[k] for k in ['runId','requestId','artifactSha256','command','timeoutSeconds','workspace']}));(folder/'state.json').write_text(json.dumps({'status':'running','pid':process.pid,'pidStart':start}))
   self.assertEqual(self.call(spec,'start')['status'],'uncertain');self.assertFalse((self.workspace/'repeated').exists())
  finally:process.wait()
 def test_uncertain_old_claim_does_not_restart(self):
  spec=self.spec('printf bad > repeated');folder=self.root/'runs/run/.canvas-delivery-checks'/spec['requestId'];folder.mkdir(parents=True)
  identity={k:spec[k] for k in ['runId','requestId','artifactSha256','command','timeoutSeconds','workspace']}
  (folder/'claim.json').write_text(json.dumps(identity));(folder/'state.json').write_text(json.dumps({'status':'running','pid':99999999,'pidStart':'0'}))
  self.assertEqual(self.call(spec,'start')['status'],'uncertain');self.assertFalse((self.workspace/'repeated').exists())

if __name__=='__main__':unittest.main()
