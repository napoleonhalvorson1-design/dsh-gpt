"""Compare four-parent merging with a 256 MiB address-space ceiling, without AI."""
import sys,pathlib,tempfile,tarfile,io,json,subprocess,resource,hashlib
root=pathlib.Path(__file__).resolve().parent.parent
def constrained():resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
with tempfile.TemporaryDirectory(prefix='canvas-merge-memory-') as directory:
 path=pathlib.Path(directory);archive=path/'input.tar.gz';block=bytes(range(256))*65536
 with tarfile.open(archive,'w:gz') as tar:
  for i in range(7):
   member=tarfile.TarInfo('memory-run/assets/file-'+str(i)+'.bin');member.size=len(block);tar.addfile(member,io.BytesIO(block))
 spec={'runId':'memory-run','nodeId':'join','base':str(archive),'baseId':'base','parents':[{'id':str(i),'archive':str(archive)} for i in range(4)]};results=[]
 for label,helper in [('baseline',pathlib.Path(sys.argv[1])),('current',root/'server/handoff.py')]:
  output=path/(label+'.tar.gz');usage=path/(label+'.rss');result=subprocess.run(['/usr/bin/time','-f','%M','-o',str(usage),'python3',str(helper),'merge',str(output)],input=json.dumps(spec),text=True,capture_output=True,preexec_fn=constrained);item={'version':label,'success':result.returncode==0,'maxRssKiB':int(usage.read_text().splitlines()[-1]),'memoryCeilingMiB':256}
  if result.returncode:item['error']=result.stderr.strip().splitlines()[-1]
  else:
   with tarfile.open(output,'r:gz') as tar:
    for i in range(7):
     with tar.extractfile('memory-run/assets/file-'+str(i)+'.bin') as file:assert hashlib.sha256(file.read()).digest()==hashlib.sha256(block).digest()
   item['verifiedBytes']=7*len(block)
  results.append(item)
 assert results[1]['success'];report={'scope':'112 MiB workspace, common base plus four identical parents, 256 MiB process ceiling','results':results};print(json.dumps(report));pathlib.Path('/tmp/canvas-goal-merge-memory.json').write_text(json.dumps(report,indent=2))
