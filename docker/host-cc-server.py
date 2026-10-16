#!/usr/bin/env python3
"""Optional local Clang service for an x86 Linux builder on Apple Silicon.
Only compiles explicit AArch64 Linux -c invocations in the shared checkout.
"""
import argparse, hashlib, http.server, json, pathlib, secrets, subprocess, threading
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=pathlib.Path,required=True)
parser.add_argument('--compiler-dir',type=pathlib.Path,required=True)
parser.add_argument('--control',type=pathlib.Path,required=True)
parser.add_argument('--jobs',type=int,default=9)
args=parser.parse_args()
source=args.source.resolve(); compiler=args.compiler_dir.resolve();args.control.mkdir(parents=True,exist_ok=True)
key=secrets.token_hex(32);slots=threading.Semaphore(args.jobs)
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        if self.path!='/compile' or not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+key):
            self.send_error(403);return
        size=int(self.headers.get('Content-Length','0'))
        if not 0<size<1024*1024:self.send_error(413);return
        try:
            request=json.loads(self.rfile.read(size));argv=request['args']
            if request['compiler'] not in ['clang','clang++'] or not isinstance(argv,list) or not all(isinstance(v,str) for v in argv) or '-c' not in argv or not any(v in ['--target=aarch64-linux-gnu','--target=aarch64-unknown-linux-gnu'] for v in argv):
                self.send_error(400);return
            cwd=(source/request['cwd']).resolve()
            if not cwd.is_relative_to(source/'out'):self.send_error(400);return
            argv=[v.replace('/chromium/src',str(source)) for v in argv]
            with slots:
                process=subprocess.run([str(compiler/request['compiler']),*argv],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=900)
            output=process.stdout.decode('utf8',errors='replace').replace(str(source),'/chromium/src')
            artifacts=[]
            if process.returncode==0:
                for flag in ['-o','-MF']:
                    if flag in argv:
                        path=(cwd/argv[argv.index(flag)+1]).resolve()
                        if not path.is_relative_to(source/'out'):raise ValueError('Output outside build directory')
                        data=path.read_bytes()
                        artifacts.append({'path':str(path.relative_to(source)),'sha256':hashlib.sha256(data).hexdigest()})
            response=json.dumps({'code':process.returncode,'output':output,'artifacts':artifacts}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(response)));self.end_headers();self.wfile.write(response)
        except Exception as error:
            self.send_error(500,str(error))
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
(args.control/'connection.json').write_text(json.dumps({'url':f'http://host.docker.internal:{server.server_port}/compile','key':key}))
(args.control/'connection.json').chmod(0o600)
(args.control/'build.json').write_text(json.dumps({'mode':'mac-arm64-clang-cross','target':'aarch64-linux-gnu','compilerSha256':hashlib.sha256((compiler/'clang').read_bytes()).hexdigest(),'compilerVersion':subprocess.check_output([str(compiler/'clang'),'--version'],text=True).splitlines()[0],'jobs':args.jobs},indent=2))
print('Host cross compiler listening on loopback port '+str(server.server_port),flush=True)
server.serve_forever()
