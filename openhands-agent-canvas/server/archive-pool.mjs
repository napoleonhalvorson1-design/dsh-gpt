// One process budget for all controller archive operations, across every workflow.
let active=0;const waiting=[];
export async function withArchiveWorker(operation){
 await new Promise(resolve=>{if(active<2){active++;resolve()}else waiting.push(resolve)});
 try{return await operation()}finally{const next=waiting.shift();if(next)next();else active--}
}
