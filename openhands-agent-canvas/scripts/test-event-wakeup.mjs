import assert from 'node:assert/strict';
import {EventWakeup} from '../server/event-wakeup.mjs';
class Socket extends EventTarget {
 constructor(url){super();Socket.last=this;this.url=String(url);this.sent=[]}
 send(message){this.sent.push(JSON.parse(message))}
 close(){this.dispatchEvent(new Event('close'))}
 message(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}))}
}
const feed=new EventWakeup({eventStream:true,baseUrl:'https://native.example/silicon',apiKey:'private-key'},'conversation',{socket:Socket}),socket=Socket.last;
assert.equal(socket.url,'wss://native.example/silicon/sockets/events/conversation');assert(!socket.url.includes('private-key'));
socket.dispatchEvent(new Event('open'));assert.deepEqual(socket.sent,[{type:'auth',session_api_key:'private-key'}]);
const before=feed.version;socket.message({kind:'MessageEvent',text:'a token'});socket.message({key:'execution_status',value:'running'});assert.equal(feed.version,before);
const waiting=feed.wait(feed.version,5000);socket.message({key:'execution_status',value:'finished'});await waiting;assert(feed.version>before);
// A terminal message during the REST request cannot be lost before the waiter registers.
const stale=feed.version;socket.message({key:'full_state',value:{execution_status:'error'}});await feed.wait(stale,5000);
const closed=feed.wait(feed.version,5000);feed.close();await closed;assert.equal(feed.waiters.size,0);
const fallback=new EventWakeup({eventStream:false},'id',{socket:Socket});await fallback.wait(0,1);fallback.close();
console.log('Passed event wake-up authentication, terminal filtering, lost-wake race, close and polling fallback checks.');
