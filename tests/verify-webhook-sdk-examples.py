"""Execute exact README snippets against installed SDKs and an owned HTTP/TLS/SQLite fixture."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import subprocess
import time

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['consumer','node-doc','python-doc','python']:
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--node',required=True)
    args=parser.parse_args();consumer=args.consumer.resolve()
    examples=consumer/'examples';examples.mkdir(exist_ok=False)
    receipts={}
    for language,source,target in [('javascript',args.node_doc,examples/'subscribe.mjs'),('python',args.python_doc,examples/'subscribe.py')]:
        text=source.read_text();pattern=r'<!-- webhook-sdk-example:start -->\n```'+language+r'\n(.*?)\n```\n<!-- webhook-sdk-example:end -->'
        matches=re.findall(pattern,text,re.S);assert len(matches)==1
        target.write_text(matches[0]+'\n');receipts[language]={'docSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'snippetSha256':hashlib.sha256(target.read_bytes()).hexdigest()}
    child=subprocess.Popen([args.node,str(consumer/'tests/fixtures/agent-webhooks-python-http.mjs')],cwd=consumer,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def read() -> dict:
        assert select.select([child.stdout],[],[],5)[0], 'Owned example fixture response timed out'
        line=child.stdout.readline();assert line, 'Owned example fixture ended early'
        return json.loads(line)
    try:
        info=read();env={**os.environ,'REMOTE_PAINT_API':info['baseUrl'],'REMOTE_PAINT_API_KEY':info['keys']['all'],'REMOTE_PAINT_AGENT_RUN_ID':info['agentRunId'],'REMOTE_PAINT_WEBHOOK_AFTER':'aec1.'+info['agentRunId']+'.0','PYTHONDONTWRITEBYTECODE':'1'}
        for name in ['PYTHONPATH','PYTHONHOME','MYPYPATH']:env.pop(name,None)
        node=subprocess.run([args.node,str(examples/'subscribe.mjs')],cwd=consumer,env=env,capture_output=True,text=True,timeout=10);assert node.returncode==0,node.stderr
        python=subprocess.run([str(args.python),str(examples/'subscribe.py')],cwd=consumer,env=env,capture_output=True,text=True,timeout=10);assert python.returncode==0,python.stderr
        n,p=json.loads(node.stdout),json.loads(python.stdout)
        assert n['subscriptionId']==p['subscription_id'] and n['after']==p['after']==env['REMOTE_PAINT_WEBHOOK_AFTER']
        assert n['agentRunId']==p['agent_run_id']==info['agentRunId'] and n['endpointId']==p['endpoint_id']==info['endpointId']
        deadline=time.monotonic()+3
        while True:
            child.stdin.write('inbox\n');child.stdin.flush();inbox=read()
            if len(inbox['events'])==3:break
            assert time.monotonic()<deadline,'Original three-event delivery observation timed out';time.sleep(.01)
        assert inbox['subscriptions']==1 and inbox['effects']==0
        assert [r['envelope']['event']['sequence']for r in inbox['events']]==[1,2,3]
        assert len({r['envelope']['event']['eventId']for r in inbox['events']})==3
        print(json.dumps({'status':'passed','sameSubscription':True,'durableInboxEvents':3,'sourceEffects':0,'docs':receipts}))
    finally:
        if child.poll() is None:
            child.stdin.write('close\n');child.stdin.flush();child.stdin.close()
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        error=child.stderr.read();assert child.returncode==0,error

if __name__=='__main__':main()
