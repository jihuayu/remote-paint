import {createHash} from 'node:crypto';
const sameNamespace=(a,b)=>Array.isArray(a)&&a.length===2&&a.every((n,i)=>Number.isSafeInteger(n)&&n>=0&&n===b[i]);
const finite=(a,count)=>Array.isArray(a)&&a.length===count&&a.every(n=>Number.isFinite(n)&&Math.abs(n)<1e7);
export class SceneMapper {
 constructor(){this.entries=new Map();this.revision=0;}
 reset(){this.entries.clear();this.revision=0;}
 map(capture,pageEpoch){
  const viz=capture.viz;
  if(!viz||viz.captureId!==capture.captureId||!Array.isArray(viz.namespace)||viz.namespace.length!==2||
    typeof capture.producer!=='string'||!Number.isSafeInteger(pageEpoch)||pageEpoch<1)throw new Error('Unpaired compositor/Viz capture');
  if(!Array.isArray(capture.resources)||capture.resources.length>256||!Array.isArray(viz.passes)||!viz.passes.length||viz.passes.length>64)throw new Error('Invalid native scene size');
  const byId=new Map(capture.resources.map(r=>[r.localId,r]));
  if(byId.size!==capture.resources.length)throw new Error('Duplicate native content ID');
  const payloads=new Map(),entries=new Map(),passes=[],passIds=new Set();let quads=0;
  for(const pass of viz.passes){
   if(typeof pass.id!=='string'||passIds.has(pass.id)||!finite(pass.output,4)||!Array.isArray(pass.quads))throw new Error('Invalid Viz render pass');
   const mapped=[];
   for(const q of pass.quads){
    if(++quads>2048||!finite(q.matrix,9)||!finite(q.visible,4)||!finite(q.rect,4)||q.clip&&!finite(q.clip,4)||!Number.isFinite(q.opacity)||q.opacity<0||q.opacity>1)throw new Error('Invalid Viz quad');
    const out={kind:q.kind,matrix:q.matrix,visible:q.visible,rect:q.rect,clip:q.clip??null,opacity:q.opacity};
    if(q.kind==='solid'){
     if(!finite(q.color,4)||q.color.some(c=>c<0||c>1))throw new Error('Invalid Viz color');out.color=q.color;
    }else if(q.kind==='pass'){
     if(!passIds.has(q.passId))throw new Error('Cyclic or missing Viz pass');out.passId=q.passId;
    }else if(q.kind==='picture'){
     if(!sameNamespace(q.namespace,viz.namespace))throw new Error('Child Surface painting is not implemented');
     const r=byId.get(q.localId);
     if(!r||!Number.isInteger(r.localId)||!Number.isFinite(r.quadScale)||r.quadScale<=0||r.quadScale>128||
       ![r.width,r.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192))throw new Error('Viz content has no matching native full-layer record');
     const logical=`${pageEpoch}/${capture.producer}/${viz.namespace.join(':')}/${r.localId}`;
     let entry=entries.get(logical);
     if(!entry){
      const bytes=Buffer.from(r.skp,'base64');if(bytes.length<28||bytes.length>16*1024*1024||bytes.subarray(0,8).toString()!=='skiapict')throw new Error('Invalid native SKP');
      const hash=createHash('sha256').update(bytes).digest('hex');const old=this.entries.get(logical);
      entry={logical,resourceId:hash,revision:old?.resourceId===hash?old.revision:++this.revision};entries.set(logical,entry);payloads.set(hash,bytes);
     }
     Object.assign(out,entry,{quadScale:r.quadScale,width:r.width,height:r.height,
       source:{namespace:q.namespace,stableLayerId:q.localId,vizResource:q.vizResource}});
    }else throw new Error('Unknown Viz quad');
    mapped.push(out);
   }
   passIds.add(pass.id);passes.push({id:pass.id,output:pass.output,quads:mapped});
  }
  const released=[...this.entries.keys()].filter(k=>!entries.has(k));this.entries=entries;
  if([...payloads.values()].reduce((n,b)=>n+b.length,0)>64*1024*1024)throw new Error('Scene resource budget exceeded');
  return {scene:{rootPass:passes.at(-1).id,passes},payloads,released,mappings:[...entries.values()],
    native:{captureId:capture.captureId,producer:capture.producer,namespace:viz.namespace,frameToken:capture.frameToken,sourceFrame:capture.sourceFrame}};
 }
}
