import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../bin/canvas.mjs', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'canvas-run-policy-'));
const token = 'ohc_fake_local_test';
const saved = {
  title: 'Local fixture', task: 'Saved task', taskComplexity: 'complex',
  modelMode: 'manual', reasoningEffort: 'high', executionProfile: 'saved-profile',
  nodes: [{id: 'build', type: 'code', liveModel: 'explicit-model', reasoningEffort: 'max'}],
  edges: [['start', 'build']], repository: 'fixture/repo',
  custom: {keep: true},
};
let state = saved;
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({method: req.method, path: req.url, auth: req.headers.authorization,
    body: raw ? JSON.parse(raw) : undefined});
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/projects/fixture') {
    res.end(JSON.stringify({state, revision: 7}));
  } else if (req.method === 'POST' && req.url === '/api/runs') {
    res.end(JSON.stringify({id: 'fake-run', status: 'queued'}));
  } else if(req.method==='GET'&&req.url==='/api/runs/fixture-run/trace?nodeId=build'){
    res.end(JSON.stringify({trace:{available:false}}));
  } else {
    res.writeHead(405).end(JSON.stringify({error: 'Unexpected request'}));
  }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const credentialsFile = join(temp, 'credentials.json');
  const taskFile = join(temp, 'task.txt');
  await writeFile(credentialsFile, JSON.stringify({url, token}), {mode: 0o600});
  await writeFile(taskFile, 'One run task');
  const env = {...process.env, CANVAS_CREDENTIALS_FILE: credentialsFile};
  delete env.OPENHANDS_CANVAS_URL;
  delete env.OPENHANDS_CANVAS_TOKEN;
  function run(args, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env: {...env, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('CLI timed out')); }, 10000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    });
  }
  const start = ['runs', 'start', '--project', 'fixture', '--id', 'fixture-run'];
  const validationFile=join(temp,'check.json');await writeFile(validationFile,JSON.stringify({command:'node contract.mjs',autoRepair:true}));
  const cases = [
    {args:['--validation-file',validationFile],overrides:{deliveryValidation:{command:'node contract.mjs',autoRepair:true}}},
    ...['auto', 'simple', 'standard', 'complex'].map(value => ({
      args: ['--complexity', value], overrides: {taskComplexity: value},
    })),
    {args: ['--planning-complexity','standard'], overrides: {planningComplexity:'standard'}},
    {args: [], overrides: {}},
    {args: ['--complexity', 'simple', '--mode', 'deep', '--effort', 'max',
      '--profile', 'one-run-profile', '--base-run', 'previous-run', '--task-file', taskFile],
    overrides: {taskComplexity: 'simple', modelMode: 'deep', reasoningEffort: 'max',
      executionProfile: 'one-run-profile', baseRunId: 'previous-run', task: 'One run task'}},
  ];
  for (const {args, overrides} of cases) {
    const before = requests.length;
    const result = await run([...start, ...args]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {id: 'fake-run', status: 'queued'});
    assert.deepEqual(requests.slice(before), [
      {method: 'GET', path: '/api/projects/fixture', auth: `Bearer ${token}`, body: undefined},
      {method: 'POST', path: '/api/runs', auth: `Bearer ${token}`,
        body: {id: 'fixture-run', projectId: 'fixture', workflow: {...saved, ...overrides}}},
    ]);
  }
  state = {...saved};
  delete state.taskComplexity;
  const inherited = await run(start, {OPENHANDS_CANVAS_URL: url, OPENHANDS_CANVAS_TOKEN: token});
  assert.equal(inherited.code, 0, inherited.stdout + inherited.stderr);
  assert.deepEqual(requests.at(-1).body.workflow, state);
  for (const args of [
    ['--complexity', 'unknown'], ['--complexity', ''], ['--complexity', ' '],
    ['--complexity'], ['--complexity', '--mode', 'deep'],
    ['--complexity', 'simple', '--complexity'], ['--planning-complexity','wrong'], ['--planning-complexity'], ['--planning-complexity',''],
  ]) {
    const before = requests.length;
    const result = await run([...start, ...args]);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.match(JSON.parse(result.stdout).error, /--(?:planning-)?complexity/);
    assert.equal(requests.length, before, 'Invalid complexity must fail before submitting');
  }
  for(const args of [['--validation-file'],['--validation-file',''],['--validation-file','--effort','high']]){const count=requests.length;const bad=await run([...start,...args]);assert.equal(bad.code,1);assert.equal(requests.length,count);assert.match(JSON.parse(bad.stdout).error,/validation-file/)}
  const trace=await run(['runs','trace','--id','fixture-run','--node','build']);assert.equal(trace.code,0);assert.equal(requests.at(-1).path,'/api/runs/fixture-run/trace?nodeId=build');assert.equal(requests.at(-1).auth,`Bearer ${token}`);
  const help = await run(['help']);
  assert.equal(help.code, 0);
  assert.match(JSON.parse(help.stdout).usage.find(line => line.startsWith('canvas runs start ')),
    /--mode .*--effort .*--complexity auto\|simple\|standard\|complex/);
  assert.equal(requests.some(req => req.method === 'PUT'), false);
  console.log('PASS CLI run policy: overrides, inheritance, preserved fields, validation, help; no PUT');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temp, {recursive: true, force: true});
}
