from __future__ import annotations
import base64
import copy
from dataclasses import FrozenInstanceError,asdict
import json
import os
from pathlib import Path
import subprocess
import unittest
from remote_paint_session import (AgentClientError,AgentRunId,AgentEventCursor,AgentEventItem,AgentInvocationEvent,
    AgentReadyMessage,AgentHeartbeatMessage,AgentCheckpointMessage)
from remote_paint_session._event_stream_parser import _AgentSseDecoder
from remote_paint_session._transport import RequestId
from test_agent_events_client import RUN,SID,AT,uid,cursor,event,gap

def ready(after=0,latest=2,**patch):return dict(schema='agent-event-stream-v1',agentRunId=RUN,historyOrigin='created',after=cursor(after),oldestCursor=cursor(max(0,latest-64)),latestCursor=cursor(latest),cursor=cursor(after))|patch
def heartbeat(n=0,**patch):return dict(schema='agent-heartbeat-v1',agentRunId=RUN,cursor=cursor(n),observedAt=AT)|patch
def checkpoint(n=0,**patch):return dict(schema='agent-event-checkpoint-v1',agentRunId=RUN,cursor=cursor(n),reason='duration')|patch
def frame(kind,data,id=None):return (('event: '+kind+'\n')+('id: '+id+'\n'if id is not None else'')+'data: '+json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n\n').encode()
def drain(decoder,chunk):
 decoder.offer_chunk(chunk);result=[]
 while decoder.has_buffered_bytes:
  message=decoder.pull()
  if message is not None:result.append(message);decoder.acknowledge(message)
 return result
def opened(**options):
 decoder=_AgentSseDecoder(RUN,**options);decoder.begin_window(RequestId('req_parser'));return decoder

class ParserContracts(unittest.TestCase):
 def error(self,call,code='CLIENT_INVALID_RESPONSE'):
  with self.assertRaises(AgentClientError)as error:call()
  self.assertEqual(error.exception.code,code);return error.exception
 def rejects(self,wire,code='CLIENT_INVALID_RESPONSE'):
  decoder=opened();error=self.error(lambda:drain(decoder,wire),code);self.assertEqual(decoder.last_delivered_cursor,cursor(0));return decoder,error
 def test_constructor_and_window_inputs_reject_noncanonical_ids_cursors_and_limits(self):
  for options in [dict(after=cursor(0)+'\n'),dict(after=cursor(0).replace('.0','.01')),dict(after=cursor(0).replace(RUN,'arun_'+uid(99))),dict(after=cursor(0).replace('.0','.9007199254740992')),dict(max_bytes=4095),dict(max_bytes=True),dict(max_bytes=1048577),dict(max_windows=0),dict(max_windows=5),dict(max_windows=True)]:self.error(lambda:_AgentSseDecoder(RUN,**options),'CLIENT_INVALID_REQUEST')
  self.error(lambda:_AgentSseDecoder(AgentRunId('arun_bad')),'CLIENT_INVALID_REQUEST')
  for request_id in ['','bad','req_'+('x'*125),'req_x\n']:
   decoder=_AgentSseDecoder(RUN);self.error(lambda:decoder.begin_window(RequestId(request_id)))
  decoder=opened();drain(decoder,frame('ready',ready())+frame('checkpoint',checkpoint()));decoder.end_of_file();error=self.error(lambda:decoder.begin_window(RequestId('bad')));self.assertIsNone(error.request_id)
 def test_ready_event_heartbeat_checkpoint_are_frozen_correlated_and_ordered(self):
  decoder=opened();messages=drain(decoder,frame('ready',ready())+frame('agent',event(1),cursor(1))+frame('heartbeat',heartbeat(1))+frame('checkpoint',checkpoint(1)));decoder.end_of_file()
  self.assertEqual([m.kind for m in messages],['ready','event','heartbeat','checkpoint']);self.assertIsInstance(messages[0],AgentReadyMessage);self.assertIsInstance(messages[1],AgentEventItem);self.assertIsInstance(messages[2],AgentHeartbeatMessage);self.assertIsInstance(messages[3],AgentCheckpointMessage)
  for message in messages:
   self.assertEqual(message.request_id,'req_parser')
   with self.assertRaises(FrozenInstanceError):message.cursor=cursor(99)
  with self.assertRaises(FrozenInstanceError):messages[1].event.data.holds_writer=False
  self.assertEqual(decoder.last_delivered_cursor,cursor(1));self.assertFalse(decoder.status().active_window)
 def test_utf8_and_crlf_are_incremental_at_every_byte_boundary(self):
  wire=(frame('ready',ready())+frame('agent',event(1,version='版本😀'),cursor(1))+frame('checkpoint',checkpoint(1))).replace(b'\n',b'\r\n');decoder=opened();messages=[]
  for byte in wire:messages.extend(drain(decoder,bytes([byte])))
  decoder.end_of_file();self.assertEqual([m.kind for m in messages],['ready','event','checkpoint']);self.assertEqual(messages[1].event.version,'版本😀');self.assertEqual(decoder.status().received_bytes,len(wire))
 def test_demand_driven_one_chunk_one_pending_and_cooperative_scan_quantum(self):
  decoder=opened();wire=frame('ready',ready())+frame('agent',event(1),cursor(1));decoder.offer_chunk(wire);first=decoder.pull();self.assertTrue(decoder.status().pending_message);self.error(decoder.pull,'CLIENT_EVENT_STREAM_BUSY');self.error(lambda:decoder.offer_chunk(b'next'),'CLIENT_EVENT_STREAM_BUSY');self.error(lambda:decoder.begin_window(RequestId('req_parallel')),'CLIENT_EVENT_STREAM_BUSY');self.assertEqual(decoder.status().windows,1);self.assertEqual(decoder.status().retained_chunk_bytes,len(wire));decoder.acknowledge(first);second=decoder.pull();self.assertEqual(second.kind,'event');decoder.acknowledge(second);self.assertEqual(decoder.status().retained_chunk_bytes,0)
  comments=(b':'+b'x'*997+b'\n\n')*20;decoder.offer_chunk(comments);self.assertIsNone(decoder.pull());self.assertTrue(decoder.has_buffered_bytes);self.assertEqual(decoder.status().unconsumed_chunk_bytes,len(comments)-8192)
  while decoder.has_buffered_bytes:self.assertIsNone(decoder.pull())
  self.assertFalse(decoder.status().pending_message);decoder.discard_window()
 def test_only_original_delivery_acknowledgement_commits_captured_cursor(self):
  decoder=opened();drain(decoder,frame('ready',ready()));decoder.offer_chunk(frame('agent',event(1),cursor(1)));message=decoder.pull();self.assertEqual(decoder.last_delivered_cursor,cursor(0));self.error(lambda:decoder.acknowledge(copy.deepcopy(message)),'CLIENT_INVALID_REQUEST');self.assertEqual(decoder.last_delivered_cursor,cursor(0))
  object.__setattr__(message,'cursor',cursor(99));object.__setattr__(message.event,'event_id','aevt_'+uid(999));decoder.acknowledge(message);self.assertEqual(decoder.last_delivered_cursor,cursor(1));self.assertEqual(decoder.status().retained_event_ids,1)
  messages=drain(decoder,frame('agent',event(2),cursor(2)));self.assertEqual(messages[0].event.sequence,2)
  error=self.error(lambda:drain(decoder,frame('agent',event(3,eventId=event(1)['eventId']),cursor(3))));self.assertEqual(error.cursor,cursor(2))
 def test_discarded_undelivered_event_replays_from_last_delivered_cursor(self):
  decoder=opened();drain(decoder,frame('ready',ready()));decoder.offer_chunk(frame('agent',event(1),cursor(1)));unseen=decoder.pull();decoder.discard_window();self.assertEqual(decoder.last_delivered_cursor,cursor(0));self.assertEqual(decoder.status().retained_event_ids,0);decoder.begin_window(RequestId('req_second'));drain(decoder,frame('ready',ready()));decoder.offer_chunk(frame('agent',event(1),cursor(1)));replayed=decoder.pull();self.error(lambda:decoder.acknowledge(unseen),'CLIENT_INVALID_REQUEST');decoder.acknowledge(replayed);self.assertEqual(decoder.last_delivered_cursor,cursor(1));self.assertEqual(decoder.status().decoded_events,2)
 def test_complete_checkpoint_window_requires_actual_eof_and_no_pending_bytes(self):
  decoder=opened();decoder.offer_chunk(frame('ready',ready())+frame('checkpoint',checkpoint()));message=decoder.pull();self.error(decoder.end_of_file,'CLIENT_EVENT_STREAM_BUSY');decoder.acknowledge(message);message=decoder.pull();self.error(decoder.end_of_file,'CLIENT_EVENT_STREAM_BUSY');decoder.acknowledge(message);self.assertTrue(decoder.status().active_window);decoder.end_of_file();self.assertFalse(decoder.status().active_window);self.assertEqual(decoder.last_delivered_cursor,cursor(0))
 def test_eof_without_checkpoint_is_retryable_and_keeps_acknowledged_cursor(self):
  decoder=opened();drain(decoder,frame('ready',ready())+frame('agent',event(1),cursor(1)));error=self.error(decoder.end_of_file,'CLIENT_EVENT_STREAM_INTERRUPTED');self.assertTrue(error.retryable);self.assertEqual(error.cursor,cursor(1));self.assertFalse(decoder.status().failed);decoder.begin_window(RequestId('req_second'));messages=drain(decoder,frame('ready',ready(1))+frame('agent',event(2),cursor(2)));self.assertEqual(messages[-1].event.sequence,2)
 def test_partial_eof_never_advances_unfinished_message_or_resets_raw_budget(self):
  decoder=opened();wire=frame('ready',ready())+frame('agent',event(1),cursor(1))+frame('agent',event(2),cursor(2))[:-8];drain(decoder,wire);self.assertGreater(decoder.status().frame_bytes,0);error=self.error(decoder.end_of_file,'CLIENT_EVENT_STREAM_INTERRUPTED');self.assertEqual(error.cursor,cursor(1));self.assertEqual(decoder.status().received_bytes,len(wire));decoder.begin_window(RequestId('req_second'));drain(decoder,frame('ready',ready(1))+frame('agent',event(2),cursor(2)));self.assertEqual(decoder.last_delivered_cursor,cursor(2));self.assertGreater(decoder.status().received_bytes,len(wire))
 def test_ready_must_precede_every_event_control_and_gap(self):
  for wire in [frame('agent',event(1),cursor(1)),frame('heartbeat',heartbeat()),frame('checkpoint',checkpoint()),frame('gap',gap())]:self.rejects(wire)
 def test_duplicate_ready_control_ids_and_private_fields_are_rejected(self):
  for wire in [frame('ready',ready(),cursor(0)),frame('ready',ready(private='secret')),frame('ready',ready())+frame('ready',ready()),frame('ready',ready())+frame('heartbeat',heartbeat(),cursor(0)),frame('ready',ready())+frame('checkpoint',checkpoint(),cursor(0))]:self.rejects(wire)
 def test_unknown_repeated_multiline_and_missing_sse_fields_are_rejected(self):
  for wire in [b'event:ready\nevent:ready\ndata:{}\n\n',b'event:ready\ndata:{}\ndata:{}\n\n',b'event:ready\nid:x\nid:x\ndata:{}\n\n',b'retry:10\n\n',b'event\ndata:{}\n\n',b'event:ready\n\n',b'data:{}\n\n',b'event: ready\ndata: {"schema":"agent-event-stream-v1"}\nprivate:x\n\n',b'event: ready\ndata: {"schema":"x","schema":"y"}\n\n']:
   self.rejects(wire)
 def test_non_utf8_and_non_json_numbers_cannot_become_messages(self):
  for wire in [b'event:ready\ndata:\xff\n\n',b':\xff\n\n',b'event:ready\ndata:NaN\n\n',b'event:ready\ndata:Infinity\n\n',b'event:ready\ndata:[]\n\n']:
   self.rejects(wire)
 def test_changed_identity_jumped_sequence_and_reused_event_ids_fail_closed(self):
  prefix=frame('ready',ready())
  for wire in [frame('agent',event(2),cursor(2)),frame('agent',event(1),cursor(2)),frame('agent',event(1,agentRunId='arun_'+uid(99)),cursor(1))]:self.rejects(prefix+wire)
  for patch in [dict(sessionId='ses_'+uid(99)),dict(version='changed'),dict(region='changed'),dict(eventId=event(1)['eventId'])]:
   decoder=opened();drain(decoder,prefix+frame('agent',event(1),cursor(1)));error=self.error(lambda:drain(decoder,frame('agent',event(2,**patch),cursor(2))));self.assertEqual(error.cursor,cursor(1))
  decoder=opened();drain(decoder,prefix+frame('checkpoint',checkpoint()));decoder.end_of_file();decoder.begin_window(RequestId('req_second'));self.error(lambda:drain(decoder,frame('ready',ready(historyOrigin='migration-snapshot'))))
 def test_heartbeat_and_checkpoint_never_advance_or_adopt_foreign_cursor(self):
  for name,data in [('heartbeat',heartbeat(1)),('heartbeat',heartbeat(agentRunId='arun_'+uid(99))),('heartbeat',heartbeat(observedAt='bad')),('heartbeat',heartbeat(extra=True)),('checkpoint',checkpoint(1)),('checkpoint',checkpoint(reason='business-success')),('checkpoint',checkpoint(extra=True))]:self.rejects(frame('ready',ready())+frame(name,data))
  decoder=opened();messages=drain(decoder,frame('ready',ready())+frame('heartbeat',heartbeat())+frame('checkpoint',checkpoint()));self.assertEqual([m.cursor for m in messages],[cursor(0)]*3)
 def test_valid_gap_is_explicit_frozen_sticky_and_never_auto_skipped(self):
  decoder=opened();drain(decoder,frame('ready',ready())+frame('agent',event(1),cursor(1)));error=self.error(lambda:drain(decoder,frame('gap',gap(1))),'AGENT_EVENT_GAP');self.assertEqual(error.cursor,cursor(1));self.assertEqual(error.status,200);self.assertTrue(error.details.missing_history);self.assertEqual(error.details.after,cursor(1))
  with self.assertRaises(FrozenInstanceError):error.details.after=cursor(70)
  decoder.discard_window();again=self.error(lambda:decoder.begin_window(RequestId('req_repair')),'AGENT_EVENT_GAP');self.assertEqual(again.cursor,cursor(1))
 def test_ready_and_gap_retention_windows_must_match_exact_original_run(self):
  for patch in [dict(after=cursor(1)),dict(cursor=cursor(1)),dict(oldestCursor=cursor(1)),dict(latestCursor=cursor(0)),dict(historyOrigin='all-history'),dict(agentRunId='arun_'+uid(99))]:self.rejects(frame('ready',ready(**patch)))
  self.rejects(frame('ready',ready(0,70)))
  for patch in [dict(missingHistory=False),dict(after=cursor(1)),dict(historyOrigin='migration-snapshot'),dict(extra='secret')]:self.rejects(frame('ready',ready())+frame('gap',gap()|patch))
 def test_frame_limit_accepts4096_bytes_and_rejects4097_before_growth(self):
  decoder=opened();self.assertEqual(drain(decoder,b':'+b'x'*4093+b'\n\n'),[]);self.assertEqual(decoder.status().frame_bytes,0);self.assertEqual(drain(decoder,frame('ready',ready()))[0].kind,'ready')
  decoder,error=self.rejects(b':'+b'x'*4094+b'\n\n','CLIENT_EVENT_STREAM_LIMIT');self.assertLessEqual(decoder.status().frame_bytes,4096);self.assertEqual(error.cursor,cursor(0))
 def test_raw_budget_includes_comments_control_framing_and_all_windows(self):
  decoder=opened(max_bytes=4096);wire=frame('ready',ready())+(b':'+b'x'*997+b'\n\n')*2+frame('checkpoint',checkpoint());drain(decoder,wire);decoder.end_of_file();decoder.begin_window(RequestId('req_second'));self.error(lambda:decoder.offer_chunk(wire),'CLIENT_EVENT_STREAM_LIMIT');self.assertEqual(decoder.status().received_bytes,2*len(wire));self.assertEqual(decoder.status().retained_chunk_bytes,0)
 def test_each_window_admits_at_most64_agent_events(self):
  decoder=opened(max_bytes=1048576);drain(decoder,frame('ready',ready(0,64)))
  for n in range(1,65):drain(decoder,frame('agent',event(n),cursor(n)))
  error=self.error(lambda:drain(decoder,frame('agent',event(65),cursor(65))),'CLIENT_EVENT_STREAM_LIMIT');self.assertEqual(error.cursor,cursor(64));self.assertEqual(decoder.status().decoded_events,64)
 def test_whole_decoder_has_at_most4_windows256_events_and256_seen_ids(self):
  decoder=_AgentSseDecoder(RUN,max_bytes=1048576)
  for window in range(4):
   decoder.begin_window(RequestId('req_'+str(window)));drain(decoder,frame('ready',ready(window*64,(window+1)*64)))
   for n in range(window*64+1,(window+1)*64+1):drain(decoder,frame('agent',event(n),cursor(n)))
   drain(decoder,frame('checkpoint',checkpoint((window+1)*64)));decoder.end_of_file()
  self.assertEqual(decoder.status().decoded_events,256);self.assertEqual(decoder.status().retained_event_ids,256);self.error(lambda:decoder.begin_window(RequestId('req_fifth')),'CLIENT_EVENT_STREAM_LIMIT');self.assertEqual(decoder.last_delivered_cursor,cursor(256))
 def test_fatal_metadata_persists_without_retaining_exception_tracebacks(self):
  decoder,error=self.rejects(b'event:ready\ndata:{}\n\n');self.assertNotIsInstance(decoder._failure,BaseException);decoder.discard_window();self.assertEqual(decoder.status().retained_chunk_bytes,0);self.assertEqual(decoder.status().frame_bytes,0);again=self.error(lambda:decoder.begin_window(RequestId('req_second')));self.assertEqual(again.code,error.code);self.assertEqual(again.cursor,error.cursor)
 def test_checkpoint_forbids_later_messages_but_allows_bounded_comments(self):
  decoder=opened();drain(decoder,frame('ready',ready())+frame('checkpoint',checkpoint())+b':complete\n\n');decoder.end_of_file()
  self.rejects(frame('ready',ready())+frame('checkpoint',checkpoint())+frame('heartbeat',heartbeat()))
 def test_actual_owned_http_sqlite_producer_window_decodes_without_native_or_sdk_io_claim(self):
  path=Path(__file__).resolve().parents[1]/'fixtures/agent-event-frames-python.mjs';result=subprocess.run([os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(path)],capture_output=True,check=True,timeout=3);source=json.loads(result.stdout);self.assertEqual(source['status'],200);wire=base64.b64decode(source['bodyBase64'],validate=True);decoder=_AgentSseDecoder(AgentRunId(source['agentRunId']));decoder.begin_window(RequestId(source['requestId']));messages=[]
  for offset in range(0,len(wire),17):messages.extend(drain(decoder,wire[offset:offset+17]))
  decoder.end_of_file();events=[m.event for m in messages if m.kind=='event'];self.assertEqual([e.sequence for e in events],[1,2,3,4,5,6]);self.assertTrue(all(e.session_id==source['sessionId']for e in events));self.assertTrue(any(isinstance(e,AgentInvocationEvent)for e in events));self.assertEqual(messages[-1].kind,'checkpoint');self.assertEqual(decoder.last_delivered_cursor,'aec1.'+source['agentRunId']+'.6')
