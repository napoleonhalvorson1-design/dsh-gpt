/* Artifact code stays in an opaque-origin iframe. Only its own preview data crosses the boundary. */
const PREVIEW_LIMIT=1024*1024,PREVIEW_ASSET_LIMIT=8*1024*1024;
let disposeArtifactPreview=()=>{};
function artifactRelativePath(base,value){
 if(!value||/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value))return null;
 const root=new URL('https://artifact.invalid/'+base),u=new URL(value,root);if(u.origin!==root.origin)return null;
 let path;try{path=decodeURIComponent(u.pathname.slice(1))}catch{return null}if(!path||path.split('/').some(p=>p==='..'||!p)||/[\x00-\x1f\\]/.test(path))return null;return path;
}
function previewStorageBootstrap(channel,initial){
 const values=new Map(Object.entries(initial));
 const sync=()=>{const value=Object.fromEntries(values);if(JSON.stringify(value).length>1024*1024)throw new DOMException('预览数据超过 1 MiB。','QuotaExceededError');parent.postMessage({type:'canvas-preview-storage',channel,value},'*')};
 const api={getItem:key=>values.has(String(key))?values.get(String(key)):null,setItem:(key,value)=>{key=String(key);value=String(value);const old=values.get(key);values.set(key,value);try{sync()}catch(e){if(old===undefined)values.delete(key);else values.set(key,old);throw e}},removeItem:key=>{values.delete(String(key));sync()},clear:()=>{values.clear();sync()},key:index=>[...values.keys()][Number(index)]??null};Object.defineProperty(api,'length',{get:()=>values.size,configurable:true});
 const storage=new Proxy(api,{get:(o,k)=>typeof k==='symbol'||k in o?Reflect.get(o,k):values.get(k),set:(o,k,v)=>{api.setItem(k,v);return true},deleteProperty:(o,k)=>{api.removeItem(k);return true},ownKeys:()=>[...values.keys()],getOwnPropertyDescriptor:(o,k)=>values.has(k)?{enumerable:true,configurable:true,value:values.get(k),writable:true}:Reflect.getOwnPropertyDescriptor(o,k)});
 Object.defineProperty(window,'localStorage',{value:storage,configurable:false});
}
async function mountArtifactPreview(run,path,html,frame){
 disposeArtifactPreview();const channel=crypto.randomUUID(),key='openhands-preview:'+run.id+':'+path;let initial={};
 try{const text=localStorage.getItem(key);if(text&&text.length<=PREVIEW_LIMIT){const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.values(parsed).every(v=>typeof v==='string'))initial=parsed}}catch{}
 const doc=new DOMParser().parseFromString(html,'text/html'),assets=new Map();let total=html.length;
 async function asset(name,binary=false){if(assets.has(name))return assets.get(name);if(assets.size>=24)throw Error('预览依赖文件超过 24 个，请下载完整项目运行。');const pending=(async()=>{if(!binary){const file=await api('/api/runs/'+run.id+'/file?'+new URLSearchParams({path:name}),{timeout:90000});total+=file.content.length;if(total>PREVIEW_ASSET_LIMIT)throw Error('预览文件较大，请下载完整项目运行。');return file.content}const r=await fetch('/api/runs/'+run.id+'/file-download?'+new URLSearchParams({path:name}));if(!r.ok)throw Error('无法读取预览资源：'+name);const data=new Uint8Array(await r.arrayBuffer());total+=data.length;if(total>PREVIEW_ASSET_LIMIT)throw Error('预览文件较大，请下载完整项目运行。');let value='';for(let i=0;i<data.length;i+=8192)value+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(value)})();assets.set(name,pending);return pending}
 for(const element of [...doc.querySelectorAll('script[src],link[rel="stylesheet"][href],img[src]')]){
  const attr=element.tagName==='LINK'?'href':'src',name=artifactRelativePath(path,element.getAttribute(attr));if(!name)continue;
  if(element.tagName==='SCRIPT'){const content=await asset(name);element.removeAttribute('src');element.removeAttribute('integrity');element.textContent=content.replace(/<\/script/gi,'<\\/script')}
  else if(element.tagName==='LINK'){const style=doc.createElement('style');style.textContent=await asset(name);element.replaceWith(style)}
  else{const ext=name.split('.').at(-1).toLowerCase(),mime={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif'}[ext];if(mime){element.setAttribute('src','data:'+mime+';base64,'+await asset(name,true));element.removeAttribute('srcset')}}
 }
 const script=doc.createElement('script'),encoded=value=>JSON.stringify(value).replace(/</g,'\\u003c');script.textContent='('+previewStorageBootstrap.toString()+')('+encoded(channel)+','+encoded(initial)+');';doc.head.prepend(script);
 const receive=event=>{const d=event.data;if(event.source!==frame.contentWindow||d?.type!=='canvas-preview-storage'||d.channel!==channel||!d.value||typeof d.value!=='object'||Array.isArray(d.value))return;if(Object.keys(d.value).length>1000||!Object.values(d.value).every(v=>typeof v==='string'))return;const text=JSON.stringify(d.value);if(text.length>PREVIEW_LIMIT)return;try{localStorage.setItem(key,text)}catch{toast('浏览器未能保存预览数据。请下载项目使用。')}};
 if(!frame.isConnected)return;window.addEventListener('message',receive);disposeArtifactPreview=()=>window.removeEventListener('message',receive);frame.srcdoc='<!doctype html>\n'+doc.documentElement.outerHTML;
}
$('#modal').addEventListener('close',()=>disposeArtifactPreview());
