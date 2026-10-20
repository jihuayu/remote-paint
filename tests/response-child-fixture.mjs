function responseChild(){
 let input=Buffer.alloc(0),queued=[],output=Promise.resolve();
 const packet=value=>{const bytes=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);return Buffer.concat([head,bytes]);};
 const send=value=>process.stdout.write(packet(value));
 async function fragments(bytes){for(let n=0;n<bytes.length;n+=32768){if(!process.stdout.write(bytes.subarray(n,n+32768)))await new Promise(resolve=>process.stdout.once('drain',resolve));await new Promise(setImmediate);}}
 send({event:'FixtureReady'});
 process.stdin.on('data',chunk=>{
  input=Buffer.concat([input,chunk]);
  while(input.length>=4){
   const size=input.readUInt32BE();if(input.length<size+4)return;
   const request=JSON.parse(input.subarray(4,size+4));input=input.length===size+4?Buffer.alloc(0):input.subarray(size+4);
   output=output.then(async()=>{
    if(request.op==='resourceBudget'){
     if(request.batch){queued.push(packet({id:request.id,result:{ready:true,fixture:true}}));if(queued.length===request.batch){process.stdout.write(Buffer.concat(queued));queued=[];}}
     else send({id:request.id,result:{ready:true,fixture:true}});
    }else if(request.op==='late'){
     const body=Buffer.from(JSON.stringify({result:request.value,id:request.id})),head=Buffer.alloc(4);head.writeUInt32BE(body.length);await fragments(Buffer.concat([head,body]));
    }else if(request.op==='partial-known'){
     const head=Buffer.alloc(4);head.writeUInt32BE(4*1024*1024);process.stdout.write(Buffer.concat([head,Buffer.from('{"id":'+request.id+',"result":"'),Buffer.alloc(192*1024,120)]));
    }else if(request.op==='invalid-utf8'){
     const body=Buffer.concat([Buffer.from('{"id":'+request.id+',"result":"'),Buffer.from([255]),Buffer.from('"}')]),head=Buffer.alloc(4);head.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([head,body]));
    }else if(request.op==='dense-event'){
     const message={type:'Input',sessionId:'fixture-session',lease:'fixture-lease',pageEpoch:1,viewportVersion:1,seq:1,event:{kind:'text',text:'ok',extra:Array(16000).fill(0)}};
     send({event:'Control',peerId:'fixture-peer',message});send({id:request.id,result:true});
    }else if(request.op==='deep'){let value=0;for(let n=0;n<request.depth;n++)value=[value];await fragments(packet({id:request.id,result:value}));}
    else if(request.op==='wide-event')await fragments(packet({event:'Control',message:'x'.repeat(300*1024)}));
    else await fragments(packet({id:request.id,result:Object.hasOwn(request,'value')?request.value:'x'.repeat(request.bytes??1)}));
   }).catch(()=>{});
  }
 });
 process.stdin.on('end',()=>process.exit(0));
}
export const responseFixture='#!/usr/bin/env node\n('+responseChild.toString()+')();\n';
