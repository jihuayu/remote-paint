import {createViewer,ViewerChannelError,ViewerViewportError,type ViewerConfig,type ViewerState,type ViewerViewportResult} from '../../sdk/viewer.mjs';
const config:ViewerConfig={viewerOrigin:'https://viewer.example',gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket:async request=>{const signal:AbortSignal=request.signal;void signal;return {grantId:'vgr_fixture',sessionId:'ses_fixture',version:'v1',role:request.role,audience:'https://viewer.example',expiresAt:new Date().toISOString(),ticket:'vwt1.fixture',streamPath:'/v1/viewer/stream?ticket=vwt1.fixture'};}};
const viewer=createViewer(document.body,config);const element:HTMLElement=viewer.element;void element;
const ready=await viewer.ready;const origin:string=ready.gatewayOrigin;void origin;
const state:ViewerState=await viewer.connect({signal:new AbortController().signal});const role:'readonly'|'controller'=state.role;void role;
const unsubscribe=viewer.on('state',value=>{const generation:number=value.generation;void generation;});unsubscribe();viewer.on('error',error=>{const code:string=error.code;void code;});await viewer.disconnect();await viewer.destroy();
// @ts-expect-error backend credentials cannot enter browser component configuration
createViewer(document.body,{...config,apiKey:'private'});
// @ts-expect-error audience is derived from the trusted Viewer Origin
createViewer(document.body,{...config,audience:'https://other.example'});
// @ts-expect-error control roles do not include Agent permission
createViewer(document.body,{...config,role:'agent'});
// @ts-expect-error snapshots are immutable
state.state='connected';
// @ts-expect-error finite subscription names
viewer.on('execute',()=>{});
const error:unknown=new Error();if(error instanceof ViewerChannelError){const code:string=error.code;void code;}

const lease=await viewer.takeControl({signal:new AbortController().signal,timeoutMs:5000});const fence:number|null=lease.fencingToken;void fence;const held:boolean=lease.held;void held;await viewer.releaseControl();
// @ts-expect-error lease snapshots are immutable
lease.lease="private";

const changedRole=await viewer.setRole("controller",{signal:new AbortController().signal});const readonlyResult=await viewer.setReadonly(true);void[changedRole,readonlyResult];
// @ts-expect-error Agent execution permission cannot be selected as a Viewer role
await viewer.setRole("agent");
// @ts-expect-error readonly switch is boolean
await viewer.setReadonly("true");

const display=viewer.resize({width:640,height:360});const scope:"display"=display.scope;void scope;viewer.on("resize",size=>{const mode:"fixed"|"container"=size.mode;void mode;});viewer.resize();
// @ts-expect-error display sizing never accepts source viewport or arbitrary fields
viewer.resize({width:640,height:360,deviceScaleFactor:2});
// @ts-expect-error display snapshots are immutable
display.width=800;

const viewport:ViewerViewportResult=await viewer.resizeViewport({width:320,height:240},{signal:new AbortController().signal,timeoutMs:5000});const remoteScope:'viewport'=viewport.scope;const epoch:number=viewport.pageEpoch;void[remoteScope,epoch];
const viewportError=new ViewerViewportError('VIEWER_VIEWPORT_FAILED','unknown');if(error instanceof ViewerViewportError){const outcome:'not-applied'|'unknown'=error.outcome;const base:ViewerChannelError=error;void[outcome,base];}
// @ts-expect-error viewport error outcome is immutable
viewportError.outcome='not-applied';
// @ts-expect-error unknown Source outcome cannot be described as rollback
new ViewerViewportError('VIEWER_VIEWPORT_FAILED','rolled-back');
// @ts-expect-error remote viewport dimensions are required
await viewer.resizeViewport();
// @ts-expect-error arbitrary CDP/viewport fields cannot enter the API
await viewer.resizeViewport({width:320,height:240,deviceScaleFactor:2});
// @ts-expect-error options are finite and never accept CDP commands
await viewer.resizeViewport({width:320,height:240},{execute:'Runtime.evaluate'});
// @ts-expect-error applied viewport metadata is immutable
viewport.pageEpoch=100;
