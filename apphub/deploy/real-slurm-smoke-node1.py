#!/usr/bin/env python3
import json
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request


BASE_URL = "http://127.0.0.1:8792"
USER = "ryanr"


def request(path, method="GET", body=None, user=USER):
    data = None
    headers = {"X-Remote-User": user}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed: {exc.code} {detail}") from exc


def nginx_status(host):
    context = ssl._create_unverified_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=8) as raw:
        with context.wrap_socket(raw, server_hostname=host) as sock:
            sock.sendall(
                (
                    "GET / HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    "User-Agent: apphub-real-smoke/1\r\n"
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
    return data.split(b"\r\n", 1)[0].decode("ascii", errors="replace")


def wait_for_nginx_route(host, seconds=45):
    deadline = time.time() + seconds
    last = ""
    while time.time() < deadline:
        last = nginx_status(host)
        if "302" in last:
            return last
        time.sleep(2)
    return last


def direct_http(host, port):
    with urllib.request.urlopen(f"http://{host}:{port}/", timeout=10) as response:
        return response.status


def main():
    health = json.loads(urllib.request.urlopen(BASE_URL + "/api/health", timeout=15).read().decode("utf-8"))
    print("health", health["slurmMode"], health["store"])
    if health["slurmMode"] != "slurm":
        raise RuntimeError("AppHub is not in slurm mode")

    for app in request("/api/apps")["apps"]:
        if app["name"].startswith("Real Slurm Smoke") and app["status"] not in {"stopped", "failed"}:
            request(f"/api/apps/{app['id']}/stop", method="POST")

    launched = request(
        "/api/apps",
        method="POST",
        body={
            "name": "Real Slurm Smoke Static",
            "templateId": "static-html",
            "cpus": 1,
            "memoryMb": 1024,
            "timeLimitMinutes": 30,
            "workspacePath": "smoke/real-static",
            "visibility": "private",
        },
    )["app"]
    print("launch", launched["id"], launched["status"], launched.get("slurmJobId", ""))

    app = launched
    deadline = time.time() + 180
    while time.time() < deadline:
        apps = request("/api/apps")["apps"]
        app = next(item for item in apps if item["id"] == launched["id"])
        print("poll", app["status"], app.get("node") or "", app.get("targetHost") or "", app.get("port") or "")
        if app["status"] == "running" and app.get("targetHost"):
            break
        if app["status"] == "failed":
            raise RuntimeError(f"app failed: {app.get('lastError')}")
        time.sleep(5)
    else:
        raise RuntimeError("real Slurm app did not reach running within 180 seconds")

    status = direct_http(app["targetHost"], app["port"])
    print("direct-http", status)
    if status != 200:
        raise RuntimeError(f"direct app HTTP returned {status}")

    route_status = wait_for_nginx_route(app["routeHost"])
    print("route-nginx", route_status)
    if "302" not in route_status:
        raise RuntimeError(f"route did not redirect to LDAP login: {route_status}")

    stopped = request(f"/api/apps/{app['id']}/stop", method="POST")["app"]
    print("stop", stopped["status"])
    print("real slurm smoke ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"real slurm smoke failed: {exc}", file=sys.stderr)
        raise
