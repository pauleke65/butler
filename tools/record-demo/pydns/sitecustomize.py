"""Process-local DNS fallback (PYTHONPATH=tools/record-demo/pydns). Some home routers' system resolver briefly caches
failed lookups for AWS endpoints; when getaddrinfo fails, ask the nameserver directly with `dig` and connect to that
address. TLS still verifies the original hostname. Nothing outside this process changes."""
import socket
import subprocess

_original = socket.getaddrinfo
_last_good: dict = {}


def _getaddrinfo(host, port, *args, **kwargs):
    try:
        res = _original(host, port, *args, **kwargs)
        if isinstance(host, str):
            _last_good[host] = res
        return res
    except socket.gaierror:
        if not isinstance(host, str):
            raise
        try:
            out = subprocess.run(["dig", "+short", "+time=3", host], capture_output=True, text=True, timeout=8).stdout
            ip = next((line for line in out.split() if line.count(".") == 3 and line.replace(".", "").isdigit()), None)
        except Exception:  # noqa: BLE001
            ip = None
        if ip:
            return _original(ip, port, *args, **kwargs)
        if host in _last_good:
            return _last_good[host]
        raise


socket.getaddrinfo = _getaddrinfo
