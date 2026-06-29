#!/usr/bin/env python3
import json
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8792"
USER = "nodeadmin"
ROUTE_MAP = Path("/etc/nginx/apphub/routes.map")


def request(path, method="GET", body=None, user=USER):
    data = None
    headers = {"X-Remote-User": user}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed: {exc.code} {detail}") from exc


def nginx_status(host, path="/"):
    context = ssl._create_unverified_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=8) as raw:
        with context.wrap_socket(raw, server_hostname=host) as sock:
            sock.sendall(
                (
                    f"GET {path} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    "User-Agent: apphub-smoke/1\r\n"
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
    return lines[0] if lines else ""


def main():
    health = json.loads(urllib.request.urlopen(BASE_URL + "/api/health", timeout=15).read().decode("utf-8"))
    print("health", health["service"], health["slurmMode"], health["store"])
    if health["slurmMode"] != "mock" or health["store"] != "postgres":
        raise RuntimeError(f"unexpected health state: {health}")

    templates = request("/api/templates")["templates"]
    print("templates", len(templates))
    if not any(item["id"] == "static-html" for item in templates):
        raise RuntimeError("static-html template is missing")

    for app in request("/api/apps?all=1")["apps"]:
        if app["name"].startswith("Deploy Smoke") and app["status"] not in {"stopped", "failed"}:
            request(f"/api/apps/{app['id']}/stop", method="POST")

    launched = request(
        "/api/apps",
        method="POST",
        body={
            "name": "Deploy Smoke Static",
            "templateId": "static-html",
            "cpus": 1,
            "memoryMb": 1024,
            "timeLimitMinutes": 120,
            "workspacePath": "smoke/static",
            "visibility": "private",
        },
    )["app"]
    print("launch", launched["id"], launched["status"], launched["routeHost"], launched["port"])
    if launched["status"] != "running":
        raise RuntimeError(f"mock launch did not reach running: {launched}")

    route_map = ROUTE_MAP.read_text(encoding="utf-8")
    if launched["routeHost"] not in route_map:
        raise RuntimeError("route map does not contain launched route")
    routes = request("/api/admin/routes")["routes"]
    print("routes", len(routes))
    if not any(route["host"] == launched["routeHost"] for route in routes):
        raise RuntimeError("admin route API does not include launched route")
    route_status = ""
    for _ in range(8):
        route_status = nginx_status(launched["routeHost"])
        if "302" in route_status:
            break
        time.sleep(1)
    print("route-nginx", route_status)
    if "302" not in route_status:
        raise RuntimeError(f"running app route did not redirect to LDAP login: {route_status}")

    persistent = request(f"/api/apps/{launched['id']}/persistence", method="POST")["app"]
    print("persistence", persistent["approvalStatus"])
    if persistent["approvalStatus"] != "pending":
        raise RuntimeError("persistence request was not marked pending")

    approved = request(
        f"/api/admin/apps/{launched['id']}/approval",
        method="PATCH",
        body={"status": "approved", "visibility": "public"},
    )["app"]
    print("approval", approved["approvalStatus"], approved["visibility"])
    if approved["approvalStatus"] != "approved":
        raise RuntimeError("admin approval failed")

    support = request(
        "/api/support",
        method="POST",
        body={
            "title": "Smoke support",
            "body": "Deployment smoke test",
            "status": "admin-needed",
            "appId": launched["id"],
        },
    )["thread"]
    print("support", support["status"])

    stopped = request(f"/api/apps/{launched['id']}/stop", method="POST")["app"]
    print("stop", stopped["status"])
    if stopped["status"] != "stopped":
        raise RuntimeError("stop did not mark app stopped")
    route_map_after = ROUTE_MAP.read_text(encoding="utf-8")
    if launched["routeHost"] in route_map_after:
        raise RuntimeError("route map still contains stopped route")

    print("smoke ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"smoke failed: {exc}", file=sys.stderr)
        raise
