"""Minimal stand-in for httpx, used only by the tests when the real package is absent.
Implements the subset the Open WebUI pipe uses, on top of urllib in a worker thread."""
import asyncio, json, urllib.error, urllib.parse, urllib.request


class HTTPError(Exception):
    pass


class Timeout:
    def __init__(self, *a, **k):
        pass


class Response:
    def __init__(self, code, data):
        self.status_code, self._data = code, data

    def json(self):
        return json.loads(self._data or b"{}")

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPError(f"HTTP {self.status_code}")


class AsyncClient:
    def __init__(self, timeout=None):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def _do(self, method, url, params=None, json_body=None, headers=None):
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(json_body).encode() if json_body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return Response(r.status, r.read())
        except urllib.error.HTTPError as e:
            return Response(e.code, e.read())
        except urllib.error.URLError as e:
            raise HTTPError(str(e))

    async def post(self, url, json=None, headers=None):
        return await asyncio.to_thread(self._do, "POST", url, None, json, headers)

    async def get(self, url, params=None, headers=None):
        return await asyncio.to_thread(self._do, "GET", url, params, None, headers)
