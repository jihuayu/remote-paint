# Owned read-only observation fixture. The parent deliberately delays waitpid;
# no global permissions/security settings or unrelated processes are touched.
import os,sys,time,json
pid=os.fork()
if pid==0:os._exit(0)
try:
    end=time.monotonic()+5
    while True:
        with open('/proc/%d/stat'%pid) as f:state=f.read().rsplit(') ',1)[1].split()[0]
        if state=='Z':break
        if time.monotonic()>=end:raise RuntimeError('Fixture zombie deadline')
        time.sleep(0.005)
    print(json.dumps({'pid':os.getpid(),'zombiePid':pid}),flush=True)
    for line in sys.stdin:
        if line.strip()=='reap':
            os.waitpid(pid,0);pid=None
            print(json.dumps({'event':'reaped'}),flush=True)
        elif line.strip()=='close':break
finally:
    if pid is not None:
        try:os.waitpid(pid,0)
        except ChildProcessError:pass
