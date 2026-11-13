#!/usr/bin/env python3
"""CONNECT-proxy helper: relay stdio through the egress proxy.

Reads the proxy URL (with credentials) from https_proxy/HTTPS_PROXY env.
Usage:
  proxy-connect.py HOST PORT [--probe]
    --probe: just test the CONNECT and exit (prints the proxy response status).
    otherwise: CONNECT, then relay stdin/stdout <-> socket (for ssh ProxyCommand).
"""
import base64
import os
import socket
import sys
import threading
import urllib.parse


def get_proxy():
    url = (
        os.environ.get('https_proxy')
        or os.environ.get('HTTPS_PROXY')
        or os.environ.get('http_proxy')
        or os.environ.get('HTTP_PROXY')
    )
    if not url:
        raise SystemExit('no proxy env var set')
    p = urllib.parse.urlparse(url)
    return p.hostname, p.port or 3128, p.username, p.password


def connect_via_proxy(host, port):
    ph, pp, user, pw = get_proxy()
    s = socket.create_connection((ph, pp), timeout=15)
    auth = ''
    if user:
        creds = base64.b64encode(('%s:%s' % (user, pw or '')).encode()).decode()
        auth = 'Proxy-Authorization: Basic %s\r\n' % creds
    req = 'CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n%s\r\n' % (host, port, host, port, auth)
    s.sendall(req.encode())
    resp = b''
    while b'\r\n\r\n' not in resp:
        chunk = s.recv(4096)
        if not chunk:
            break
        resp += chunk
    return s, resp


def main():
    probe = '--probe' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--probe']
    if len(args) != 2:
        print('usage: proxy-connect.py HOST PORT [--probe]', file=sys.stderr)
        sys.exit(2)
    host, port = args[0], int(args[1])
    s, resp = connect_via_proxy(host, port)
    status = resp.split(b'\r\n', 1)[0].decode('utf-8', 'replace') if resp else '(no response)'
    if probe:
        print('CONNECT %s:%d -> %s' % (host, port, status))
        sys.exit(0 if ' 200 ' in status else 1)
    if ' 200 ' not in status:
        print('proxy CONNECT failed: %s' % status, file=sys.stderr)
        sys.exit(1)

    def pump_stdin_to_sock():
        try:
            while True:
                data = sys.stdin.buffer.read(65536)
                if not data:
                    break
                s.sendall(data)
        except OSError:
            pass
        finally:
            try:
                s.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def pump_sock_to_stdout():
        try:
            while True:
                data = s.recv(65536)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
        except OSError:
            pass
        finally:
            try:
                s.shutdown(socket.SHUT_RD)
            except OSError:
                pass

    t1 = threading.Thread(target=pump_stdin_to_sock, daemon=True)
    t2 = threading.Thread(target=pump_sock_to_stdout, daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()


if __name__ == '__main__':
    main()
