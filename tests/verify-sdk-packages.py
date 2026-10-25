"""Verify local private SDK archives through isolated installed consumers; no publishing."""
from __future__ import annotations
import argparse
import email
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import venv
import zipfile


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect_archives(project: Path, node: Path, wheel: Path) -> dict:
    node_names={'package/package.json','package/backend.mjs','package/backend.d.mts','package/backend-transport.mjs','package/agent.mjs','package/agent-observation.mjs','package/agent-download.mjs','package/agent-events.mjs','package/agent-webhooks.mjs','package/agent.d.mts','package/viewer-connection.mjs','package/viewer-connection.d.mts','package/viewer-frame.mjs','package/viewer-frame.d.mts','package/viewer-channel.mjs','package/viewer-channel.d.mts','package/viewer-control.mjs','package/viewer-control.d.mts','package/viewer-telemetry.mjs','package/viewer-telemetry.d.mts','package/viewer.mjs','package/viewer.d.mts','package/README.md'}
    with tarfile.open(node,'r:gz') as archive:
        members=archive.getmembers()
        assert {x.name for x in members}==node_names and len(members)==len(node_names)
        assert all(x.isfile() for x in members)
        for member in members:
            source=project/'sdk'/Path(member.name).relative_to('package')
            assert hashlib.sha256(archive.extractfile(member).read()).hexdigest()==sha(source)
        package=json.loads(archive.extractfile('package/package.json').read())
        assert package['name']=='@remote-paint/session-client' and package['private'] is True
        assert package['version']=='0.0.0-dev.0' and package.get('dependencies',{})=={}
    prefix='remote_paint_session-0.0.0.dev0.dist-info/'
    wheel_names={'remote_paint_session/__init__.py','remote_paint_session/_client.py','remote_paint_session/_transport.py','remote_paint_session/_agent.py','remote_paint_session/_observation.py','remote_paint_session/_download.py','remote_paint_session/_events.py','remote_paint_session/_webhooks.py','remote_paint_session/_event_stream_parser.py','remote_paint_session/_event_stream.py','remote_paint_session/py.typed',
                 *(prefix+n for n in ['METADATA','WHEEL','top_level.txt','RECORD'])}
    with zipfile.ZipFile(wheel) as archive:
        assert set(archive.namelist())==wheel_names and len(archive.namelist())==len(wheel_names)
        assert all((x.external_attr>>16)&0o170000!=0o120000 for x in archive.infolist())
        for name in ['__init__.py','_client.py','_transport.py','_agent.py','_observation.py','_download.py','_events.py','_webhooks.py','_event_stream_parser.py','_event_stream.py','py.typed']:
            assert hashlib.sha256(archive.read('remote_paint_session/'+name)).hexdigest()==sha(project/'sdk/python/remote_paint_session'/name)
        metadata=email.message_from_bytes(archive.read(prefix+'METADATA'))
        assert metadata['Name']=='remote-paint-session' and metadata['Version']=='0.0.0.dev0'
        assert metadata['Requires-Python']=='>=3.11' and metadata.get_all('Requires-Dist')==['httpx==0.28.1']
        tags=email.message_from_bytes(archive.read(prefix+'WHEEL'))
        assert tags['Root-Is-Purelib']=='true' and tags.get_all('Tag')==['py3-none-any']
    return {'node':{'sha256':sha(node),'members':sorted(node_names),'version':package['version']},
            'python':{'sha256':sha(wheel),'members':sorted(wheel_names),'version':metadata['Version']}}


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['project','node-archive','python-wheel','wheelhouse','pip-tooling','tsc','output']:
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--mypy-tooling',type=Path)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--npm',default=shutil.which('npm'))
    args=parser.parse_args()
    for name in ['project','node_archive','python_wheel','wheelhouse','pip_tooling','tsc','output','mypy_tooling']:
        value=getattr(args,name)
        if value is not None:setattr(args,name,value.resolve())
    out=args.output
    out.mkdir(parents=True,exist_ok=False)
    stages=[]
    def run(name,command,*,cwd=None,env=None,timeout=120):
        started=time.monotonic();status=None;timed_out=False
        with(out/(name+'.log')).open('x')as log:
            child=subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                status=child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out=True
                os.killpg(child.pid,signal.SIGTERM)
                try:status=child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid,signal.SIGKILL);status=child.wait()
        receipt={'stage':name,'actualExitCode':status,'timedOut':timed_out,'seconds':time.monotonic()-started,'command':list(map(str,command))}
        stages.append(receipt);(out/(name+'-exit.json')).write_text(json.dumps(receipt,indent=2)+'\n')
        if timed_out or status!=0:raise RuntimeError('Stage failed: '+name)
        return (out/(name+'.log')).read_text()
    try:
        archives=inspect_archives(args.project,args.node_archive,args.python_wheel)
        (out/'archives.json').write_text(json.dumps(archives,indent=2)+'\n')
        consumer=out/'consumer';consumer.mkdir()
        (consumer/'package.json').write_text(json.dumps({'name':'sdk-installed-consumer','version':'0.0.0','private':True,'type':'module'})+'\n')
        files=['tests/python/test_download_client.py','tests/fixtures/download-python-http.mjs','tests/node-agent-download-client.test.mjs','tests/fixtures/public-download-fixture.mjs','service/agent-download-access.mjs','service/agent-download-http.mjs','live/agent-download.mjs','tests/python/test_screenshot_client.py','tests/fixtures/screenshot-python-http.mjs','tests/node-agent-screenshot-client.test.mjs','tests/fixtures/public-screenshot-fixture.mjs','tests/fixtures/agent-screenshot-fixture.mjs','tests/fixtures/agent-observation-fixture.mjs','service/agent-screenshot-access.mjs','service/agent-screenshot-http.mjs','live/agent-screenshot.mjs','tests/python/test_accessibility_client.py','tests/fixtures/accessibility-python-http.mjs','tests/node-agent-accessibility-client.test.mjs','tests/fixtures/public-accessibility-fixture.mjs','live/agent-accessibility.mjs','tests/python/test_observation_client.py','tests/fixtures/observation-python-http.mjs','tests/node-agent-observation-client.test.mjs','tests/fixtures/public-observation-fixture.mjs','tests/fixtures/agent-http-client.mjs','service/agent-observation-access.mjs','live/agent-observation.mjs','live/agent-observation-realm.mjs','service/agent-http.mjs','service/agent-executor.mjs','service/agent-rpc.mjs','live/input.mjs','live/feedback.mjs','live/managed-agent-run.mjs','service/session-registry.mjs','service/session-store.mjs','service/session-http.mjs',
               'service/session-runtime-journal.mjs','service/session-agent-journal.mjs','service/runtime-witness-binding.mjs','service/viewer-access.mjs',
               'protocol/live-wire.mjs','protocol/wire.mjs','protocol/client-memory.mjs','protocol/resource-memory.mjs',
               'tests/types/agent-client.mts','tests/node-agent-client.test.mjs','tests/fixtures/node-agent-sdk-records.mjs','tests/fixtures/agent-executor-fixture.mjs',
               'tests/types/viewer-connection.mts','tests/types/viewer-frame.mts','tests/types/viewer.mts',
               'tests/session-client.test.mjs','tests/session-http.test.mjs','tests/session-registry.test.mjs',
               'tests/session-registry-lifecycle.test.mjs','tests/session-registry-durable.test.mjs','tests/session-store.test.mjs',
               'tests/owned-test-child.mjs','tests/fixtures/session-store-child.mjs','tests/fixtures/session-store-records.mjs',
               'tests/fixtures/session-registry-child.mjs','tests/fixtures/session-python-http.mjs',
               'tests/python/test_agent_client.py','tests/fixtures/agent-python-http.mjs','tests/types/agent_client.py','tests/python/test_session_client.py','tests/types/session-client.mts','tests/types/session_client.py']
        files.extend(['tests/node-agent-events-client.test.mjs','tests/types/agent-events-client.mts','tests/python/test_agent_events_client.py','tests/fixtures/agent-events-python-http.mjs','tests/types/agent_events_client.py','tests/python/test_agent_event_parser_client.py','tests/fixtures/agent-event-frames-python.mjs','tests/types/agent_event_parser.py','tests/python/test_agent_event_stream_client.py','tests/fixtures/agent-event-stream-python-http.mjs','tests/types/agent_event_stream.py'])
        files.append('tests/verify-webhook-sdk-examples.py')
        files.append('tests/python/_fixture_process.py')
        files.extend(['tests/node-agent-webhooks-client.test.mjs','tests/python/test_agent_webhooks_client.py','tests/fixtures/agent-webhooks-python-http.mjs','tests/fixtures/webhook-localhost-cert.pem','tests/fixtures/webhook-localhost-key.pem'])
        # The real control-service fixtures acquire dependencies as features
        # grow. Copy their explicit relative import closure with hashes while
        # deliberately withholding sdk/: consumers must use installed exports.
        pending=list(files);seen=set(files)
        while pending:
            name=pending.pop()
            if Path(name).suffix not in ['.mjs','.mts']:
                continue
            source=args.project/name
            for specifier in re.findall(r'''(?:from\s*|import\s*\(\s*|import\s*)['"](\.{1,2}/[^'"]+)['"]''',source.read_text()):
                target=(source.parent/specifier).resolve()
                assert target.is_relative_to(args.project),name
                relative=target.relative_to(args.project).as_posix()
                if relative.startswith('sdk/'):
                    continue
                assert target.is_file(),relative
                if relative not in seen:
                    seen.add(relative);files.append(relative);pending.append(relative)
        copied={}
        for name in files:
            source=args.project/name;target=consumer/name;target.parent.mkdir(parents=True,exist_ok=True)
            text=source.read_text();before=sha(source)
            if name=='tests/session-client.test.mjs':
                token="from '../sdk/backend.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client'")
            elif name=='tests/node-agent-webhooks-client.test.mjs':
                token="from '../sdk/agent.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client/agent'")
            elif name in ['tests/node-agent-events-client.test.mjs','tests/node-agent-download-client.test.mjs','tests/node-agent-client.test.mjs','tests/node-agent-observation-client.test.mjs','tests/node-agent-accessibility-client.test.mjs','tests/node-agent-screenshot-client.test.mjs']:
                for source,installed in [("from '../sdk/agent.mjs'","from '@remote-paint/session-client/agent'"),("from '../sdk/backend.mjs'","from '@remote-paint/session-client'")]:
                    assert text.count(source)==1;text=text.replace(source,installed)
            elif name in ['tests/types/agent-client.mts','tests/types/agent-events-client.mts']:
                for source,installed in [("'../../sdk/agent.mjs'","'@remote-paint/session-client/agent'"),("'../../sdk/backend.mjs'","'@remote-paint/session-client'")]:
                    assert text.count(source)>=1;text=text.replace(source,installed)
            elif name=='tests/types/viewer.mts':
                token="from '../../sdk/viewer.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client/viewer'")
            elif name=='tests/types/viewer-frame.mts':
                token="from '../../sdk/viewer-frame.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client/viewer-frame'")
            elif name=='tests/types/viewer-connection.mts':
                token="from '../../sdk/viewer-connection.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client/viewer-connection'")
            elif name=='tests/types/session-client.mts':
                token="from '../../sdk/backend.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client'")
            target.write_text(text);copied[name]={'sourceSha256':before,'consumerSha256':sha(target),'onlyImportAdapted':before!=sha(target)}
        assert not(consumer/'sdk').exists()
        (out/'contract-source-map.json').write_text(json.dumps(copied,indent=2)+'\n')
        env=os.environ.copy()
        for name in ['PYTHONPATH','MYPYPATH','PYTHONHOME']:env.pop(name,None)
        (out/'tmp').mkdir();(out/'empty-user.npmrc').write_text('');(out/'empty-global.npmrc').write_text('')
        env.update(PYTHONDONTWRITEBYTECODE='1',TMPDIR=str(out/'tmp'),PIP_DISABLE_PIP_VERSION_CHECK='1',
                   npm_config_cache=str(out/'npm-cache'),NPM_CONFIG_USERCONFIG=str(out/'empty-user.npmrc'),
                   NPM_CONFIG_GLOBALCONFIG=str(out/'empty-global.npmrc'))
        run('npm-install',[args.npm,'install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',str(args.node_archive)],cwd=consumer,env=env)
        expected=consumer/'node_modules/@remote-paint/session-client'
        for name in ['backend.mjs','backend.d.mts','backend-transport.mjs','agent.mjs','agent-observation.mjs','agent-download.mjs','agent-events.mjs','agent-webhooks.mjs','agent.d.mts','viewer-connection.mjs','viewer-connection.d.mts','viewer-frame.mjs','viewer-frame.d.mts','viewer-channel.mjs','viewer-channel.d.mts','viewer-control.mjs','viewer-control.d.mts','viewer-telemetry.mjs','viewer-telemetry.d.mts','viewer.mjs','viewer.d.mts','README.md','package.json']:assert sha(expected/name)==sha(args.project/'sdk'/name)
        # ws is a private control-service fixture dependency, not an SDK
        # dependency. Copy its frozen bytes explicitly, with no source symlink.
        fixture_dependencies={}
        for source in sorted([*(args.project/'node_modules/ws').rglob('*'),*(args.project/'node_modules/pngjs').rglob('*')]):
            if source.is_file():
                assert not source.is_symlink()
                relative=source.relative_to(args.project);target=consumer/relative
                target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
                assert sha(source)==sha(target);fixture_dependencies[str(relative)]=sha(source)
        # Importing the real Source fixture checks the installed driver's
        # pinned version. Only its package metadata is needed; this does not
        # add Playwright as an SDK runtime dependency or launch a browser.
        relative=Path('node_modules/playwright-core/package.json')
        source=args.project/relative;target=consumer/relative
        assert json.loads(source.read_text())['version']=='1.64.1'
        assert source.is_file() and not source.is_symlink()
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
        assert sha(source)==sha(target);fixture_dependencies[str(relative)]=sha(source)
        assert fixture_dependencies
        (out/'fixture-dependencies.json').write_text(json.dumps(fixture_dependencies,indent=2)+'\n')
        (consumer/'tests/package-exports.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import * as main from '@remote-paint/session-client';
import * as backend from '@remote-paint/session-client/backend';
import * as agent from '@remote-paint/session-client/agent';
import {ViewerTicketSource,ViewerConnection} from '@remote-paint/session-client/viewer-connection';
import {ViewerFrameConnection} from '@remote-paint/session-client/viewer-frame';
import {createViewer,ViewerViewportError} from '@remote-paint/session-client/viewer';
test('installed root/backend exports share implementation and declarations are adjacent',()=>{
 assert.equal(main.AgentClient,agent.AgentClient);assert.equal(main.AgentClientError,agent.AgentClientError);assert.equal(main.SessionClient,backend.SessionClient);assert.equal(main.SessionClientError,backend.SessionClientError);
 const path=fileURLToPath(import.meta.resolve('@remote-paint/session-client'));
 assert.ok(path.includes('/node_modules/@remote-paint/session-client/backend.mjs'));
 assert.match(readFileSync(path.replace(/backend\\.mjs$/,'backend.d.mts'),'utf8'),/export class SessionClient/);
});
test('installed browser connection export validates short grants without a management client',async()=>{
 assert.equal(typeof ViewerConnection,'function');assert.equal(main.ViewerConnection,undefined);
 const source=new ViewerTicketSource({gatewayOrigin:'https://gateway.example',audience:'https://viewer.example',sessionId:'ses_fixture',role:'readonly',getTicket:request=>{assert.equal(request.role,'readonly');assert.equal(request.previousRole,null);return ({grantId:'vgr_00000000-0000-0000-0000-000000000000',sessionId:'ses_fixture',role:'readonly',version:'v1',audience:'https://viewer.example',expiresAt:new Date(Date.now()+60000).toISOString(),ticket:'vwt1.'+'a'.repeat(43),streamPath:'/v1/viewer/stream?ticket=vwt1.'+'a'.repeat(43)});}});
 const grant=await source.getTicket();assert.equal(grant.role,'readonly');assert.equal(source.setRole('controller').role,'controller');assert.equal(source.settings.version,'v1');source.destroy();
 const frame=new ViewerFrameConnection({frameWindow:{postMessage(){throw new Error('deliberate unavailable frame');}},frameOrigin:'https://viewer.example',gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',role:'readonly',getTicket:()=>{throw new Error('must not request');}});await assert.rejects(frame.ready,e=>e.code==='CHANNEL_CLOSED');assert.equal(frame.performance.stage,'unavailable');assert.equal(frame.firstFrame,null);frame.close();
 assert.ok(fileURLToPath(import.meta.resolve('@remote-paint/session-client/viewer-connection')).includes('/node_modules/@remote-paint/session-client/viewer-connection.mjs'));
});
test('installed DOM component owns and destroys its pending iframe without backend code',async()=>{
 let tickets=0;const listeners=new Set(),owner={addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
 const document={defaultView:owner,createElement(){return {ownerDocument:document,style:{},isConnected:true,setAttribute(){},addEventListener(){},removeEventListener(){},attachShadow(){return {appendChild(){}};},remove(){}};}};
 const children=[],container={ownerDocument:document,appendChild(child){children.push(child);}};
 const config={viewerOrigin:'https://viewer.example',gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){tickets++;throw new Error('No ticket before connect');}};
 assert.throws(()=>createViewer(container,{...config,apiKey:'backend-secret'}),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(children.length,0);
 const viewer=createViewer(container,config),rejected=assert.rejects(viewer.ready,e=>e.code==='VIEWER_CLOSED');assert.equal(viewer.state.state,'loading');assert.equal(viewer.performance.stage,'unavailable');assert.equal(viewer.firstFrame,null);const snapshots=[];viewer.on('performance',v=>snapshots.push(v))();assert.equal(snapshots.length,1);assert.ok(Object.isFrozen(snapshots[0]));assert.equal((await viewer.setRole('readonly')).role,'readonly');assert.equal((await viewer.setReadonly(true)).role,'readonly');await assert.rejects(viewer.setRole('agent'),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(viewer.control.held,false);assert.equal(viewer.resize({width:320,height:200}).scope,'display');assert.equal(viewer.displaySize.mode,'fixed');assert.equal(viewer.resize().mode,'container');await assert.rejects(viewer.takeControl(),e=>e.code==='VIEWER_CONTROL_UNAVAILABLE');await assert.rejects(viewer.releaseControl(),e=>e.code==='VIEWER_CONTROL_UNAVAILABLE');assert.equal(children.length,1);await assert.rejects(viewer.resizeViewport({width:320,height:240}),e=>e instanceof ViewerViewportError&&e.code==='VIEWER_CONTROL_UNAVAILABLE'&&e.outcome==='not-applied');await viewer.destroy();await rejected;assert.equal(viewer.state.state,'destroyed');assert.equal(viewer.performance.stage,'unavailable');assert.equal(viewer.firstFrame,null);assert.equal(tickets,0);assert.equal(listeners.size,0);assert.equal(main.createViewer,undefined);await assert.rejects(viewer.resizeViewport({width:320,height:240}),e=>e instanceof ViewerViewportError&&e.code==='VIEWER_CLOSED'&&e.outcome==='not-applied');
 assert.ok(fileURLToPath(import.meta.resolve('@remote-paint/session-client/viewer')).includes('/node_modules/@remote-paint/session-client/viewer.mjs'));
});
test('unsupported internal and CommonJS exports are predictably refused',async()=>{
 await assert.rejects(import('@remote-paint/session-client/agent-observation.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 await assert.rejects(import('@remote-paint/session-client/agent-download.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 await assert.rejects(import('@remote-paint/session-client/agent-events.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 await assert.rejects(import('@remote-paint/session-client/backend-transport.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 await assert.rejects(import('@remote-paint/session-client/backend.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 assert.throws(()=>createRequire(import.meta.url)('@remote-paint/session-client'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
});
""")
        names=['node-agent-webhooks-client.test.mjs','node-agent-events-client.test.mjs','node-agent-download-client.test.mjs','node-agent-screenshot-client.test.mjs','node-agent-accessibility-client.test.mjs','node-agent-observation-client.test.mjs','node-agent-client.test.mjs','session-client.test.mjs','session-http.test.mjs','session-registry.test.mjs','session-registry-lifecycle.test.mjs','session-registry-durable.test.mjs','session-store.test.mjs','package-exports.test.mjs']
        raw=run('node-unit',[args.node,'--test','--test-concurrency=4',*[str(consumer/'tests'/n)for n in names]],cwd=consumer,env=env)
        for label,value in [('tests',214),('pass',214),('fail',0),('skipped',0)]:assert re.search(r'[ℹ#] '+label+' '+str(value)+r'\b',raw)
        run('typescript',[args.node,str(args.tsc),'--noEmit','--strict','--exactOptionalPropertyTypes','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM',str(consumer/'tests/types/agent-events-client.mts'),str(consumer/'tests/types/agent-client.mts'),str(consumer/'tests/types/session-client.mts'),str(consumer/'tests/types/viewer-connection.mts'),str(consumer/'tests/types/viewer-frame.mts'),str(consumer/'tests/types/viewer.mts')],cwd=consumer,env=env)
        python=out/'venv/bin/python';venv.EnvBuilder(with_pip=False,symlinks=True).create(out/'venv')
        purelib=Path(subprocess.check_output([str(python),'-c',"import sysconfig;print(sysconfig.get_path('purelib'))"],env=env,text=True).strip())
        assert purelib.is_relative_to(out/'venv')
        installer=env.copy();installer['PYTHONPATH']=str(args.pip_tooling)
        run('python-install',[sys.executable,'-m','pip','install','--no-index','--no-compile','--find-links',str(args.wheelhouse),'--target',str(purelib),str(args.python_wheel)],env=installer)
        run('python-origin',[str(python),'-c',"import remote_paint_session,importlib.metadata,json,sys;from pathlib import Path;p=Path(remote_paint_session.__file__).resolve();assert p.is_relative_to(Path(sys.prefix).resolve());assert p.with_name('py.typed').is_file();print(json.dumps({'module':str(p),'prefix':sys.prefix,'version':importlib.metadata.version('remote-paint-session'),'httpx':importlib.metadata.version('httpx')}))"],cwd=consumer,env=env)
        for name in ['__init__.py','_client.py','_transport.py','_agent.py','_observation.py','_download.py','_events.py','_webhooks.py','_event_stream_parser.py','_event_stream.py','py.typed']:assert sha(purelib/'remote_paint_session'/name)==sha(args.project/'sdk/python/remote_paint_session'/name)
        raw=run('python-unit',[str(python),'-m','unittest','discover','-s',str(consumer/'tests/python'),'-p','test_*client.py','-v'],cwd=consumer,env=env)
        assert re.search(r'Ran 210 tests in [0-9.]+s\s+OK\s*$',raw)
        if args.mypy_tooling:
            typed=env.copy();typed['PYTHONPATH']=str(args.mypy_tooling)
            raw=run('python-types',[str(python),'-m','mypy','--strict','--python-version','3.11','--no-incremental','--cache-dir=/dev/null','--python-executable',str(python),str(consumer/'tests/types/session_client.py'),str(consumer/'tests/types/agent_client.py'),str(consumer/'tests/types/agent_events_client.py'),str(consumer/'tests/types/agent_event_parser.py'),str(consumer/'tests/types/agent_event_stream.py')],cwd=consumer,env=typed)
            assert 'Success: no issues found in 5 source files' in raw
            source_types=run('python-source-types',[str(python),'-m','mypy','--strict','--python-version','3.11','--no-incremental','--cache-dir=/dev/null','--python-executable',str(python),'-p','remote_paint_session'],cwd=consumer,env=typed)
            assert 'Success: no issues found in 10 source files' in source_types
        examples=json.loads(run('webhook-readme-examples',[sys.executable,str(consumer/'tests/verify-webhook-sdk-examples.py'),'--consumer',str(consumer),'--node-doc',str(args.project/'sdk/README.md'),'--python-doc',str(args.project/'sdk/python/README.md'),'--node',args.node,'--python',str(python)],cwd=consumer,env=env))
        assert examples['status']=='passed' and examples['sameSubscription'] and examples['durableInboxEvents']==3
        runtime=run('runtime',[sys.executable,'-c',"import sys,platform,json,subprocess;print(json.dumps({'python':platform.python_version(),'platform':sys.platform,'arch':platform.machine(),'node':subprocess.check_output([sys.argv[1],'--version'],text=True).strip(),'npm':subprocess.check_output([sys.argv[2],'--version'],text=True).strip()}))",args.node,args.npm],env=env)
        result={'status':'passed','nodeTests':214,'nodeSkips':0,'pythonTests':210,'typescriptActual0':True,'pythonInstalledTypeCheckActual0':bool(args.mypy_tooling),
                'archives':archives,'webhookReadmeExamples':examples,'runtime':json.loads(runtime),'stages':stages,'sourceFallbackUnavailable':True,'publicPublishing':False}
        (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({k:result[k]for k in ['status','nodeTests','pythonTests','typescriptActual0','pythonInstalledTypeCheckActual0']}))
    except BaseException as error:
        (out/'failed.json').write_text(json.dumps({'status':'failed','error':str(error),'type':type(error).__name__,'stages':stages},indent=2)+'\n')
        raise

if __name__=='__main__':main()
