import {SessionClient,SessionClientError,type SessionId,type OperationId,type Operation} from '../../sdk/backend.mjs';
const client=new SessionClient({baseUrl:'https://api.example.test',apiKey:'provided-by-backend-secret-manager',retries:1});
const prepared=client.sessions.prepareCreate({region:'test',ttlSeconds:60},{idempotencyKey:'persist-this-key'});
const created=await prepared.send({signal:new AbortController().signal});
const sessionId:SessionId=created.data.sessionId;
const operationId:OperationId=created.data.operationId;
const createKind:'create-session'=created.data.kind;
const status=await client.operations.get(operationId);
const session=await client.sessions.get(sessionId);
const released=await client.sessions.release(sessionId);
const releaseKind:'release-session'=released.data.kind;
function outcome(op:Operation){if(op.status==='failed'){const message:string=op.error.message;return message;}const absent:null=op.error;return absent;}
if(status.data.status==='failed'){const code:string=status.data.error.code;void code;}
const caught:unknown=new Error();if(caught instanceof SessionClientError){const uncertain:'not-dispatched'|'unknown'|'rejected'=caught.outcome;void uncertain;}
// @ts-expect-error explicit idempotency key is required
client.sessions.create({});
// @ts-expect-error backend tenant identity cannot come from input
client.sessions.create({tenantId:'other'},{idempotencyKey:'key'});
// @ts-expect-error Session ID cannot be an operation ID
client.sessions.get(operationId);
// @ts-expect-error operation ID cannot be a Session ID
client.operations.get(sessionId);
// @ts-expect-error returned Session metadata is readonly
session.data.state='closed';
// @ts-expect-error prepared creation cannot accept a replacement key/body
prepared.send({idempotencyKey:'replacement'});
// @ts-expect-error retry count is bounded
new SessionClient({baseUrl:'https://api.example.test',apiKey:'provided',retries:4});
void [createKind,releaseKind,outcome];
