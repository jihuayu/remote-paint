"""Build private SDK archives and verify offline consumers on a declared source tree."""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',type=Path,default=Path(__file__).resolve().parents[1])
    for name in ['work-dir','tooling','wheelhouse','typescript']:
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--source-manifest',type=Path)
    args=parser.parse_args()
    project=args.project.resolve();out=args.work_dir.resolve();tooling=args.tooling.resolve()
    assert not out.is_relative_to(project), 'Results must be outside the source tree'
    out.mkdir(parents=True,exist_ok=False)
    env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':str(tooling),
         'SOURCE_DATE_EPOCH':'1792278000','PIP_DISABLE_PIP_VERSION_CHECK':'1'}
    stages=[]
    def save(name: str,value: object) -> None:
        with(out/name).open('x')as f:json.dump(value,f,indent=2);f.write('\n')
    def linux_process_receipt(name: str) -> None:
        if sys.platform!='linux':
            return
        rows=[]
        for path in Path('/proc').glob('[0-9]*/stat'):
            if len(rows)>=64:
                break
            try:
                raw=path.read_text();fields=raw[raw.rfind(')')+2:].split()
                if fields[0]=='Z' or fields[1]=='1':
                    rows.append({'pid':int(path.parent.name),'state':fields[0],'ppid':int(fields[1]),'startTicks':int(fields[19])})
            except (OSError,ValueError,IndexError):
                continue
        save(name,{'pidOneName':Path('/proc/1/comm').read_text().strip(),'observedOrphanOrZombieRows':rows,
                   'scope':'Bounded temporal container process inventory; absence is not a retirement receipt.'})
    def run(name: str,command: list[str],timeout: int=120) -> str:
        start=time.monotonic();timed_out=False
        with(out/(name+'.log')).open('x')as log:
            child=subprocess.Popen(command,cwd=project,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:code=child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out=True;os.killpg(child.pid,signal.SIGTERM)
                try:code=child.wait(timeout=2)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait()
        receipt={'stage':name,'command':command,'actualExitCode':code,'timedOut':timed_out,
                 'seconds':time.monotonic()-start,'logSha256':sha(out/(name+'.log'))}
        stages.append(receipt);save(name+'-exit.json',receipt)
        if code!=0 or timed_out:
            linux_process_receipt(name+'-processes.json')
            logs=[out/(name+'.log')]
            installed_failure=out/'installed/failed.json'
            if installed_failure.is_file():
                failed_stages=json.loads(installed_failure.read_text()).get('stages',[])
                if failed_stages:
                    logs.append(out/'installed'/(failed_stages[-1]['stage']+'.log'))
            for path in logs:
                if not path.is_file():
                    continue
                lines=path.read_text(errors='replace').splitlines()
                positions=[i for i,line in enumerate(lines)if line.startswith(('not ok ','FAIL: ','ERROR: '))]
                detail='\n'.join('\n'.join(lines[i:i+48])for i in positions[:8])
                print('FAILED STAGE LOG '+str(path)+'\n'+detail[:12000]+'\n'+'\n'.join(lines[-24:]),flush=True)
            raise RuntimeError('Stage failed: '+name)
        return(out/(name+'.log')).read_text()
    try:
        linux_process_receipt('initial-processes.json')
        commit=os.environ.get('GITHUB_SHA')
        if commit:
            # Checkout's temporary HOME does not carry into later container
            # steps. Trust only this explicitly resolved checkout per command.
            git=['git','-c','safe.directory='+str(project)]
            actual=subprocess.check_output([*git,'rev-parse','HEAD'],cwd=project,text=True).strip()
            assert actual==commit
            subprocess.run([*git,'diff','--exit-code','HEAD','--'],cwd=project,check=True,stdout=subprocess.DEVNULL)
            names=[n.decode()for n in subprocess.check_output([*git,'ls-files','-z'],cwd=project).split(b'\0')if n]
            files={name:sha(project/name)for name in names}
        else:
            assert args.source_manifest is not None, 'Local verification requires an explicit frozen source manifest'
            files=json.loads(args.source_manifest.read_text())['sourceFiles']
            assert all(sha(project/name)==digest for name,digest in files.items())
        save('source-manifest.json',{'commit':commit,'sourceFiles':files})
        assert sys.platform in ['darwin','linux']
        test_files=sorted(p.relative_to(project).as_posix()for p in(project/'tests').glob('*.test.mjs'))
        assert len(test_files)==146
        raw=run('full-js',['node','--test','--test-reporter=tap','--test-concurrency=4',*test_files])
        counts={key:int(re.search(r'^# '+key+r' (\d+)$',raw,re.M)[1])for key in ['tests','pass','fail','cancelled','skipped','todo']}
        passed,skipped=(1569,15)if sys.platform=='darwin'else(1578,6)
        assert counts==dict(tests=1584,**{'pass':passed},fail=0,cancelled=0,skipped=skipped,todo=0)
        archives=out/'archives';archives.mkdir()
        packed=json.loads(run('node-pack',['npm','pack','./sdk','--ignore-scripts','--json','--pack-destination',str(archives)]))
        assert len(packed)==1
        node=archives/packed[0]['filename'];assert node.is_file()
        source=out/'wheel-source';source.mkdir()
        for name in ['pyproject.toml','README.md','remote_paint_session/__init__.py','remote_paint_session/_client.py','remote_paint_session/_transport.py','remote_paint_session/_agent.py','remote_paint_session/_observation.py','remote_paint_session/_download.py','remote_paint_session/_events.py','remote_paint_session/_event_stream_parser.py','remote_paint_session/_event_stream.py','remote_paint_session/py.typed']:
            target=source/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(project/'sdk/python'/name,target)
        run('python-wheel',[sys.executable,'-m','build','--wheel','--no-isolation','--outdir',str(archives),str(source)])
        wheels=list(archives.glob('*.whl'));assert len(wheels)==1
        run('installed-packages',[sys.executable,str(project/'tests/verify-sdk-packages.py'),
            '--project',str(project),'--node-archive',str(node),'--python-wheel',str(wheels[0]),
            '--wheelhouse',str(args.wheelhouse.resolve()),'--pip-tooling',str(tooling),
            '--mypy-tooling',str(tooling),'--tsc',str(args.typescript.resolve()),'--output',str(out/'installed')])
        installed=json.loads((out/'installed/result.json').read_text())
        assert installed['status']=='passed'and installed['nodeTests']==202 and installed['pythonTests']==194
        assert installed['sourceFallbackUnavailable']and installed['typescriptActual0']and installed['pythonInstalledTypeCheckActual0']
        assert all(sha(project/name)==digest for name,digest in files.items())
        runtime=json.loads(run('runtime',[sys.executable,'-c',"import platform,json,subprocess;print(json.dumps({'python':platform.python_version(),'platform':platform.system(),'arch':platform.machine(),'node':subprocess.check_output(['node','--version'],text=True).strip()}))"]))
        save('result.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed',
            'commit':commit,'fullJs':counts,'installedNodeTests':202,'installedPythonTests':194,
            'archives':{p.name:sha(p)for p in archives.iterdir()},'sourceManifestSha256':sha(out/'source-manifest.json'),
            'runtime':runtime,'stages':stages,'typescriptActual0':True,'installedMypyActual0':True,
            'originalNativeEventCancelQualified':False,'wholeGoalQualified':False,'publicPublishing':False})
        print(json.dumps({'status':'passed','commit':commit,'fullJs':counts,'nodeTests':202,'pythonTests':194}))
    except BaseException as error:
        save('failed.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status':'failed','error':str(error),'type':type(error).__name__,'stages':stages})
        raise


if __name__=='__main__':main()
