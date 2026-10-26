"""Test-only POSIX socket buffer control; no Source or application behavior."""
import base64
import fcntl
import json
import os
import socket
import sys

def emit(value):
    print(json.dumps(value),flush=True)

if sys.argv[1]=='sender':
    # fd 3 is a duplicate of one accepted test socket. Retire this duplicate
    # before the parent starts the HTTP request; never close the parent's fd.
    with socket.socket(fileno=3) as peer:
        try:
            peer.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,65536)
        finally:
            # Child stdio/socket setup can clear shared descriptor flags.
            # libuv's original stream must remain nonblocking when resumed.
            fcntl.fcntl(3,fcntl.F_SETFL,fcntl.fcntl(3,fcntl.F_GETFL)|os.O_NONBLOCK)
        emit({'sendBuffer':peer.getsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF)})
elif sys.argv[1]=='receiver':
    with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as peer:
        peer.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,16384)
        peer.settimeout(3)
        peer.connect(('127.0.0.1',int(sys.argv[2])))
        # Darwin can resize during connect. Reapply on the established socket
        # and measure the actual value rather than assuming the requested one.
        peer.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,16384)
        emit({'stage':'connected','receiveBuffer':peer.getsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF)})
        line=sys.stdin.buffer.readline(16385)
        assert len(line)<=16384
        if line in (b'close\n',b''):
            sys.exit(0)
        # The parent has now configured and retired its duplicate of the
        # accepted socket; both ends of the handshake are established.
        peer.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,16384)
        request=base64.b64decode(json.loads(line)['request'],validate=True)
        assert len(request)<=8192
        peer.sendall(request)
        headers=bytearray()
        while b'\r\n\r\n' not in headers:
            part=peer.recv(min(256,16384-len(headers)))
            assert part and len(headers)<16384
            headers.extend(part)
        peer.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,16384)
        emit({'stage':'headers','statusCode':int(headers.split(b' ',2)[1]),'headerReadBytes':len(headers),'receiveBuffer':peer.getsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF)})
        # Keep the application reader stopped. Its kernel buffer was bounded
        # before connect, so this is physical TCP pressure rather than a mock.
        command=sys.stdin.buffer.readline(129)
        assert command in (b'close\n',b'')
else:
    raise AssertionError('Unknown owned TCP fixture mode')
