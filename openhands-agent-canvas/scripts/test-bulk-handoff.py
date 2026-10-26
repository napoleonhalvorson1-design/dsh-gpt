import importlib.util,pathlib,tempfile,tarfile,hashlib,io,json,unittest
spec=importlib.util.spec_from_file_location('bulk',pathlib.Path(__file__).resolve().parent.parent/'ops/handoff-fast.py');bulk=importlib.util.module_from_spec(spec);spec.loader.exec_module(bulk)
class Transfers(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name);self.runtime=self.root/'.canvas-runtime'/'transfers';self.runtime.mkdir(parents=True);self.target=self.root/'runs'/'run'/'build';self.archive=self.runtime/'input.tar.gz';self.rid='a'*64
 def archive_files(self,files,kind=None):
  with tarfile.open(self.archive,'w:gz') as tar:
   for name,data in files:
    h=tarfile.TarInfo(name);h.size=len(data)
    if kind:h.type=kind;h.linkname='/outside'
    tar.addfile(h,io.BytesIO(data))
  return bulk.digest(self.archive)
 def apply(self,sha):return bulk.apply(str(self.root),str(self.target),str(self.archive),'run',sha,self.rid)
 def test_commit_and_retry(self):
  sha=self.archive_files([('run/code/a.txt',b'hello'),('run/binary.bin',bytes([0,255,8])),('run/中文.txt','正常'.encode())]);r=self.apply(sha);self.assertEqual(r['files'],3);self.assertTrue(r['committed']);self.assertEqual((self.target/'binary.bin').read_bytes(),bytes([0,255,8]));self.assertTrue(self.apply(sha)['reused']);(self.target/'code/a.txt').write_text('tampered');self.assertFalse(self.apply(sha)['reused']);self.assertEqual((self.target/'code/a.txt').read_text(),'hello')
 def test_reject_before_target_mutation(self):
  self.target.mkdir(parents=True);(self.target/'old.txt').write_text('preserve')
  for files,kind in [([('run/../escape',b'bad')],None),([('run/a',b'1'),('run/a',b'2')],None),([('other/file',b'1')],None),([('run/link',b'')],tarfile.SYMTYPE),([('run/link',b'')],tarfile.LNKTYPE),([('run/a/b',b'1'),('run/a',b'2')],None)]:
   with self.subTest(files=files):
    sha=self.archive_files(files,kind)
    with self.assertRaises(Exception):self.apply(sha)
    self.assertEqual((self.target/'old.txt').read_text(),'preserve');self.assertFalse((self.root/'escape').exists())
 def test_hash_scope_and_existing_link(self):
  sha=self.archive_files([('run/file',b'ok')])
  with self.assertRaises(ValueError):self.apply('0'*64)
  with self.assertRaises(ValueError):bulk.apply(str(self.root),str(self.root/'other'),str(self.archive),'run',sha,self.rid)
  self.target.mkdir(parents=True);(self.target/'link').symlink_to('/tmp')
  with self.assertRaises(ValueError):self.apply(sha)
 def test_size_limit(self):
  old=bulk.FILE_LIMIT;bulk.FILE_LIMIT=4
  try:
   sha=self.archive_files([('run/file',b'12345')])
   with self.assertRaises(ValueError):self.apply(sha)
  finally:bulk.FILE_LIMIT=old
 def test_executable_and_mode_retry(self):
  import subprocess
  content=b'#!/bin/sh\nprintf mode-preserved'
  with tarfile.open(self.archive,'w:gz') as tar:
   member=tarfile.TarInfo('run/bin/run.sh');member.size=len(content);member.mode=0o755;tar.addfile(member,io.BytesIO(content))
  sha=bulk.digest(self.archive);self.apply(sha);script=self.target/'bin/run.sh';self.assertEqual(subprocess.check_output([str(script)]),b'mode-preserved');script.chmod(0o600);self.assertFalse(self.apply(sha)['reused']);self.assertEqual(subprocess.check_output([str(script)]),b'mode-preserved')
if __name__=='__main__':unittest.main()
