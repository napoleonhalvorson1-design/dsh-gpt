import importlib.util,pathlib,random,unittest
spec=importlib.util.spec_from_file_location('text_merge',pathlib.Path(__file__).resolve().parents[1]/'server/text_merge.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def merge(base,*parents):return module.merge_text(base,parents,{'remaining':module.WORK_BUDGET})
class TextMerge(unittest.TestCase):
 def test_independent_functions_and_order(self):
  base=b'export function a(){return 0;}\n\nexport function b(){return 0;}\n'
  a=base.replace(b'a(){return 0',b'a(){return 1');b=base.replace(b'b(){return 0',b'b(){return 2')
  expected=b'export function a(){return 1;}\n\nexport function b(){return 2;}\n'
  self.assertEqual(merge(base,a,b),expected);self.assertEqual(merge(base,b,a),expected)
 def test_five_branches_and_shared_identical_edit(self):
  base=b''.join(str(i).encode()+b'\n' for i in range(8));parents=[base.replace(str(i).encode()+b'\n',b'changed-'+str(i).encode()+b'\n') for i in range(5)]
  expected=b''.join((b'changed-' if i<5 else b'')+str(i).encode()+b'\n' for i in range(8))
  self.assertEqual(merge(base,*parents),expected)
  self.assertEqual(merge(base,parents[0],parents[0],parents[4]),base.replace(b'0\n',b'changed-0\n').replace(b'4\n',b'changed-4\n'))
 def test_overlap_and_competing_insertion(self):
  self.assertIsNone(merge(b'one\ntwo\n',b'ONE\ntwo\n',b'different\ntwo\n'))
  self.assertIsNone(merge(b'one\ntwo\n',b'one\na\ntwo\n',b'one\nb\ntwo\n'))
  self.assertIsNone(merge(b'one\ntwo\n',b'two\n',b'ONE\ntwo\n'))
 def test_insert_boundary_is_conservative(self):
  self.assertIsNone(merge(b'a\nb\nc\n',b'A\nb\nc\n',b'a\nnew\nb\nc\n'))
  self.assertEqual(merge(b'a\nb\nc\nd\n',b'A\nb\nc\nd\n',b'a\nb\nc\nnew\nd\n'),b'A\nb\nc\nnew\nd\n')
 def test_deletions_and_newline_bytes(self):
  self.assertEqual(merge(b'a\r\nb\r\nc\r\nd',b'b\r\nc\r\nd',b'a\r\nb\r\nc\r\nD'),b'b\r\nc\r\nD')
  base='甲\n乙\n丙\n'.encode();self.assertEqual(merge(base,'新甲\n乙\n丙\n'.encode(),'甲\n乙\n新丙\n'.encode()),'新甲\n乙\n新丙\n'.encode())
 def test_binary_or_invalid_utf8(self):
  for base in [b'a\x00\nb\n',b'\xff\nb\n',b'a\x1b\nb\n']:
   self.assertIsNone(merge(base,base+b'new',b'new'+base))
 def test_size_lines_and_shared_work_bound(self):
  self.assertIsNone(merge(b'x'*(module.MAX_BYTES+1),b'a',b'b'))
  self.assertIsNone(merge(b'x\n'*(module.MAX_LINES+1),b'a',b'b'))
  budget={'remaining':1};self.assertIsNone(module.merge_text(b'a\nb\n',[b'A\nb\n',b'a\nB\n'],budget));self.assertEqual(budget['remaining'],1)
  budget={'remaining':8};self.assertEqual(module.merge_text(b'a\nb\n',[b'A\nb\n',b'a\nB\n'],budget),b'A\nB\n');self.assertEqual(budget['remaining'],0)
 def test_generated_independent_edits_preserve_every_branch(self):
  rng=random.Random(528)
  for count in range(2,6):
   for _ in range(25):
    lines=[f'line {i}\n'.encode() for i in range(30)];positions=rng.sample(range(30),count);parents=[];expected=list(lines)
    for i,pos in enumerate(positions):
     variant=list(lines);variant[pos]=f'branch {i} changes {pos}\n'.encode();parents.append(b''.join(variant));expected[pos]=variant[pos]
    rng.shuffle(parents);self.assertEqual(merge(b''.join(lines),*parents),b''.join(expected))
if __name__=='__main__':unittest.main()
