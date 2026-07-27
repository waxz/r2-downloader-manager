"""Quick probe: verify WebDAV MOVE and Download API rename/move/copy
actually move _meta keys and directory contents."""

import base64, json, os, subprocess, time, urllib.request, urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TEST_PORT = "8790"
BASE_URL = f"http://127.0.0.1:{TEST_PORT}"

def _load_dev_vars():
    values = {}
    for line in (REPO_ROOT / ".dev.vars").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        values[k.strip()] = v.split("#", 1)[0].strip()
    return values

DV = _load_dev_vars()

proc = subprocess.Popen(
    ["npm", "run", "dev-page", "--", "--port", TEST_PORT, "--ip", "127.0.0.1"],
    cwd=REPO_ROOT, env={**os.environ, **DV, "CI": "1"},
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)

def wait():
    deadline = time.time() + 60
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"Server died: {proc.stdout.read()}")
        try:
            r = urllib.request.urlopen(urllib.request.Request(
                f"{BASE_URL}/api/files?prefix=/", method="GET",
                headers={"x-api-key": DV.get("APIKEYSECRET", "yourapi"), "Connection": "close"},
            ), timeout=3)
            if r.status < 500: return
        except: pass
        time.sleep(1)
    raise RuntimeError("Server didn't start")

def kill():
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=10)
        except: proc.kill(); proc.wait(timeout=5)
    if proc.stdout: proc.stdout.close()

def req(path, method="GET", body=None, headers=None):
    r = urllib.request.Request(f"{BASE_URL}{path}", data=body, method=method)
    r.add_header("Connection", "close")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp, resp.read()
    except urllib.error.HTTPError as e:
        return e, e.read()

def dav_h():
    auth = base64.b64encode(b"demo:demo").decode()
    return {"Authorization": f"Basic {auth}", "Connection": "close"}

def api_h():
    return {"x-api-key": DV.get("APIKEYSECRET", "yourapi"), "Connection": "close"}

def api_delete(keys):
    body = json.dumps({"keys": keys}).encode()
    req("/api/files/delete", "POST", body, {**api_h(), "Content-Type": "application/json"})

def dav(method, path, **kw):
    headers = {**dav_h(), **kw.pop("headers", {})}
    body = kw.pop("body", None)
    return req(path, method=method, body=body, headers=headers)

def status(resp): return resp.status if hasattr(resp, 'status') else resp.code

def body(resp, data): return data

print("=== Starting probe server ===")
wait()
print("Server ready.\n")

failures = []

