#!/usr/bin/env python3
import socket
import ssl
from pathlib import Path


def request(host, path):
    context = ssl._create_unverified_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=8) as raw:
        with context.wrap_socket(raw, server_hostname=host) as sock:
            sock.sendall(
                (
                    f"GET {path} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    "User-Agent: apphub-nginx-check/1\r\n"
                    "Connection: close\r\n"
                    "\r\n"
                ).encode("ascii")
            )
            data = b""
            while b"\r\n\r\n" not in data and len(data) < 65536:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
    header = data.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1", errors="replace")
    lines = header.splitlines()
    status = lines[0] if lines else ""
    interesting = [line for line in lines[1:] if line.lower().startswith(("location:", "content-type:"))]
    return status, interesting


for label, path in [
    ("root", "/"),
    ("api", "/api/health"),
    ("login", "/auth/login?service=https://apphub.sisp.com/"),
]:
    status, headers = request("apphub.sisp.com", path)
    print(label, status)
    for header in headers:
        print(" ", header)

route_map = Path("/etc/nginx/apphub/routes.map")
if route_map.exists():
    for line in route_map.read_text(encoding="utf-8").splitlines():
        parts = line.strip().rstrip(";").split()
        if len(parts) == 2 and parts[0] not in {"default", "map", "}"}:
            status, headers = request(parts[0], "/")
            print("route", parts[0], status)
            for header in headers:
                print(" ", header)
            break
