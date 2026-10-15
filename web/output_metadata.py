"""Bounded content covers and actual filesystem creation times for the library."""
import ctypes
import math
import os
import sys


class _Timestamp(ctypes.Structure):
    _fields_ = [('seconds', ctypes.c_int64), ('nanoseconds', ctypes.c_uint32),
                ('reserved', ctypes.c_int32)]


class _Statx(ctypes.Structure):
    _fields_ = [('mask', ctypes.c_uint32), ('prefix', ctypes.c_byte * 60),
                ('accessed', _Timestamp), ('born', _Timestamp),
                ('remainder', ctypes.c_byte * 160)]


def _linux_birthtime(path):
    try:
        statx = ctypes.CDLL(None, use_errno=True).statx
        statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                          ctypes.c_uint, ctypes.POINTER(_Statx)]
        statx.restype = ctypes.c_int
        result = _Statx()
        if statx(-100, os.fsencode(path), 0, 0x800, ctypes.byref(result)) == 0 and result.mask & 0x800:
            return result.born.seconds + result.born.nanoseconds / 1e9
    except (AttributeError, OSError):
        pass
    return None


def creation_time(path, stat):
    value = getattr(stat, 'st_birthtime', None)
    if value is None:
        value = stat.st_ctime if sys.platform == 'win32' else _linux_birthtime(path) if sys.platform == 'linux' else None
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


def text_cover(path):
    try:
        with path.open('rb') as stream:
            data = stream.read(4096)
        if b'\x00' in data:
            return ''
        text = data.decode('utf-8-sig', errors='replace')
        return '\n'.join(line.rstrip() for line in text.splitlines() if line.strip())[:600]
    except OSError:
        return ''
