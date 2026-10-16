#!/usr/bin/env python3
"""GN cc_wrapper: other targets/generators remain on the Linux toolchain."""
import hashlib, json, os, pathlib, subprocess, sys, time, urllib.request
compiler,*args=sys.argv[1:]
if '-c' not in args or not any(v in ['--target=aarch64-linux-gnu','--target=aarch64-unknown-linux-gnu'] for v in args):
    raise SystemExit(subprocess.call([compiler,*args]))
control=json.loads(pathlib.Path(os.environ.get('REMOTE_PAINT_HOST_CC_CONNECTION','/cc-control/connection.json')).read_text())
cwd=str(pathlib.Path.cwd().relative_to('/chromium/src'))
request=urllib.request.Request(control['url'],data=json.dumps({'compiler':pathlib.Path(compiler).name,'args':args,'cwd':cwd}).encode(),headers={'Authorization':'Bearer '+control['key'],'Content-Type':'application/json'},method='POST')
try:
    with urllib.request.urlopen(request,timeout=930) as response:result=json.load(response)
    # Host writes may precede bind-mount visibility in the Linux VM. Do not
    # let Ninja schedule archives or consume depfiles until exact bytes arrive.
    for artifact in result.get('artifacts',[]):
        path=pathlib.Path('/chromium/src')/artifact['path'];deadline=time.monotonic()+30
        while True:
            try:
                if hashlib.sha256(path.read_bytes()).hexdigest()==artifact['sha256']:break
            except FileNotFoundError:pass
            if time.monotonic()>=deadline:raise RuntimeError('Timed out waiting for shared compiler output: '+str(path))
            time.sleep(0.02)
    sys.stdout.write(result['output']);raise SystemExit(result['code'])
except Exception as error:
    print('Host cross compiler unavailable: '+str(error),file=sys.stderr);raise SystemExit(1)
