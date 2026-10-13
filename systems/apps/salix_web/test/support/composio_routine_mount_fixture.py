"""Map only the documented mount to a private real test directory.

This fixture adapter never ships in the runtime request. All descendant opens,
symlinks, file reads and parsing use the actual filesystem and fixed extractor.
"""
import os
import sys

code, fixture_root = sys.argv[1:]
realpath = os.path.realpath
open_file = os.open


def fixture_realpath(path, *args, **kwargs):
    return realpath(fixture_root if path == '/mnt/files' else path, *args, **kwargs)


def fixture_open(path, *args, **kwargs):
    return open_file(fixture_root if path == '/mnt/files' else path, *args, **kwargs)


os.path.realpath = fixture_realpath
os.open = fixture_open
exec(compile(code, '<closed-routine-extractor>', 'exec'), {})
