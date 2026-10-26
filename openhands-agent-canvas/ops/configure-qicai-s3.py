#!/usr/bin/env python3
"""Install controller-only S3 environment variables; never print credentials."""
import argparse,getpass,json,os,pathlib,sys,tempfile
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config-only',action='store_true',help='Install public connection parameters without prompting for credentials')
parser.add_argument('--from-environment',action='store_true',help='Read both credentials from environment variables without prompting')
parser.add_argument('--enable-sync',action='store_true',help='Allow collaboration data writes after the initial read-only check')
args=parser.parse_args()
if os.geteuid()!=0:sys.exit('Run with sudo on the Silicon Valley controller.')
path=pathlib.Path('/etc/openhands-control/s3.env');values={}
if path.exists():
 for line in path.read_text().splitlines():
  if line and not line.startswith('#'):
   name,raw=line.split('=',1);values[name]=json.loads(raw)
values.update(CANVAS_S3_ENDPOINT='https://s3.7caiyun.com',CANVAS_S3_REGION='us-west',CANVAS_S3_BUCKET='zzx123-u1aya4fk',CANVAS_S3_FORCE_PATH_STYLE='false')
values.setdefault('CANVAS_S3_READ_ONLY','true')
if args.enable_sync:values['CANVAS_S3_READ_ONLY']='false'
if not args.config_only:
 names={'CANVAS_S3_ACCESS_KEY_ID':['CANVAS_S3_ACCESS_KEY_ID','S3_ACCESS_KEY','AWS_ACCESS_KEY_ID'],'CANVAS_S3_SECRET_ACCESS_KEY':['CANVAS_S3_SECRET_ACCESS_KEY','S3_SECRET_KEY','AWS_SECRET_ACCESS_KEY']}
 for target,aliases in names.items():
  value=next((os.environ[n] for n in aliases if os.environ.get(n)),None)
  if value is None:
   if args.from_environment or not sys.stdin.isatty():sys.exit('Both AccessKey and SecretKey must be supplied through environment variables or hidden terminal input.')
   value=getpass.getpass(target+' (hidden): ')
  if not value or len(value)>4000 or any(c in value for c in '\r\n\x00'):sys.exit('Invalid credential input; configuration was not changed.')
  values[target]=value
path.parent.mkdir(mode=0o710,parents=True,exist_ok=True)
with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,prefix='.s3-',delete=False) as f:
 os.chmod(f.name,0o600)
 for name,value in values.items():f.write(name+'='+json.dumps(value)+'\n')
 temporary=f.name
os.replace(temporary,path)
print('S3 environment configuration installed at '+str(path)+' (root-only 0600).')
print('Credential pair configured: '+str(bool(values.get('CANVAS_S3_ACCESS_KEY_ID') and values.get('CANVAS_S3_SECRET_ACCESS_KEY'))))
print('Apply: sudo systemctl restart openhands-control')
print('Read-only test: canvas storage list --limit 20')
