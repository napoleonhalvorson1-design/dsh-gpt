/* Assets are embedded by scripts/build.mjs, never served outside the authentication boundary. */
const attempts=new Map();
const encoder=new TextEncoder();
const COOKIE='__Host-oh_canvas';
const AGE=43200;
function base64url(bytes){return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function from64(value){const text=value.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(text+'='.repeat((4-text.length%4)%4)),c=>c.charCodeAt(0))}
async function key(secret){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])}
async function sign(value,secret){return base64url(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(value)))}
async function validSession(request,secret){try{const value=request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);if(!value)return false;const [payload,sig,...extra]=value.split('.');if(!sig||extra.length)return false;const data=JSON.parse(new TextDecoder().decode(from64(payload)));const now=Date.now();if(!Number.isFinite(data.exp)||data.exp<now||data.exp>now+(AGE+60)*1000)return false;return crypto.subtle.verify('HMAC',await key(secret),from64(sig),encoder.encode(payload))}catch{return false}}
const security={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
function response(body,status=200,headers={}){return new Response(body,{status,headers:{...security,...headers}})}
function json(data,status=200,headers={}){return response(JSON.stringify(data),status,{'Content-Type':'application/json; charset=utf-8',...headers})}
function loginReturnTarget(url){try{const next=new URL(url.searchParams.get('next')||'/',url.origin);return next.origin===url.origin?next.pathname+next.search+next.hash:'/'}catch{return '/'}}
function loginRedirect(url){return '/login'+(url.pathname==='/'&&!url.search?'':'?next='+encodeURIComponent(url.pathname+url.search))}
function redirect(to,cookie){return response(null,303,{Location:to,...(cookie?{'Set-Cookie':cookie}:{})})}
export default{async fetch(request,env){const url=new URL(request.url),path=url.pathname;
if(!env.CANVAS_ACCESS_PASSWORD||!env.CANVAS_SESSION_SECRET)return response('工作台尚未完成密码配置，请联系管理员。',503,{'Content-Type':'text/plain; charset=utf-8'});
if(path==='/mcp')return handleMcp(request,env);
if(path==='/api/login'){
if(request.method!=='POST')return json({error:'请使用 POST 请求。'},405,{Allow:'POST'});
if(request.headers.get('Origin')!==url.origin)return json({error:'请求来源无效。'},403);
if(Number(request.headers.get('Content-Length')||0)>4096)return json({error:'请求过大。'},413);
const ip=request.headers.get('CF-Connecting-IP')||'unknown',now=Date.now();if(attempts.size>10000){for(const [k,v]of attempts){if(v.until<now)attempts.delete(k)}}const previous=attempts.get(ip);if(previous&&previous.until>now&&previous.count>=8)return json({error:'尝试次数过多，请 10 分钟后再试。'},429,{'Retry-After':'600'});
let password;try{const body=await request.text();if(body.length>4096)return json({error:'请求过大。'},413);password=JSON.parse(body).password;if(typeof password!=='string'||password.length>200)throw Error()}catch{return json({error:'请输入有效密码。'},400)}
const expected=await crypto.subtle.sign('HMAC',await key(env.CANVAS_SESSION_SECRET),encoder.encode(env.CANVAS_ACCESS_PASSWORD));const valid=await crypto.subtle.verify('HMAC',await key(env.CANVAS_SESSION_SECRET),expected,encoder.encode(password));
if(!valid){attempts.set(ip,{count:previous&&previous.until>now?previous.count+1:1,until:previous&&previous.until>now?previous.until:now+600000});return json({error:'密码不正确，请重新输入。'},401)}attempts.delete(ip);
const payload=base64url(encoder.encode(JSON.stringify({exp:now+AGE*1000,nonce:crypto.randomUUID()}))),token=payload+'.'+await sign(payload,env.CANVAS_SESSION_SECRET);return json({ok:true},200,{'Set-Cookie':`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${AGE}`})}
if(path==='/logout')return redirect('/login',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
const loggedIn=await validSession(request,env.CANVAS_SESSION_SECRET);
if(path==='/login')return loggedIn?redirect(loginReturnTarget(url)):response(ASSETS['/login'].body,200,{'Content-Type':'text/html; charset=utf-8'});
if(!loggedIn){if(path.startsWith('/api/')){let identity;try{identity=await machineIdentity(request,env)}catch(error){return json({error:error.message},error.status||503)}if(identity)return handleBackend(request,env,true);if(request.method==='GET'&&request.headers.get('Accept')?.includes('text/html')&&/^\/api\/runs\/[a-zA-Z0-9_-]{1,100}\/(artifacts|file-download)$/.test(path))return redirect(loginRedirect(url));return json({error:'请先登录或使用有效访问令牌。'},401)}return redirect(loginRedirect(url))}
if(path.startsWith('/api/'))return handleBackend(request,env);
if(request.method!=='GET'&&request.method!=='HEAD')return response('不支持的请求方法。',405,{Allow:'GET, HEAD'});
const asset=ASSETS[path==='/'?'/index.html':path];if(!asset||path==='/login')return response('页面不存在。',404,{'Content-Type':'text/plain; charset=utf-8'});
const headers={'Content-Type':asset.type,...(asset.filename?{'Content-Disposition':'attachment; filename="'+asset.filename+'"'}:{})};
if(!['/','/index.html'].includes(path)&&asset.etag){headers.ETag=asset.etag;headers['Cache-Control']='private, no-cache';if(request.headers.get('If-None-Match')?.split(',').some(value=>value.trim().replace(/^W\//,'')===asset.etag))return response(null,304,headers)}
return response(request.method==='HEAD'?null:asset.encoding==='base64url'?from64(asset.body):asset.body,200,headers);}};
