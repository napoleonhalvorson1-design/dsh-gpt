import {readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),codex=process.env.CANVAS_CODEX_BINARY||'codex',marketplace=JSON.parse(await readFile(join(root,'.agents/plugins/marketplace.json'),'utf8')),entry=marketplace.plugins[0],selector=entry.name+'@'+marketplace.name;
const run=args=>JSON.parse(execFileSync(codex,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024}));
run(['plugin','marketplace','add',root,'--json']);
const installed=run(['plugin','add',selector,'--json']),listed=run(['plugin','list','--marketplace',marketplace.name,'--json']).installed.find(p=>p.name===entry.name);
if(!listed?.installed||!listed.enabled)throw Error('Local plugin was not installed and enabled.');
await access(join(installed.installedPath,'skills/openhands-collaboration/SKILL.md'));
let workbench;
try{const result=JSON.parse(execFileSync(process.execPath,[join(installed.installedPath,'scripts/canvas.mjs'),'projects','list'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));workbench={connected:true,projects:result.items.length}}catch{workbench={connected:false,note:'Plugin installed; configure the existing canvas CLI connection or use the website connection code.'}}
console.log(JSON.stringify({plugin:selector,version:listed.version,installed:true,enabled:true,marketplace:marketplace.interface.displayName,installedPath:installed.installedPath,workbench,verifiedSurface:'Codex CLI',note:'In Codex CLI, open /plugins and find OpenHands · Agent Canvas (source: OpenHands 工作台). Start a new CLI session to load newly installed skills and tools. Mobile remote plugin visibility requires a separate check.'},null,2));
