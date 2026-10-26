import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {ApiError} from '../shared/openhands.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const tokenScopes=['read','write','run'];
export class Access {
 constructor(store){this.store=store}
 tokens(){return this.store.db.prepare('SELECT id,name,scopes,created_at AS createdAt,revoked FROM tokens ORDER BY created_at DESC').all().map(t=>({...t,scopes:JSON.parse(t.scopes)}))}
 create(input){const token='ohc_'+randomBytes(32).toString('base64url'),id=randomUUID(),name=String(input.name||'Codex').slice(0,80),scopes=Array.isArray(input.scopes)?[...new Set(input.scopes.filter(s=>tokenScopes.includes(s)))]:tokenScopes;if(!scopes.length)throw new ApiError('至少选择一项权限。');this.store.db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?,0)').run(id,name,hash(token),JSON.stringify(scopes),new Date().toISOString());return {id,name,scopes,token}}
 revoke(id){this.store.db.prepare('UPDATE tokens SET revoked=1 WHERE id=?').run(id);return {ok:true}}
 verify(token){if(typeof token!=='string'||token.length>300)return null;const row=this.store.db.prepare('SELECT id,scopes FROM tokens WHERE hash=? AND revoked=0').get(hash(token));return row?{id:row.id,scopes:JSON.parse(row.scopes)}:null}
 claim(){const code=randomBytes(18).toString('base64url');this.store.db.prepare('DELETE FROM claims WHERE expires<?').run(Date.now());this.store.db.prepare('INSERT INTO claims VALUES(?,?)').run(hash(code),Date.now()+600000);return {code,expiresAt:new Date(Date.now()+600000).toISOString()}}
 connect(code,principal){if(typeof code!=='string'||code.length>200||typeof principal!=='string'||principal.length>200||!principal)throw new ApiError('连接码或账户无效。');const row=this.store.db.prepare('SELECT expires FROM claims WHERE hash=?').get(hash(code));if(!row||row.expires<Date.now())throw new ApiError('连接码无效或已过期，请在网站设置中重新生成。',403);this.store.db.exec('BEGIN IMMEDIATE');try{this.store.db.prepare('DELETE FROM claims WHERE hash=?').run(hash(code));this.store.db.prepare('INSERT OR IGNORE INTO principals VALUES(?,?)').run(principal,new Date().toISOString());this.store.db.exec('COMMIT')}catch(e){this.store.db.exec('ROLLBACK');throw e}return {ok:true,message:'Codex 账户已连接工作台。'}}
 principals(){return this.store.db.prepare('SELECT id,created_at AS createdAt FROM principals ORDER BY created_at DESC').all()}
 disconnect(id){this.store.db.prepare('DELETE FROM principals WHERE id=?').run(id);return {ok:true}}
 principal(id){return !!this.store.db.prepare('SELECT id FROM principals WHERE id=?').get(id)}
 authorize(req,path,method){const token=req.headers['x-canvas-client-token'],principal=req.headers['x-canvas-principal'];let identity;if(token){identity=this.verify(token);if(!identity)throw new ApiError('访问令牌无效或已撤销。',401)}else if(principal){if(!this.principal(principal))throw new ApiError('请先在网站设置中生成连接码，再调用 canvas_connect 绑定账户。',403);identity={scopes:tokenScopes}}else return;
  const allowed=/^\/(projects|runs|engine|development)(\/|$)/.test(path);if(!allowed&&path!=='/storage'&&path!=='/storage/list'&&path!=='/health'&&path!=='/profiles'&&!(path==='/model-policy/preview'&&method==='POST'))throw new ApiError('此入口只允许管理项目和任务。',403);
  if(['/storage','/storage/list','/health','/profiles'].includes(path)&&method!=='GET')throw new ApiError('此入口仅允许读取状态。',403);
  const required=method==='GET'||path==='/model-policy/preview'||/^\/engine\/connections\/[^/]+\/test$/.test(path)?'read':path.startsWith('/runs')||path==='/engine/invocations'||/^\/engine\/pipelines\/[^/]+\/run$/.test(path)?'run':'write';if(!identity.scopes.includes(required))throw new ApiError('此访问令牌没有所需权限：'+required,403);return identity;
 }
}
