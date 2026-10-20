// Trusted HTTP sink. Each <=3072-byte Buffer stays owned until its real write
// callback. The HTTP request also awaits finish/close, with end capacity separate.
export function createAgentDownloadHttpSink(res,requestId,signal){
 let started=false,finished=false,closed=false,writeError=null;let complete;
 const done=new Promise(resolve=>complete=resolve),settled=()=>{if(!finished&&!closed)return;complete();};
 const finish=()=>{finished=true;settled();},close=()=>{closed=true;settled();},error=()=>{writeError=Error('Download response could not be written');};
 res.once('finish',finish);res.once('close',close);res.on('error',error);
 const abort=()=>{if(started&&!finished)res.destroy();};signal.addEventListener('abort',abort,{once:true});
 const current=()=>{if(signal.aborted)throw signal.reason;if(closed||writeError)throw Error('Download response is closed');};
 return Object.freeze({
  start(file){current();if(started)throw Error('Download response already started');started=true;res.writeHead(200,{'content-type':'application/octet-stream','content-length':file.byteLength,'content-disposition':'attachment; filename="'+file.downloadId+'.bin"','content-digest':'sha-256=:'+Buffer.from(file.sha256,'hex').toString('base64')+':','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId,'x-download-id':file.downloadId,'x-download-sha256':file.sha256,'x-download-completed-at':file.completedAt,'x-agent-observation-context':Buffer.from(JSON.stringify(file.context)).toString('base64url'),'connection':'close'});},
  async write(bytes){current();if(!started||!Buffer.isBuffer(bytes)||bytes.length>3072)throw Error('Invalid download response chunk');await new Promise((resolve,reject)=>{try{res.write(bytes,error=>error?reject(Error('Download response write failed')):resolve());}catch{reject(Error('Download response write failed'));}});current();},
  async finish(){current();res.end();await done;current();if(!finished)throw Error('Download response was interrupted');},
  async cleanup(){signal.removeEventListener('abort',abort);if(started){if(!finished&&!closed)res.destroy();await done;}res.off('finish',finish);res.off('close',close);if(closed)res.off('error',error);else res.once('close',()=>res.off('error',error));}
 });
}
