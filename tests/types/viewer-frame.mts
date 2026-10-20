import {ViewerFrameConnection,ViewerChannelError,ViewerViewportError,type ViewerFrameConfig,type ViewerViewportResult} from '../../sdk/viewer-frame.mjs';
const options:ViewerFrameConfig={frameWindow:window,frameOrigin:'https://viewer.example',gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',role:'readonly',getTicket:async request=>{const signal:AbortSignal=request.signal;void signal;return {grantId:'vgr_fixture',sessionId:'ses_fixture',version:'v1',role:'readonly',audience:'https://viewer.example',expiresAt:new Date().toISOString(),ticket:'vwt1.fixture',streamPath:'/v1/viewer/stream?ticket=vwt1.fixture'};}};
const frame=new ViewerFrameConnection(options);const ready=await frame.ready;const origin:string=ready.gatewayOrigin;void origin;
const state=await frame.connect({signal:new AbortController().signal});const role:'readonly'|'controller'|undefined=state.role;void role;await frame.getState();await frame.disconnect();frame.close();
// @ts-expect-error management credentials cannot enter the frame configuration
new ViewerFrameConnection({...options,apiKey:'private'});
// @ts-expect-error audience is derived from the trusted frame Origin
new ViewerFrameConnection({...options,audience:'https://other.example'});
// @ts-expect-error Agent permission is separate from Viewer roles
new ViewerFrameConnection({...options,role:'agent'});
// @ts-expect-error state snapshots are immutable
state.state='connected';
const caught:unknown=new Error();if(caught instanceof ViewerChannelError){const code:string=caught.code;void code;}

const lease=await frame.takeControl({signal:new AbortController().signal,timeoutMs:5000});const fence:number|null=lease.fencingToken;void fence;const held:boolean=lease.held;void held;await frame.releaseControl();
// @ts-expect-error lease snapshots are immutable
lease.lease="private";

const viewport:ViewerViewportResult=await frame.resizeViewport({width:320,height:240},{signal:new AbortController().signal,timeoutMs:5000});const viewportScope:'viewport'=viewport.scope;void viewportScope;
if(caught instanceof ViewerViewportError){const outcome:'not-applied'|'unknown'=caught.outcome;const base:ViewerChannelError=caught;void[outcome,base];}
// @ts-expect-error viewport snapshots are immutable
viewport.width=640;
// @ts-expect-error finite CSS viewport only; DPR is Source-owned
await frame.resizeViewport({width:320,height:240,deviceScaleFactor:2});
// @ts-expect-error source viewport dimensions are required
await frame.resizeViewport();
