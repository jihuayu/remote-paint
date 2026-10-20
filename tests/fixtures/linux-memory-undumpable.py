# Explicit negative fixture: same UID but kernel ptrace access is denied when
# the caller lacks CAP_SYS_PTRACE. No synthetic memory numbers are returned.
import ctypes,json,os,sys
libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(4,0,0,0,0)!=0: # PR_SET_DUMPABLE
    raise OSError(ctypes.get_errno(),'prctl(PR_SET_DUMPABLE) failed')
print(json.dumps({'event':'ready','pid':os.getpid(),'uid':os.getuid(),'dumpable':libc.prctl(3,0,0,0,0)}),flush=True)
for line in sys.stdin:
    if line.strip()=='close': break
