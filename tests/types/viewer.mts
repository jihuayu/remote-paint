import {createViewer,ViewerChannelError,type ViewerConfig,type ViewerState} from '../../sdk/viewer.mjs';
const config:ViewerConfig={viewerOrigin:'https://viewer.example',gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket:async request=>{const signal:AbortSignal=request.signal;void signal;return {grantId:'vgr_fixture',sessionId:'ses_fixture',version:'v1',role:'readonly',audience:'https://viewer.example',expiresAt:new Date().toISOString(),ticket:'vwt1.fixture',streamPath:'/v1/viewer/stream?ticket=vwt1.fixture'};}};
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
