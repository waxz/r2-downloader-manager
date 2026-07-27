#!/usr/bin/env python3
import argparse
import base64
import os
import sys
import time
import uuid
from urllib import error, request


def build_auth_header(username, password):
    if not username and not password:
        return {}
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


class WebDAVTester:
    def __init__(self, base_url, username=None, password=None):
        self.base_url = base_url.rstrip("/")
        self.username = username or os.getenv("WEBDAV_USERNAME") or ""
        self.password = password or os.getenv("WEBDAV_PASSWORD") or ""
        self.prefix = f"/pywebdav-test-{uuid.uuid4().hex[:8]}"
        self.created_paths = []

    def _url(self, path):
        if not path.startswith("/"):
            path = "/" + path
        return self.base_url + path

    def _request(self, path, method="GET", body=b"", headers=None, expected_status=None):
        url = self._url(path)
        req = request.Request(url, data=body, method=method)
        req_headers = build_auth_header(self.username, self.password)
        if headers:
            req_headers.update(headers)
        for key, value in req_headers.items():
            req.add_header(key, value)
        try:
            with request.urlopen(req, timeout=15) as response:
                payload = response.read()
                status = response.status
                return status, payload, dict(response.headers)
        except error.HTTPError as exc:
            payload = exc.read()
            return exc.code, payload, dict(exc.headers)

    def _assert(self, condition, message):
        if not condition:
            raise AssertionError(message)

    def create_folder(self, folder_path):
        status, _, _ = self._request(folder_path, method="MKCOL")
        self._assert(status in {200, 201, 204}, f"MKCOL failed for {folder_path}: {status}")
        self.created_paths.append(folder_path)
        print(f"[OK] MKCOL {folder_path}")

    def upload_file(self, path, content, content_type="text/plain"):
        status, _, _ = self._request(
            path,
            method="PUT",
            body=content.encode("utf-8"),
            headers={"Content-Type": content_type},
            expected_status=201,
        )
        self._assert(status in {200, 201, 204}, f"PUT failed for {path}: {status}")
        self.created_paths.append(path)
        print(f"[OK] PUT {path}")

    def propfind(self, path):
        status, payload, headers = self._request(
            path,
            method="PROPFIND",
            headers={"Depth": "1"},
        )
        self._assert(status == 207, f"PROPFIND failed for {path}: {status}")
        body = payload.decode("utf-8", errors="ignore")
        self._assert("multistatus" in body.lower() or "response" in body.lower(), f"Malformed PROPFIND for {path}")
        print(f"[OK] PROPFIND {path}")
        return body

    def get_file(self, path):
        status, payload, _ = self._request(path, method="GET")
        self._assert(status == 200, f"GET failed for {path}: {status}")
        print(f"[OK] GET {path}")
        return payload.decode("utf-8")

    def head_file(self, path):
        status, payload, headers = self._request(path, method="HEAD")
        self._assert(status in {200, 204}, f"HEAD failed for {path}: {status}")
        self._assert("content-type" in {k.lower(): v for k, v in headers.items()}, f"HEAD missing content-type for {path}")
        print(f"[OK] HEAD {path}")
        return headers

    def copy_resource(self, source_path, destination_path):
        status, _, _ = self._request(
            source_path,
            method="COPY",
            headers={"Destination": self._url(destination_path), "Overwrite": "T"},
        )
        self._assert(status in {200, 201, 204}, f"COPY failed: {status}")
        self.created_paths.append(destination_path)
        print(f"[OK] COPY {source_path} -> {destination_path}")

    def move_resource(self, source_path, destination_path):
        status, _, _ = self._request(
            source_path,
            method="MOVE",
            headers={"Destination": self._url(destination_path), "Overwrite": "T"},
        )
        self._assert(status in {200, 201, 204}, f"MOVE failed: {status}")
        self.created_paths.append(destination_path)
        print(f"[OK] MOVE {source_path} -> {destination_path}")

    def delete_resource(self, path):
        status, _, _ = self._request(path, method="DELETE")
        self._assert(status in {200, 201, 204}, f"DELETE failed for {path}: {status}")
        print(f"[OK] DELETE {path}")

    def cleanup(self):
        for path in reversed(self.created_paths):
            try:
                self.delete_resource(path)
            except AssertionError:
                pass

    def run(self):
        print(f"Testing WebDAV server at {self.base_url}")
        print(f"Using base prefix {self.prefix}")

        folder = f"{self.prefix}/folder"
        renamed_folder = f"{self.prefix}/folder-renamed"
        file_path = f"{self.prefix}/folder/test.txt"
        copied_file = f"{self.prefix}/folder/copied.txt"
        moved_file = f"{self.prefix}/folder-renamed/moved.txt"

        self.create_folder(self.prefix)
        self.create_folder(folder)
        self.upload_file(file_path, "hello webdav")
        self.propfind(self.prefix)
        self.get_file(file_path)
        self.head_file(file_path)
        self.copy_resource(file_path, copied_file)
        self.move_resource(file_path, moved_file)
        self.create_folder(f"{self.prefix}/empty-folder")
        self.delete_resource(copied_file)
        self.move_resource(folder, renamed_folder)
        self.delete_resource(moved_file)
        self.delete_resource(f"{self.prefix}/empty-folder")
        self.delete_resource(renamed_folder)
        self.delete_resource(self.prefix)
        print("All WebDAV operations completed successfully.")


def parse_args():
    parser = argparse.ArgumentParser(description="Smoke-test a WebDAV server")
    parser.add_argument("--base-url", default=os.getenv("WEBDAV_URL", "http://127.0.0.1:8787"))
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    return parser.parse_args()


def main():
    args = parse_args()
    tester = WebDAVTester(args.base_url, args.username, args.password)
    try:
        tester.run()
    except Exception as exc:  # pragma: no cover - CLI safety
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    finally:
        try:
            tester.cleanup()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
