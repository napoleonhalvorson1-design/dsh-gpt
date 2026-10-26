import importlib.util,json,os,pathlib,tempfile,unittest

root=pathlib.Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('context_probe',root/'ops/probe-codex-context.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Probe(unittest.TestCase):
 def test_config_read_without_threads_or_inference(self):
  with tempfile.TemporaryDirectory() as d:
   path=pathlib.Path(d)/'codex';path.write_text('''#!/usr/bin/env python3
import sys,json
overrides={}
for i,arg in enumerate(sys.argv):
 if arg=='-c':
  key,value=sys.argv[i+1].split('=',1);overrides[key]=json.loads(value)
for line in sys.stdin:
 m=json.loads(line)
 if m['method']=='initialized':continue
 assert m['method'] in ['initialize','config/read'], 'Unexpected paid/task operation'
 config={'features':{k.split('.')[1]:v for k,v in overrides.items() if k.startswith('features.')},'skills':{'max_context_tokens':overrides['skills.max_context_tokens']},'private':'not-returned'}
 print(json.dumps({'id':m['id'],'result':{'config':config} if m['method']=='config/read' else {}}),flush=True)
''');path.chmod(0o700)
   result=module.probe(str(path),d);self.assertTrue(result['verified']);self.assertFalse(result['inferenceStarted']);self.assertFalse(result['threadCreated']);self.assertNotIn('not-returned',json.dumps(result))
   path.write_text(path.read_text().replace("'max_context_tokens':overrides['skills.max_context_tokens']","'max_context_tokens':9999"))
   with self.assertRaisesRegex(RuntimeError,'not confirmed'):module.probe(str(path),d)

if __name__=='__main__':unittest.main()
