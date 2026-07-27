import base64
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TEST_PORT = os.getenv("TEST_PORT", "8789")
DEV_PAGE_CMD = ["npm", "run", "dev-page", "--", "--port", TEST_PORT, "--ip", "127.0.0.1"]
BASE_URL = os.getenv("TEST_BASE_URL", f"http://127.0.0.1:{TEST_PORT}")

RUN_TS = str(int(time.time() * 1000))


def _load_dev_vars():
    env_path = REPO_ROOT / ".dev.vars"
    if not env_path.exists():
        return {}
    values = {}
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.split("#", 1)[0].strip()
    return values


DEV_VARS = _load_dev_vars()

_server_proc = None


def _start_server():
    global _server_proc
    _kill_server()
    _kill_port()
    time.sleep(1)
    _server_proc = subprocess.Popen(
        DEV_PAGE_CMD,
        cwd=REPO_ROOT,
        env={**os.environ, **DEV_VARS, "CI": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _wait_for_server()
    return _server_proc


def _kill_server():
    global _server_proc
    if _server_proc and _server_proc.poll() is None:
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _server_proc.kill()
            _server_proc.wait(timeout=5)
    if _server_proc and _server_proc.stdout:
        _server_proc.stdout.close()
    _server_proc = None
    _kill_port()


def _wait_for_server():
    deadline = time.time() + 60
    last_error = None
    while time.time() < deadline:
        if _server_proc and _server_proc.poll() is not None:
            output = _server_proc.stdout.read() if _server_proc.stdout else ""
            raise RuntimeError(f"Worker exited early: {output}")
        try:
            req = urllib.request.Request(
                f"{BASE_URL}/api/files?prefix=/",
                method="GET",
                headers={"x-api-key": DEV_VARS.get("APIKEYSECRET", "yourapi")},
            )
            with urllib.request.urlopen(req, timeout=3) as response:
                if response.status < 500:
                    return
        except Exception as exc:
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"Timed out waiting for worker: {last_error}")


def _restart_server():
    _start_server()


def _kill_port():
    try:
        import signal
        out = subprocess.check_output(["lsof", "-i", f":{TEST_PORT}", "-t"], text=True, timeout=5).strip()
        for pid in out.splitlines():
            try:
                os.kill(int(pid), signal.SIGKILL)
            except (ValueError, ProcessLookupError):
                pass
        time.sleep(1)
    except (subprocess.SubprocessError, FileNotFoundError):
        pass


def _do_request(path, method="GET", body=None, headers=None):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Connection", "close")
    if headers:
        for key, value in headers.items():
            req.add_header(key, value)
    with urllib.request.urlopen(req, timeout=15) as response:
        payload = response.read()
        return response, payload


def _api_request(path, method="GET", body=None, headers=None, expect_status=200):
    url = f"{BASE_URL}{path}"
    try:
        response, payload = _do_request(path, method=method, body=body, headers=headers)
        if expect_status and response.status != expect_status:
            raise AssertionError(
                f"Unexpected status {response.status} for {url} (expected {expect_status})"
            )
        return response, payload
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        if expect_status and exc.code != expect_status:
            raise AssertionError(
                f"Unexpected status {exc.code} for {url} (expected {expect_status})"
            )
        return exc, payload
    except (TimeoutError, ConnectionError, OSError):
        _restart_server()
        try:
            response, payload = _do_request(path, method=method, body=body, headers=headers)
            if expect_status and response.status != expect_status:
                raise AssertionError(
                    f"Unexpected status {response.status} for {url} (expected {expect_status})"
                )
            return response, payload
        except urllib.error.HTTPError as exc2:
            payload = exc2.read()
            if expect_status and exc2.code != expect_status:
                raise AssertionError(
                    f"Unexpected status {exc2.code} for {url} (expected {expect_status})"
                )
            return exc2, payload


def _dav_headers():
    auth = base64.b64encode(b"demo:demo").decode("ascii")
    return {"Authorization": f"Basic {auth}", "Connection": "close"}


def _api_headers():
    return {"x-api-key": DEV_VARS.get("APIKEYSECRET", "yourapi"), "Connection": "close"}


def _api_delete(keys):
    if not keys:
        return
    h = _api_headers()
    body = json.dumps({"keys": keys}).encode()
    try:
        _api_request("/api/files/delete", method="POST", body=body,
                     headers={**h, "Content-Type": "application/json"})
    except Exception:
        pass


def _server_alive():
    try:
        req = urllib.request.Request(
            f"{BASE_URL}/api/files?prefix=/",
            method="GET",
            headers={"x-api-key": DEV_VARS.get("APIKEYSECRET", "yourapi"), "Connection": "close"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status < 500
    except Exception:
        return False


def _safe_dav(path, method="GET", body=None, headers=None, expect_status=200):
    url = f"{BASE_URL}{path}"
    for attempt in range(3):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Connection", "close")
        for k, v in (_dav_headers() if headers is None else headers).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                payload = response.read()
                if expect_status and response.status != expect_status:
                    raise AssertionError(
                        f"Unexpected {response.status} for {url} (expected {expect_status})"
                    )
                return response, payload
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            if expect_status and exc.code != expect_status:
                raise AssertionError(
                    f"Unexpected {exc.code} for {url} (expected {expect_status})"
                )
            return exc, payload
        except (TimeoutError, ConnectionError, OSError):
            if attempt < 2:
                _restart_server()
                time.sleep(1)
                continue
            raise


class TestFileOperations(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _start_server()

    @classmethod
    def tearDownClass(cls):
        _kill_server()

    def setUp(self):
        if not _server_alive():
            _restart_server()

    def _request(self, path, method="GET", body=None, headers=None, expect_status=200):
        return _api_request(path, method=method, body=body, headers=headers, expect_status=expect_status)

    # =====================================================================
    # Auth
    # =====================================================================
    def test_auth_required(self):
        self._request("/api/files", expect_status=401)

    def test_wrong_key_rejected(self):
        self._request("/api/files", headers={"x-api-key": "wrongkey"}, expect_status=401)

    def test_auth_via_query_string(self):
        key = DEV_VARS.get("APIKEYSECRET", "yourapi")
        self._request(f"/api/files?key={key}&prefix=/", expect_status=200)

    def test_auth_via_header(self):
        self._request("/api/files?prefix=/", headers=_api_headers(), expect_status=200)

    # =====================================================================
    # Upload + List
    # =====================================================================
    def test_upload_and_list(self):
        h = _api_headers()
        fname = f"/ut-t1-{RUN_TS}.txt"
        self._request(f"/api/upload?filename={fname}", method="PUT",
                      body=b"hello", headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        resp, payload = self._request(f"/api/files?prefix=/ut-t1-{RUN_TS}", headers=h)
        data = json.loads(payload)
        keys = [f["key"] for f in data.get("files", [])]
        self.assertTrue(any(f"ut-t1-{RUN_TS}.txt" in k for k in keys), f"Not found in {keys}")
        _api_delete([fname])

    def test_upload_returns_size(self):
        h = _api_headers()
        content = b"x" * 512
        resp, payload = self._request(f"/api/upload?filename=/ut-size-{RUN_TS}.txt", method="PUT",
                                      body=content, headers={**h, "Content-Type": "text/plain"})
        data = json.loads(payload)
        self.assertEqual(data.get("size"), 512)
        _api_delete([f"/ut-size-{RUN_TS}.txt"])

    def test_upload_missing_filename(self):
        h = _api_headers()
        self._request("/api/upload", method="PUT", body=b"test",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=400)

    def test_not_found_route(self):
        self._request("/api/nonexistent", headers=_api_headers(), expect_status=404)

    def test_delete_multiple(self):
        h = _api_headers()
        names = [f"/ut-d1-{RUN_TS}.txt", f"/ut-d2-{RUN_TS}.txt"]
        for name in names:
            self._request(f"/api/upload?filename={name}", method="PUT", body=b"x",
                          headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"keys": names}).encode()
        resp, payload = self._request("/api/files/delete", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        data = json.loads(payload)
        self.assertEqual(data.get("deleted"), 2)

    def test_delete_empty_keys_returns_error(self):
        h = _api_headers()
        body = json.dumps({"keys": []}).encode()
        self._request("/api/files/delete", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=400)

    # =====================================================================
    # Rename
    # =====================================================================
    def test_rename(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-rn1-{RUN_TS}.txt", method="PUT", body=b"r",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"oldName": f"/ut-rn1-{RUN_TS}.txt", "newName": f"/ut-rn2-{RUN_TS}.txt"}).encode()
        resp, payload = self._request("/api/files/rename", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        self.assertEqual(json.loads(payload).get("status"), "renamed")
        _api_delete([f"/ut-rn2-{RUN_TS}.txt"])

    def test_rename_nonexistent(self):
        h = _api_headers()
        body = json.dumps({"oldName": "/no-such-rn.txt", "newName": "/other.txt"}).encode()
        self._request("/api/files/rename", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=404)

    def test_rename_missing_params(self):
        h = _api_headers()
        self._request("/api/files/rename", method="POST", body=json.dumps({}).encode(),
                      headers={**h, "Content-Type": "application/json"}, expect_status=400)

    def test_rename_conflict(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-rnc-a-{RUN_TS}.txt", method="PUT", body=b"a",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        self._request(f"/api/upload?filename=/ut-rnc-b-{RUN_TS}.txt", method="PUT", body=b"b",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"oldName": f"/ut-rnc-a-{RUN_TS}.txt", "newName": f"/ut-rnc-b-{RUN_TS}.txt"}).encode()
        self._request("/api/files/rename", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=409)
        _api_delete([f"/ut-rnc-a-{RUN_TS}.txt", f"/ut-rnc-b-{RUN_TS}.txt"])

    # =====================================================================
    # Move
    # =====================================================================
    def test_move(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-mv1-{RUN_TS}.txt", method="PUT", body=b"m",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-mv1-{RUN_TS}.txt", "destination": f"/ut-mv2-{RUN_TS}.txt"}).encode()
        resp, payload = self._request("/api/files/move", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        self.assertEqual(json.loads(payload).get("status"), "moved")
        _api_delete([f"/ut-mv2-{RUN_TS}.txt"])

    def test_move_nonexistent(self):
        h = _api_headers()
        body = json.dumps({"source": "/no-such-mv.txt", "destination": "/d.txt"}).encode()
        self._request("/api/files/move", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=404)

    def test_move_missing_params(self):
        h = _api_headers()
        self._request("/api/files/move", method="POST", body=json.dumps({}).encode(),
                      headers={**h, "Content-Type": "application/json"}, expect_status=400)

    def test_move_conflict(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-mvc-a-{RUN_TS}.txt", method="PUT", body=b"a",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        self._request(f"/api/upload?filename=/ut-mvc-b-{RUN_TS}.txt", method="PUT", body=b"b",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-mvc-a-{RUN_TS}.txt", "destination": f"/ut-mvc-b-{RUN_TS}.txt"}).encode()
        self._request("/api/files/move", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=409)
        _api_delete([f"/ut-mvc-a-{RUN_TS}.txt", f"/ut-mvc-b-{RUN_TS}.txt"])

    def test_move_old_gone(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-mvog-{RUN_TS}.txt", method="PUT", body=b"mvog",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-mvog-{RUN_TS}.txt", "destination": f"/ut-mvog2-{RUN_TS}.txt"}).encode()
        self._request("/api/files/move", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        resp, payload = self._request("/api/files?prefix=/", headers=h)
        keys = [f["key"] for f in json.loads(payload).get("files", [])]
        self.assertFalse(any(k.endswith(f"ut-mvog-{RUN_TS}.txt") for k in keys), "Source should be gone")
        self.assertTrue(any(k.endswith(f"ut-mvog2-{RUN_TS}.txt") for k in keys), "Dest should exist")
        _api_delete([f"/ut-mvog2-{RUN_TS}.txt"])

    # =====================================================================
    # Copy
    # =====================================================================
    def test_copy(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-cp1-{RUN_TS}.txt", method="PUT", body=b"c",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-cp1-{RUN_TS}.txt", "destination": f"/ut-cp2-{RUN_TS}.txt"}).encode()
        resp, payload = self._request("/api/files/copy", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        self.assertEqual(json.loads(payload).get("status"), "copied")
        _api_delete([f"/ut-cp1-{RUN_TS}.txt", f"/ut-cp2-{RUN_TS}.txt"])

    def test_copy_nonexistent(self):
        h = _api_headers()
        body = json.dumps({"source": "/no-such-cp.txt", "destination": "/d.txt"}).encode()
        self._request("/api/files/copy", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=404)

    def test_copy_missing_params(self):
        h = _api_headers()
        self._request("/api/files/copy", method="POST", body=json.dumps({}).encode(),
                      headers={**h, "Content-Type": "application/json"}, expect_status=400)

    def test_copy_and_verify(self):
        h = _api_headers()
        content = b"copy verify"
        self._request(f"/api/upload?filename=/ut-cpv-{RUN_TS}.txt", method="PUT", body=content,
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-cpv-{RUN_TS}.txt", "destination": f"/ut-cpv2-{RUN_TS}.txt"}).encode()
        self._request("/api/files/copy", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        resp, payload = self._request("/api/files?prefix=/", headers=h)
        keys = [f["key"] for f in json.loads(payload).get("files", [])]
        self.assertTrue(any(k.endswith(f"ut-cpv2-{RUN_TS}.txt") for k in keys))
        _api_delete([f"/ut-cpv-{RUN_TS}.txt", f"/ut-cpv2-{RUN_TS}.txt"])

    # =====================================================================
    # Mkdir
    # =====================================================================
    def test_mkdir(self):
        h = _api_headers()
        body = json.dumps({"path": f"/ut-mkdir-{RUN_TS}"}).encode()
        resp, payload = self._request("/api/files/mkdir", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        self.assertIn("created", json.loads(payload))
        _api_delete([f"/ut-mkdir-{RUN_TS}/.emptydir"])

    def test_mkdir_missing_path(self):
        h = _api_headers()
        self._request("/api/files/mkdir", method="POST", body=json.dumps({}).encode(),
                      headers={**h, "Content-Type": "application/json"}, expect_status=400)

    # =====================================================================
    # Shares
    # =====================================================================
    def test_shares_lifecycle(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-sh-{RUN_TS}.txt", method="PUT", body=b"shared",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"filename": f"/ut-sh-{RUN_TS}.txt", "hours": 1, "customCode": f"utcode{RUN_TS}"}).encode()
        resp, payload = self._request("/api/shares/create", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        share = json.loads(payload)
        self.assertIn("token", share)
        self.assertEqual(share["code"], f"utcode{RUN_TS}")
        token = share["token"]

        resp, payload = self._request("/api/shares", headers=h)
        self.assertIsInstance(json.loads(payload).get("shares"), list)

        code = share["code"]
        resp, payload = self._request(f"/s/{token}?code={code}")
        self.assertEqual(payload, b"shared")

        body = json.dumps({"token": token}).encode()
        self._request("/api/shares/revoke", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        _api_delete([f"/ut-sh-{RUN_TS}.txt"])

    def test_share_wrong_code(self):
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-sw-{RUN_TS}.txt", method="PUT", body=b"x",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"filename": f"/ut-sw-{RUN_TS}.txt", "hours": 1}).encode()
        resp, payload = self._request("/api/shares/create", method="POST", body=body,
                                      headers={**h, "Content-Type": "application/json"})
        share = json.loads(payload)
        self._request(f"/s/{share['token']}?code=badcode", expect_status=403)
        body = json.dumps({"token": share["token"]}).encode()
        self._request("/api/shares/revoke", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        _api_delete([f"/ut-sw-{RUN_TS}.txt"])

    def test_share_missing_token(self):
        self._request("/s/?code=anything", expect_status=400)

    def test_share_invalid_token(self):
        self._request("/s/faketoken?code=anything", expect_status=404)

    # =====================================================================
    # Storage alignment
    # =====================================================================
    def test_alignment_upload_list(self):
        h = _api_headers()
        content = b"alignment check"
        self._request(f"/api/upload?filename=/ut-align-{RUN_TS}.txt", method="PUT", body=content,
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        resp, payload = self._request("/api/files?prefix=/", headers=h)
        keys = [f["key"] for f in json.loads(payload).get("files", [])]
        self.assertTrue(any(k.endswith(f"ut-align-{RUN_TS}.txt") for k in keys), f"Not found: {keys}")
        _api_delete([f"/ut-align-{RUN_TS}.txt"])

    # =====================================================================
    # _meta preservation: rename/move/copy must transfer _meta,
    # delete must clean _meta
    # =====================================================================
    def test_rename_preserves_webdav_get(self):
        """After Download API rename, WebDAV GET must return correct content."""
        h = _api_headers()
        content = b"rn-meta-test"
        self._request(f"/api/upload?filename=/ut-rnm-{RUN_TS}.txt", method="PUT", body=content,
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"oldName": f"/ut-rnm-{RUN_TS}.txt", "newName": f"/ut-rnm2-{RUN_TS}.txt"}).encode()
        self._request("/api/files/rename", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        resp, payload = self._request(f"/ut-rnm2-{RUN_TS}.txt", method="GET",
                                      headers=_dav_headers(), expect_status=200)
        self.assertEqual(payload, content)
        _api_delete([f"/ut-rnm2-{RUN_TS}.txt"])

    def test_move_preserves_webdav_get(self):
        """After Download API move, WebDAV GET must return correct content."""
        h = _api_headers()
        content = b"mv-meta-test"
        self._request(f"/api/upload?filename=/ut-mvm-{RUN_TS}.txt", method="PUT", body=content,
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-mvm-{RUN_TS}.txt", "destination": f"/ut-mvm2-{RUN_TS}.txt"}).encode()
        self._request("/api/files/move", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        resp, payload = self._request(f"/ut-mvm2-{RUN_TS}.txt", method="GET",
                                      headers=_dav_headers(), expect_status=200)
        self.assertEqual(payload, content)
        _api_delete([f"/ut-mvm2-{RUN_TS}.txt"])

    def test_copy_preserves_webdav_get(self):
        """After Download API copy, WebDAV GET on copy must return correct content."""
        h = _api_headers()
        content = b"cp-meta-test"
        self._request(f"/api/upload?filename=/ut-cpm-{RUN_TS}.txt", method="PUT", body=content,
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        body = json.dumps({"source": f"/ut-cpm-{RUN_TS}.txt", "destination": f"/ut-cpm2-{RUN_TS}.txt"}).encode()
        self._request("/api/files/copy", method="POST", body=body,
                      headers={**h, "Content-Type": "application/json"}, expect_status=200)
        resp, payload = self._request(f"/ut-cpm2-{RUN_TS}.txt", method="GET",
                                      headers=_dav_headers(), expect_status=200)
        self.assertEqual(payload, content)
        resp2, payload2 = self._request(f"/ut-cpm-{RUN_TS}.txt", method="GET",
                                        headers=_dav_headers(), expect_status=200)
        self.assertEqual(payload2, content)
        _api_delete([f"/ut-cpm-{RUN_TS}.txt", f"/ut-cpm2-{RUN_TS}.txt"])

    def test_delete_cleans_meta(self):
        """After delete, orphaned _meta must not remain."""
        h = _api_headers()
        self._request(f"/api/upload?filename=/ut-dlm-{RUN_TS}.txt", method="PUT", body=b"dlm",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        _api_delete([f"/ut-dlm-{RUN_TS}.txt"])
        self._request(f"/api/upload?filename=/ut-dlm-{RUN_TS}.txt", method="PUT", body=b"new",
                      headers={**h, "Content-Type": "text/plain"}, expect_status=200)
        resp, payload = self._request(f"/ut-dlm-{RUN_TS}.txt", method="GET",
                                      headers=_dav_headers(), expect_status=200)
        self.assertEqual(payload, b"new")
        _api_delete([f"/ut-dlm-{RUN_TS}.txt"])


class TestWebDAV(unittest.TestCase):
    """Minimal WebDAV tests using a fresh server (well within 7-request safe zone)."""

    @classmethod
    def setUpClass(cls):
        _start_server()

    @classmethod
    def tearDownClass(cls):
        _kill_server()

    def setUp(self):
        time.sleep(0.5)
        if not _server_alive():
            _restart_server()

    def _dav(self, path, method="GET", body=None, headers=None, expect_status=200):
        return _safe_dav(path, method=method, body=body, headers=headers, expect_status=expect_status)

    def test_lifecycle(self):
        """MKCOL, PUT, PROPFIND, GET, DELETE."""
        h = _dav_headers()
        self._dav(f"/ut-dav-{RUN_TS}", method="MKCOL", headers=h, expect_status=201)
        self._dav(f"/ut-dav-{RUN_TS}/hello.txt", method="PUT", body=b"hello dav",
                  headers={**h, "Content-Type": "text/plain"}, expect_status=201)
        resp, payload = self._dav(f"/ut-dav-{RUN_TS}", method="PROPFIND",
                                  headers={**h, "Depth": "1"}, expect_status=207)
        self.assertIn(b"hello.txt", payload)
        resp, payload = self._dav(f"/ut-dav-{RUN_TS}/hello.txt", method="GET", headers=h, expect_status=200)
        self.assertEqual(payload, b"hello dav")
        self._dav(f"/ut-dav-{RUN_TS}/hello.txt", method="DELETE", headers=h, expect_status=204)
        self._dav(f"/ut-dav-{RUN_TS}", method="DELETE", headers=h, expect_status=204)

    def test_move_rename(self):
        """PUT, MOVE, GET, DELETE."""
        h = _dav_headers()
        self._dav(f"/ut-dmv-{RUN_TS}.txt", method="PUT", body=b"rename me",
                  headers={**h, "Content-Type": "text/plain"}, expect_status=201)
        self._dav(f"/ut-dmv-{RUN_TS}.txt", method="MOVE",
                  headers={**h, "Destination": f"{BASE_URL}/ut-dmv2-{RUN_TS}.txt"}, expect_status=204)
        resp, payload = self._dav(f"/ut-dmv2-{RUN_TS}.txt", method="GET", headers=h, expect_status=200)
        self.assertEqual(payload, b"rename me")
        self._dav(f"/ut-dmv2-{RUN_TS}.txt", method="DELETE", headers=h, expect_status=204)

    def test_move_folder(self):
        """MKCOL, PUT x2, MOVE folder, GET x2 (verify contents moved), DELETE cleanup."""
        h = _dav_headers()
        self._dav(f"/ut-dfolder-{RUN_TS}", method="MKCOL", headers=h, expect_status=201)
        self._dav(f"/ut-dfolder-{RUN_TS}/a.txt", method="PUT", body=b"aaa",
                  headers={**h, "Content-Type": "text/plain"}, expect_status=201)
        self._dav(f"/ut-dfolder-{RUN_TS}/b.txt", method="PUT", body=b"bbb",
                  headers={**h, "Content-Type": "text/plain"}, expect_status=201)
        self._dav(f"/ut-dfolder-{RUN_TS}", method="MOVE",
                  headers={**h, "Destination": f"{BASE_URL}/ut-dfolder-moved-{RUN_TS}"}, expect_status=204)
        resp, payload = self._dav(f"/ut-dfolder-moved-{RUN_TS}/a.txt", method="GET", headers=h, expect_status=200)
        self.assertEqual(payload, b"aaa")
        resp, payload = self._dav(f"/ut-dfolder-moved-{RUN_TS}/b.txt", method="GET", headers=h, expect_status=200)
        self.assertEqual(payload, b"bbb")
        self._dav(f"/ut-dfolder-moved-{RUN_TS}/a.txt", method="DELETE", headers=h, expect_status=204)
        self._dav(f"/ut-dfolder-moved-{RUN_TS}/b.txt", method="DELETE", headers=h, expect_status=204)
        self._dav(f"/ut-dfolder-moved-{RUN_TS}", method="DELETE", headers=h, expect_status=204)

    def test_unauthenticated(self):
        self._dav("/", method="PROPFIND", headers={"Depth": "0"}, expect_status=401)

    def test_delete_root_forbidden(self):
        h = _dav_headers()
        self._dav("/", method="DELETE", headers=h, expect_status=403)


if __name__ == "__main__":
    unittest.main()