# ────────────────────────────────────────────────
# TEST 1: Download API rename - _meta must move
# ────────────────────────────────────────────────
print("TEST 1: Download API rename preserves _meta")
try:
    h = api_h()
    req("/api/upload?filename=/probe-rn.txt", "PUT", b"rn-content",
        {**h, "Content-Type": "text/plain"})
    # Rename
    body_json = json.dumps({"oldName": "/probe-rn.txt", "newName": "/probe-rn-renamed.txt"}).encode()
    resp, data = req("/api/files/rename", "POST", body_json, {**h, "Content-Type": "application/json"})
    assert status(resp) == 200, f"rename status: {status(resp)}"
    # GET the renamed file via WebDAV - should still work
    resp2, data2 = req("/probe-rn-renamed.txt", "GET", headers=dav_h())
    assert status(resp2) == 200, f"GET renamed: {status(resp2)}"
    assert data2 == b"rn-content", f"content mismatch: {data2}"
    # Verify _meta moved: GET old path should 404
    resp3, data3 = req("/probe-rn.txt", "GET", headers=dav_h())
    assert status(resp3) == 404, f"old path should be 404: {status(resp3)}"
    api_delete(["/probe-rn-renamed.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 1", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 2: Download API move - _meta must move
# ────────────────────────────────────────────────
print("TEST 2: Download API move preserves _meta")
try:
    h = api_h()
    req("/api/upload?filename=/probe-mv.txt", "PUT", b"mv-content",
        {**h, "Content-Type": "text/plain"})
    body_json = json.dumps({"source": "/probe-mv.txt", "destination": "/probe-mv-moved.txt"}).encode()
    resp, data = req("/api/files/move", "POST", body_json, {**h, "Content-Type": "application/json"})
    assert status(resp) == 200, f"move status: {status(resp)}"
    # GET the moved file via WebDAV
    resp2, data2 = req("/probe-mv-moved.txt", "GET", headers=dav_h())
    assert status(resp2) == 200, f"GET moved: {status(resp2)}"
    assert data2 == b"mv-content", f"content mismatch: {data2}"
    # Old path should 404
    resp3, data3 = req("/probe-mv.txt", "GET", headers=dav_h())
    assert status(resp3) == 404, f"old path should be 404: {status(resp3)}"
    api_delete(["/probe-mv-moved.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 2", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 3: Download API copy - _meta must copy
# ────────────────────────────────────────────────
print("TEST 3: Download API copy preserves _meta")
try:
    h = api_h()
    req("/api/upload?filename=/probe-cp.txt", "PUT", b"cp-content",
        {**h, "Content-Type": "text/plain"})
    body_json = json.dumps({"source": "/probe-cp.txt", "destination": "/probe-cp-copy.txt"}).encode()
    resp, data = req("/api/files/copy", "POST", body_json, {**h, "Content-Type": "application/json"})
    assert status(resp) == 200, f"copy status: {status(resp)}"
    # GET the copied file via WebDAV
    resp2, data2 = req("/probe-cp-copy.txt", "GET", headers=dav_h())
    assert status(resp2) == 200, f"GET copy: {status(resp2)}"
    assert data2 == b"cp-content", f"content mismatch: {data2}"
    # Original should still exist
    resp3, data3 = req("/probe-cp.txt", "GET", headers=dav_h())
    assert status(resp3) == 200, f"original should exist: {status(resp3)}"
    api_delete(["/probe-cp.txt", "/probe-cp-copy.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 3", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 4: Download API delete - must clean _meta
# ────────────────────────────────────────────────
print("TEST 4: Download API delete cleans _meta")
try:
    h = api_h()
    req("/api/upload?filename=/probe-del.txt", "PUT", b"del-content",
        {**h, "Content-Type": "text/plain"})
    body_json = json.dumps({"keys": ["/probe-del.txt"]}).encode()
    resp, data = req("/api/files/delete", "POST", body_json, {**h, "Content-Type": "application/json"})
    assert status(resp) == 200, f"delete status: {status(resp)}"
    # Try to upload again at same path - if _meta was cleaned, should succeed
    resp2, data2 = req("/api/upload?filename=/probe-del.txt", "PUT", b"new-content",
        {**h, "Content-Type": "text/plain"})
    # If _meta is orphaned, ensureDirectoryExists might complain
    assert status(resp2) == 200, f"re-upload after delete: {status(resp2)} {data2}"
    api_delete(["/probe-del.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 4", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 5: WebDAV MOVE file into subdirectory
# ────────────────────────────────────────────────
print("TEST 5: WebDAV MOVE file into subdirectory")
try:
    h = dav_h()
    dav("MKCOL", "/probe-subdir")
    dav("PUT", "/probe-sub.txt", body=b"sub content", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("MOVE", "/probe-sub.txt", headers={**h, "Destination": f"{BASE_URL}/probe-subdir/probe-sub.txt"})
    assert status(resp) == 204, f"MOVE status: {status(resp)}"
    resp2, data2 = dav("GET", "/probe-subdir/probe-sub.txt", headers=h)
    assert status(resp2) == 200, f"GET: {status(resp2)}"
    assert data2 == b"sub content", f"content: {data2}"
    # Original should be gone
    resp3, _ = dav("GET", "/probe-sub.txt", headers=h)
    assert status(resp3) == 404, f"old should be gone: {status(resp3)}"
    dav("DELETE", "/probe-subdir/probe-sub.txt", headers=h)
    dav("DELETE", "/probe-subdir", headers=h)
    print("  PASS")
except Exception as e:
    failures.append(("TEST 5", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 6: WebDAV MOVE folder with nested content
# ────────────────────────────────────────────────
print("TEST 6: WebDAV MOVE folder with nested content")
try:
    h = dav_h()
    dav("MKCOL", "/probe-nest")
    dav("MKCOL", "/probe-nest/sub")
    dav("PUT", "/probe-nest/a.txt", body=b"aaa", headers={**h, "Content-Type": "text/plain"})
    dav("PUT", "/probe-nest/sub/b.txt", body=b"bbb", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("MOVE", "/probe-nest", headers={**h, "Destination": f"{BASE_URL}/probe-nest-moved"})
    assert status(resp) == 204, f"MOVE status: {status(resp)}"
    # Verify contents moved
    resp2, data2 = dav("GET", "/probe-nest-moved/a.txt", headers=h)
    assert status(resp2) == 200, f"GET a.txt: {status(resp2)}"
    assert data2 == b"aaa", f"a.txt content: {data2}"
    resp3, data3 = dav("GET", "/probe-nest-moved/sub/b.txt", headers=h)
    assert status(resp3) == 200, f"GET sub/b.txt: {status(resp3)}"
    assert data3 == b"bbb", f"sub/b.txt content: {data3}"
    # Original should be gone
    resp4, _ = dav("GET", "/probe-nest/a.txt", headers=h)
    assert status(resp4) == 404, f"old a.txt: {status(resp4)}"
    resp5, _ = dav("GET", "/probe-nest/sub/b.txt", headers=h)
    assert status(resp5) == 404, f"old sub/b.txt: {status(resp5)}"
    dav("DELETE", "/probe-nest-moved/sub/b.txt", headers=h)
    dav("DELETE", "/probe-nest-moved/sub", headers=h)
    dav("DELETE", "/probe-nest-moved/a.txt", headers=h)
    dav("DELETE", "/probe-nest-moved", headers=h)
    print("  PASS")
except Exception as e:
    failures.append(("TEST 6", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 7: WebDAV MOVE folder empty (no files, just dir marker)
# ────────────────────────────────────────────────
print("TEST 7: WebDAV MOVE empty folder")
try:
    h = dav_h()
    dav("MKCOL", "/probe-empty")
    resp, _ = dav("MOVE", "/probe-empty", headers={**h, "Destination": f"{BASE_URL}/probe-empty-moved"})
    assert status(resp) == 204, f"MOVE status: {status(resp)}"
    resp2, _ = dav("PROPFIND", "/probe-empty-moved", headers={**h, "Depth": "0"})
    assert status(resp2) == 207, f"PROPFIND: {status(resp2)}"
    resp3, _ = dav("GET", "/probe-empty", headers=h)
    assert status(resp3) == 404, f"old: {status(resp3)}"
    dav("DELETE", "/probe-empty-moved", headers=h)
    print("  PASS")
except Exception as e:
    failures.append(("TEST 7", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 8: WebDAV MOVE with Overwrite: F (dest exists)
# ────────────────────────────────────────────────
print("TEST 8: WebDAV MOVE Overwrite=F when dest exists")
try:
    h = dav_h()
    dav("PUT", "/probe-ow-a.txt", body=b"aaa", headers={**h, "Content-Type": "text/plain"})
    dav("PUT", "/probe-ow-b.txt", body=b"bbb", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("MOVE", "/probe-ow-a.txt", headers={**h, "Destination": f"{BASE_URL}/probe-ow-b.txt", "Overwrite": "F"})
    assert status(resp) == 412, f"Expected 412, got: {status(resp)}"
    # Both files should still exist
    resp2, d2 = dav("GET", "/probe-ow-a.txt", headers=h)
    assert status(resp2) == 200 and d2 == b"aaa"
    resp3, d3 = dav("GET", "/probe-ow-b.txt", headers=h)
    assert status(resp3) == 200 and d3 == b"bbb"
    api_delete(["/probe-ow-a.txt", "/probe-ow-b.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 8", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 9: WebDAV MOVE nonexistent source
# ────────────────────────────────────────────────
print("TEST 9: WebDAV MOVE nonexistent source")
try:
    h = dav_h()
    resp, _ = dav("MOVE", "/probe-noexist.txt", headers={**h, "Destination": f"{BASE_URL}/probe-d.txt"})
    assert status(resp) == 404, f"Expected 404, got: {status(resp)}"
    print("  PASS")
except Exception as e:
    failures.append(("TEST 9", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 10: WebDAV MOVE without Destination header
# ────────────────────────────────────────────────
print("TEST 10: WebDAV MOVE without Destination")
try:
    h = dav_h()
    dav("PUT", "/probe-nodst.txt", body=b"x", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("MOVE", "/probe-nodst.txt", headers=h)
    assert status(resp) == 400, f"Expected 400, got: {status(resp)}"
    api_delete(["/probe-nodst.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 10", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 11: WebDAV COPY file
# ────────────────────────────────────────────────
print("TEST 11: WebDAV COPY file preserves content")
try:
    h = dav_h()
    dav("PUT", "/probe-cpfile.txt", body=b"copy me", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("COPY", "/probe-cpfile.txt", headers={**h, "Destination": f"{BASE_URL}/probe-cpfile-copy.txt"})
    assert status(resp) == 204, f"COPY status: {status(resp)}"
    resp2, d2 = dav("GET", "/probe-cpfile-copy.txt", headers=h)
    assert status(resp2) == 200 and d2 == b"copy me"
    # Original should still exist
    resp3, d3 = dav("GET", "/probe-cpfile.txt", headers=h)
    assert status(resp3) == 200 and d3 == b"copy me"
    api_delete(["/probe-cpfile.txt", "/probe-cpfile-copy.txt"])
    print("  PASS")
except Exception as e:
    failures.append(("TEST 11", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
# TEST 12: WebDAV COPY folder
# ────────────────────────────────────────────────
print("TEST 12: WebDAV COPY folder with contents")
try:
    h = dav_h()
    dav("MKCOL", "/probe-cpdir")
    dav("PUT", "/probe-cpdir/f.txt", body=b"folder content", headers={**h, "Content-Type": "text/plain"})
    resp, _ = dav("COPY", "/probe-cpdir", headers={**h, "Destination": f"{BASE_URL}/probe-cpdir-copy"})
    assert status(resp) == 204, f"COPY status: {status(resp)}"
    resp2, d2 = dav("GET", "/probe-cpdir-copy/f.txt", headers=h)
    assert status(resp2) == 200 and d2 == b"folder content"
    # Original should still exist
    resp3, d3 = dav("GET", "/probe-cpdir/f.txt", headers=h)
    assert status(resp3) == 200 and d3 == b"folder content"
    dav("DELETE", "/probe-cpdir-copy/f.txt", headers=h)
    dav("DELETE", "/probe-cpdir-copy", headers=h)
    dav("DELETE", "/probe-cpdir/f.txt", headers=h)
    dav("DELETE", "/probe-cpdir", headers=h)
    print("  PASS")
except Exception as e:
    failures.append(("TEST 12", str(e)))
    print(f"  FAIL: {e}")

# ────────────────────────────────────────────────
print("\n=== Summary ===")
if failures:
    for name, err in failures:
        print(f"  FAIL: {name} - {err}")
else:
    print("  All 12 tests PASSED")

kill()
