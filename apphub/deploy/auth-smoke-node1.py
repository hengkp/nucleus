#!/usr/bin/env python3
import http.cookies
import json
import os
import base64
import ssl
import sys
import urllib.parse
from html.parser import HTMLParser
from http.client import HTTPSConnection


class LoginFormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        if tag != "input":
            return
        data = dict(attrs)
        name = data.get("name")
        if name:
            self.values[name] = data.get("value", "")


class Client:
    def __init__(self, host, address):
        self.host = host
        self.address = address
        self.cookies = {}
        self.context = ssl._create_unverified_context()

    def request(self, method, path, body=None, content_type=None):
        conn = HTTPSConnection(self.address, 443, context=self.context, timeout=20)
        headers = {"Host": self.host, "User-Agent": "apphub-auth-smoke/1"}
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in self.cookies.items())
        if content_type:
            headers["Content-Type"] = content_type
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        cookie_names = []
        headers_list = response.getheaders()
        for name, value in headers_list:
            if name.lower() != "set-cookie":
                continue
            parsed = http.cookies.SimpleCookie(value)
            for key, morsel in parsed.items():
                self.cookies[key] = morsel.value
                cookie_names.append(key)
        return response.status, dict(headers_list), raw.decode("utf-8", errors="replace"), cookie_names


def main():
    encoded = os.environ.get("APPHUB_AUTH_SMOKE_B64")
    if encoded:
        credentials = json.loads(base64.b64decode(encoded).decode("utf-8"))
        username = credentials.get("username")
        password = credentials.get("password")
    else:
        username = os.environ.get("APPHUB_AUTH_SMOKE_USER")
        password = os.environ.get("APPHUB_AUTH_SMOKE_PASS")
    if not username or not password:
        raise RuntimeError("APPHUB_AUTH_SMOKE_USER and APPHUB_AUTH_SMOKE_PASS are required")

    host = os.environ.get("APPHUB_AUTH_SMOKE_HOST", "apphub.sisp.com")
    address = os.environ.get("APPHUB_AUTH_SMOKE_ADDR", "127.0.0.1")
    service = f"https://{host}/"
    client = Client(host, address)

    status, _, body, cookie_names = client.request("GET", f"/auth/login?service={urllib.parse.quote(service, safe=':/')}")
    print("login_get", status, "set_cookie", ",".join(cookie_names))
    if status != 200:
        raise RuntimeError(f"login page returned {status}")

    parser = LoginFormParser()
    parser.feed(body)
    csrf_token = parser.values.get("csrf_token")
    if not csrf_token:
        raise RuntimeError("login page did not include csrf_token")

    form = urllib.parse.urlencode({
        "username": username,
        "password": password,
        "service": service,
        "csrf_token": csrf_token,
    }).encode("utf-8")
    status, headers, body, cookie_names = client.request(
        "POST",
        "/auth/login",
        body=form,
        content_type="application/x-www-form-urlencoded",
    )
    print("login_post", status, "location", headers.get("Location", ""), "set_cookie", ",".join(cookie_names))
    if status not in {302, 303, 307} or "nginxauth" not in client.cookies:
        raise RuntimeError("login did not create the nginxauth session cookie")

    status, _, body, cookie_names = client.request("GET", "/")
    print("root_after_login", status, "content_hint", "SISP AppHub" in body, "set_cookie", ",".join(cookie_names))
    if status != 200 or "SISP AppHub" not in body:
        raise RuntimeError("authenticated root did not return the AppHub GUI")

    status, _, body, cookie_names = client.request("GET", "/api/session")
    print("session_after_login", status, body[:500], "set_cookie", ",".join(cookie_names))
    data = json.loads(body)
    if status != 200 or not data.get("authenticated") or data.get("user", {}).get("username") != username:
        raise RuntimeError("AppHub API did not receive the authenticated user")

    print("auth smoke ok")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"auth smoke failed: {exc}", file=sys.stderr)
        raise
