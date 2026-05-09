import socket, time

# Teste direto com socket raw — bypassa requests para debugar
HOST, PORT = 'localhost', 3002

s = socket.create_connection((HOST, PORT), timeout=5)
s.sendall(b'GET /video_feed HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
s.settimeout(6)

buf = b''
start = time.time()
try:
    while time.time() - start < 6:
        data = s.recv(4096)
        if not data:
            break
        buf += data
        print(f'  +{len(data)} bytes  total={len(buf)}  elapsed={time.time()-start:.2f}s')
        if len(buf) > 5000:
            break
except socket.timeout:
    print(f'  timeout apos {time.time()-start:.2f}s  total={len(buf)} bytes')
finally:
    s.close()

print()
print('Primeiros 200 bytes:')
print(repr(buf[:200]))
