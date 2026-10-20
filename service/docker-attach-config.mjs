import {isAbsolute} from 'node:path';
import {dockerRuntimeCreateBody} from './docker-runtime-spec.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export class DockerAttachError extends Error {
 constructor(code){super('Docker attach transport is unavailable');this.name='DockerAttachError';this.code=code;}
}
export function captureDockerAttachSettings({socketPath,daemonId,architecture='arm64',apiVersion='1.45',connectTimeoutMs=5000,eofTimeoutMs=12000,maxStderrBytes=1048576}={}){
 if(typeof socketPath!=='string'||!isAbsolute(socketPath)||socketPath.length>1024||/[\x00-\x1f\x7f]/.test(socketPath)||!id(daemonId)||!['arm64','amd64'].includes(architecture)||!/^1\.[0-9]{2,3}$/.test(apiVersion)||!integer(connectTimeoutMs,50,10000)||!integer(eofTimeoutMs,50,15000)||!integer(maxStderrBytes,1024,1048576))throw new TypeError('Configure a pinned Unix Engine and finite private attach bounds');
 return Object.freeze({socketPath,daemonId,architecture,apiVersion,connectTimeoutMs,eofTimeoutMs,maxStderrBytes});
}
export function captureDockerAttachConfig(value){
 const keys=['schema','socketPath','daemonId','architecture','apiVersion','connectTimeoutMs','eofTimeoutMs','maxStderrBytes','containerId','plan'];
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))||value.schema!=='docker-attach-v1'||typeof value.containerId!=='string'||!/^[a-f0-9]{64}$/.test(value.containerId))throw new TypeError('Expected a fixed private attach configuration');
 const base=captureDockerAttachSettings(value);dockerRuntimeCreateBody(value.plan);if(value.plan.daemonId!==base.daemonId)throw new TypeError('Attach plan must bind the pinned daemon');const config={schema:'docker-attach-v1',...base,containerId:value.containerId,plan:structuredClone(value.plan)};
 if(Buffer.byteLength(JSON.stringify(config))>131072)throw new TypeError('Private attach configuration exceeds its budget');return config;
}
