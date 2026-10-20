import {ViewerConnection,ViewerTicketSource,ViewerConnectionError,type ViewerGrant,type ViewerTicketConfig} from '../../sdk/viewer-connection.mjs';
const options:ViewerTicketConfig={gatewayOrigin:'https://gateway.example',audience:'https://viewer.example',sessionId:'ses_fixture',role:'readonly',getTicket:async request=>{
 const id:`vgr_${string}`|null=request.previousGrantId;const signal:AbortSignal=request.signal;const requested:'readonly'|'controller'=request.role;const previous:'readonly'|'controller'|null=request.previousRole;void[id,signal,requested,previous];
 return {grantId:'vgr_fixture',sessionId:'ses_fixture',version:'v1',role:request.role,audience:'https://viewer.example',expiresAt:new Date().toISOString(),ticket:'vwt1.fixture',streamPath:'/v1/viewer/stream?ticket=vwt1.fixture'};
}};
const source=new ViewerTicketSource(options);const ticket:ViewerGrant=await source.getTicket();const role:'readonly'|'controller'=ticket.role;void role;
const connection=new ViewerConnection({...options,onSocket:(socket,grant,control)=>{const same:`ses_${string}`=grant.sessionId;void same;socket.binaryType='arraybuffer';control.acceptWelcome({viewerSessionId:grant.sessionId,viewerGrantId:grant.grantId,viewerVersion:grant.version,viewerRole:grant.role,input:false,inputFeedback:false,control:null});},onState:state=>{const id:`ses_${string}`=state.sessionId;void id;},onError:error=>{const retry:boolean=error.retryable;void retry;}});
connection.stop();connection.destroy();source.destroy();
// @ts-expect-error backend credentials cannot enter the browser configuration
new ViewerTicketSource({...options,apiKey:'private'});
// @ts-expect-error Agent permission is independent of Viewer roles
new ViewerTicketSource({...options,role:'agent'});
// @ts-expect-error retry count is bounded
new ViewerConnection({...options,onSocket(){},maxRetries:6});
// @ts-expect-error ticket data is immutable
ticket.role='controller';
// @ts-expect-error public welcome must bind the stable Session
new ViewerConnection({...options,onSocket(socket,grant,control){control.acceptWelcome({viewerRole:'readonly',input:false,inputFeedback:false,control:null});}});
const caught:unknown=new Error();if(caught instanceof ViewerConnectionError){const safe:string=caught.code;void safe;}

const changed=source.setRole("controller");const changedRole:"readonly"|"controller"=changed.role;void changedRole;
// @ts-expect-error Agent scope is not a Viewer role
source.setRole("agent");
