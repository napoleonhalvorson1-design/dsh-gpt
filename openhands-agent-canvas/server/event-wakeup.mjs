// Push only wakes the authoritative REST reader. Streamed text never completes a stage.
export class EventWakeup {
 constructor(config,id,{socket=globalThis.WebSocket}={}){
  this.version=0;this.waiters=new Set();this.closed=false;this.connected=false;
  if(!config.eventStream||!socket)return;
  try{const url=new URL(config.baseUrl+'/sockets/events/'+encodeURIComponent(id));url.protocol=url.protocol==='https:'?'wss:':'ws:';this.socket=new socket(url);
   this.socket.addEventListener('open',()=>{if(!this.closed)this.socket.send(JSON.stringify({type:'auth',session_api_key:config.apiKey}))});
   this.socket.addEventListener('message',event=>{if(typeof event.data!=='string'||event.data.length>2000000)return;let data;try{data=JSON.parse(event.data)}catch{return}this.connected=true;const status=data.key==='execution_status'?data.value:data.key==='full_state'?data.value?.execution_status:null;
    if(status&&status!=='running'||data.action?.kind==='FinishAction'||/Error/.test(data.kind||''))this.wake();
   });
   for(const name of ['error','close'])this.socket.addEventListener(name,()=>{this.connected=false;this.wake()});
  }catch{this.socket=null}
 }
 wake(){this.version++;for(const resolve of [...this.waiters])resolve()}
 wait(version,ms){if(this.closed||version!==this.version)return Promise.resolve();return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.waiters.delete(done);resolve()},timer=setTimeout(done,ms);this.waiters.add(done);if(this.closed||version!==this.version)done()})}
 close(){if(this.closed)return;this.closed=true;this.wake();try{this.socket?.close()}catch{}}
}
