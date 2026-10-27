"""Exercise the native capture helper on real files, without model or S3 calls."""
import base64,hashlib,json,os,pathlib,subprocess,tarfile,tempfile,unittest
HELPER=pathlib.Path(__file__).resolve().parents[1]/'server/stream-plan.py'
sha=lambda b:hashlib.sha256(b).hexdigest()
class StreamPlan(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=pathlib.Path(self.temp.name);self.ws=self.root/'runs'/'run-1'/'plan';self.protocol=self.ws/'.canvas-collaboration';self.protocol.mkdir(parents=True)
  self.spec=dict(root=str(self.root),workspace=str(self.ws),runId='run-1',requestId='request-1',model='verified-model',effort='medium')
  self.plan=b'{"schemaVersion":1,"deliveryMode":"streamed"}\n';(self.protocol/'plan.json').write_bytes(self.plan)
  self.receipt=dict(requestId='request-1',model='verified-model',effort='medium',modelApplied=True,effortApplied=True);self.policy()
  (self.ws/'api.sh').write_bytes(b'#!/bin/sh\necho stable\n');(self.ws/'api.sh').chmod(0o755)
  (self.ws/'unfinished.txt').write_text('must never enter early checkpoint')
  self.marker=dict(schemaVersion=1,requestId='request-1',planSha256=sha(self.plan),files={'api.sh':sha((self.ws/'api.sh').read_bytes())});self.commit()
 def policy(self): (self.protocol/'runtime-selection.json').write_text(json.dumps(self.receipt))
 def commit(self): (self.protocol/'plan-commit.json').write_text(json.dumps(self.marker))
 def capture(self):
  result=subprocess.run(['python3','-I',str(HELPER),base64.b64encode(json.dumps(self.spec).encode()).decode()],capture_output=True,text=True,timeout=5,check=True)
  return json.loads(result.stdout)
 def test_exact_immutable_capture_and_modes(self):
  result=self.capture();self.assertTrue(result['available']);self.assertEqual(result,self.capture())
  with tarfile.open(result['archive']) as archive:
   self.assertEqual(set(archive.getnames()),{'run-1/api.sh','run-1/.canvas-collaboration/plan.json','run-1/.canvas-collaboration/runtime-selection.json'})
   self.assertEqual(archive.getmember('run-1/api.sh').mode,0o755)
  self.assertEqual(sha(pathlib.Path(result['archive']).read_bytes()),result['archiveSha256'])
 def test_missing_marker_is_optional(self):
  (self.protocol/'plan-commit.json').unlink();self.assertEqual(self.capture(),{'available':False})
 def test_request_and_model_binding(self):
  for field,value in [('requestId','stale'),('model','wrong'),('effort','low'),('modelApplied',False),('effortApplied',False)]:
   original=self.receipt[field];self.receipt[field]=value;self.policy();self.assertFalse(self.capture()['available']);self.receipt[field]=original
  self.policy();self.marker['requestId']='stale';self.commit();self.assertFalse(self.capture()['available'])
 def test_torn_or_changed_plan_and_interface(self):
  (self.protocol/'plan.json').write_bytes(self.plan+b' ');self.assertFalse(self.capture()['available']);(self.protocol/'plan.json').write_bytes(self.plan)
  (self.ws/'api.sh').write_text('changed');self.assertFalse(self.capture()['available'])
 def test_links_and_outside_paths(self):
  (self.ws/'linked').symlink_to(self.ws/'api.sh');self.marker['files']={'linked':sha((self.ws/'api.sh').read_bytes())};self.commit();self.assertFalse(self.capture()['available'])
  for path in ['../escape','/etc/passwd','.canvas-collaboration/plan.json','.git/config']:
   self.marker['files']={path:'0'*64};self.commit();self.assertFalse(self.capture()['available'])
 def test_fifo_does_not_block(self):
  os.mkfifo(self.ws/'pipe');self.marker['files']={'pipe':'0'*64};self.commit();self.assertFalse(self.capture()['available'])
 def test_empty_files_allowed_and_limits(self):
  self.marker['files']={};self.commit();self.assertTrue(self.capture()['available'])
  self.marker['files']={str(i):'0'*64 for i in range(21)};self.commit();self.assertFalse(self.capture()['available'])
if __name__=='__main__':unittest.main()
