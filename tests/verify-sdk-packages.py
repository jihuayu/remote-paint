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
    node_names={'package/package.json','package/backend.mjs','package/backend.d.mts','package/README.md'}
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
    wheel_names={'remote_paint_session/__init__.py','remote_paint_session/_client.py','remote_paint_session/py.typed',
                 *(prefix+n for n in ['METADATA','WHEEL','top_level.txt','RECORD'])}
    with zipfile.ZipFile(wheel) as archive:
        assert set(archive.namelist())==wheel_names and len(archive.namelist())==len(wheel_names)
        assert all((x.external_attr>>16)&0o170000!=0o120000 for x in archive.infolist())
        for name in ['__init__.py','_client.py','py.typed']:
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
        files=['service/session-registry.mjs','service/session-store.mjs','service/session-http.mjs',
               'tests/session-client.test.mjs','tests/session-http.test.mjs','tests/session-registry.test.mjs',
               'tests/session-registry-lifecycle.test.mjs','tests/session-registry-durable.test.mjs','tests/session-store.test.mjs',
               'tests/owned-test-child.mjs','tests/fixtures/session-store-child.mjs','tests/fixtures/session-store-records.mjs',
               'tests/fixtures/session-registry-child.mjs','tests/fixtures/session-python-http.mjs',
               'tests/python/test_session_client.py','tests/types/session-client.mts','tests/types/session_client.py']
        copied={}
        for name in files:
            source=args.project/name;target=consumer/name;target.parent.mkdir(parents=True,exist_ok=True)
            text=source.read_text();before=sha(source)
            if name=='tests/session-client.test.mjs':
                token="from '../sdk/backend.mjs'";assert text.count(token)==1;text=text.replace(token,"from '@remote-paint/session-client'")
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
        for name in ['backend.mjs','backend.d.mts','README.md','package.json']:assert sha(expected/name)==sha(args.project/'sdk'/name)
        (consumer/'tests/package-exports.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import * as main from '@remote-paint/session-client';
import * as backend from '@remote-paint/session-client/backend';
test('installed root/backend exports share implementation and declarations are adjacent',()=>{
 assert.equal(main.SessionClient,backend.SessionClient);assert.equal(main.SessionClientError,backend.SessionClientError);
 const path=fileURLToPath(import.meta.resolve('@remote-paint/session-client'));
 assert.ok(path.includes('/node_modules/@remote-paint/session-client/backend.mjs'));
 assert.match(readFileSync(path.replace(/backend\\.mjs$/,'backend.d.mts'),'utf8'),/export class SessionClient/);
});
test('unsupported internal and CommonJS exports are predictably refused',async()=>{
 await assert.rejects(import('@remote-paint/session-client/backend.mjs'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 assert.throws(()=>createRequire(import.meta.url)('@remote-paint/session-client'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
});
""")
        names=['session-client.test.mjs','session-http.test.mjs','session-registry.test.mjs','session-registry-lifecycle.test.mjs','session-registry-durable.test.mjs','session-store.test.mjs','package-exports.test.mjs']
        raw=run('node-unit',[args.node,'--test','--test-concurrency=4',*[str(consumer/'tests'/n)for n in names]],cwd=consumer,env=env)
        for label,value in [('tests',74),('pass',74),('fail',0),('skipped',0)]:assert re.search(r'[ℹ#] '+label+' '+str(value)+r'\b',raw)
        run('typescript',[args.node,str(args.tsc),'--noEmit','--strict','--exactOptionalPropertyTypes','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM',str(consumer/'tests/types/session-client.mts')],cwd=consumer,env=env)
        python=out/'venv/bin/python';venv.EnvBuilder(with_pip=False,symlinks=True).create(out/'venv')
        purelib=Path(subprocess.check_output([str(python),'-c',"import sysconfig;print(sysconfig.get_path('purelib'))"],env=env,text=True).strip())
        assert purelib.is_relative_to(out/'venv')
        installer=env.copy();installer['PYTHONPATH']=str(args.pip_tooling)
        run('python-install',[sys.executable,'-m','pip','install','--no-index','--no-compile','--find-links',str(args.wheelhouse),'--target',str(purelib),str(args.python_wheel)],env=installer)
        run('python-origin',[str(python),'-c',"import remote_paint_session,importlib.metadata,json,sys;from pathlib import Path;p=Path(remote_paint_session.__file__).resolve();assert p.is_relative_to(Path(sys.prefix).resolve());assert p.with_name('py.typed').is_file();print(json.dumps({'module':str(p),'prefix':sys.prefix,'version':importlib.metadata.version('remote-paint-session'),'httpx':importlib.metadata.version('httpx')}))"],cwd=consumer,env=env)
        assert sha(purelib/'remote_paint_session/_client.py')==sha(args.project/'sdk/python/remote_paint_session/_client.py')
        raw=run('python-unit',[str(python),'-m','unittest','discover','-s',str(consumer/'tests/python'),'-p','test_session_client.py','-v'],cwd=consumer,env=env)
        assert re.search(r'Ran 16 tests in [0-9.]+s\s+OK\s*$',raw)
        if args.mypy_tooling:
            typed=env.copy();typed['PYTHONPATH']=str(args.mypy_tooling)
            raw=run('python-types',[str(python),'-m','mypy','--strict','--python-version','3.11','--no-incremental','--cache-dir=/dev/null','--python-executable',str(python),str(consumer/'tests/types/session_client.py')],cwd=consumer,env=typed)
            assert 'Success: no issues found in 1 source file' in raw
        runtime=run('runtime',[sys.executable,'-c',"import sys,platform,json,subprocess;print(json.dumps({'python':platform.python_version(),'platform':sys.platform,'arch':platform.machine(),'node':subprocess.check_output([sys.argv[1],'--version'],text=True).strip(),'npm':subprocess.check_output([sys.argv[2],'--version'],text=True).strip()}))",args.node,args.npm],env=env)
        result={'status':'passed','nodeTests':74,'nodeSkips':0,'pythonTests':16,'typescriptActual0':True,'pythonInstalledTypeCheckActual0':bool(args.mypy_tooling),
                'archives':archives,'runtime':json.loads(runtime),'stages':stages,'sourceFallbackUnavailable':True,'publicPublishing':False}
        (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({k:result[k]for k in ['status','nodeTests','pythonTests','typescriptActual0','pythonInstalledTypeCheckActual0']}))
    except BaseException as error:
        (out/'failed.json').write_text(json.dumps({'status':'failed','error':str(error),'type':type(error).__name__,'stages':stages},indent=2)+'\n')
        raise

if __name__=='__main__':main()
