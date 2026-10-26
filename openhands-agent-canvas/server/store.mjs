import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export class Store {
  constructor(path,secret){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.key=createHash('sha256').update(secret).digest();
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(key TEXT PRIMARY KEY,kind TEXT NOT NULL,resource_id TEXT NOT NULL,revision INTEGER NOT NULL,size INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,scopes TEXT NOT NULL,created_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_by_project ON runs(project_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,node_id TEXT NOT NULL,external_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(run_id,node_id,external_id));
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id,seq);`);
  }
  encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv),body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')}
  decrypt(value){const b=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString())}
  projects(){return this.db.prepare('SELECT id,title,revision,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all()}
  project(id){const row=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);return row?{id:row.id,title:row.title,revision:row.revision,updatedAt:row.updated_at,state:JSON.parse(row.payload)}:null}
  putProject(id,state,expected){const current=this.project(id);if(current&&current.revision!==expected)return null;const now=new Date().toISOString(),rev=(current?.revision||0)+1;this.db.prepare('INSERT INTO projects(id,title,payload,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at').run(id,state.title,JSON.stringify(state),rev,now);return this.project(id)}
  deleteProject(id){this.db.prepare('DELETE FROM projects WHERE id=?').run(id)}
  run(id){const row=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);return row?{...JSON.parse(row.payload),id:row.id,status:row.status,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at}:null}
  config(id){const row=this.db.prepare('SELECT config FROM runs WHERE id=?').get(id);return row?this.decrypt(row.config):null}
  createRun(run,config){const now=new Date().toISOString();this.db.prepare('INSERT INTO runs(id,project_id,title,status,payload,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(run.id,run.projectId,run.title,run.status,JSON.stringify(run),this.encrypt(config),now,now);return this.run(run.id)}
  saveRun(run,{resetCancel=false}={}){const old=this.run(run.id);if(old?.cancelRequested&&!resetCancel)run.cancelRequested=true;const now=new Date().toISOString();this.db.prepare('UPDATE runs SET status=?,payload=?,revision=revision+1,updated_at=? WHERE id=?').run(run.status,JSON.stringify(run),now,run.id);return this.run(run.id)}
  setConfig(id,config){this.db.prepare('UPDATE runs SET config=? WHERE id=?').run(this.encrypt(config),id)}
  listRuns(projectId){return (projectId?this.db.prepare('SELECT id FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId):this.db.prepare('SELECT id FROM runs ORDER BY created_at DESC LIMIT 100').all()).map(r=>this.run(r.id))}
  runnable(){return this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running','reconnecting','stopping') ORDER BY created_at LIMIT 20").all().map(r=>r.id)}
  addEvent(runId,nodeId,event){const id=event.id||randomBytes(12).toString('hex');const result=this.db.prepare('INSERT OR IGNORE INTO events(run_id,node_id,external_id,payload) VALUES(?,?,?,?)').run(runId,nodeId,id,JSON.stringify({...event,id,timestamp:event.timestamp||new Date().toISOString()}));if(result.changes)this.db.prepare('UPDATE runs SET revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(),runId)}
  events(runId,after=0){return this.db.prepare('SELECT seq,node_id,payload FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(runId,after).map(row=>({seq:row.seq,nodeId:row.node_id,...JSON.parse(row.payload)}))}
  setting(name){const r=this.db.prepare('SELECT value FROM settings WHERE name=?').get(name);return r?this.decrypt(r.value):null}
  setSetting(name,value){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,this.encrypt(value))}
  object(key,kind,id,revision,size){this.db.prepare('INSERT INTO objects VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,size=excluded.size,updated_at=excluded.updated_at').run(key,kind,id,revision,size,new Date().toISOString())}
  objectInfo(key){return this.db.prepare('SELECT key,kind,resource_id AS resourceId,revision,size,updated_at AS updatedAt FROM objects WHERE key=?').get(key)}
  objects(){return this.db.prepare('SELECT key,kind,resource_id AS resourceId,revision,size,updated_at AS updatedAt FROM objects ORDER BY updated_at DESC LIMIT 200').all()}
  close(){this.db.close()}
}
