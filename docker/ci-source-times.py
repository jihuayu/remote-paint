"""Invalidate project-owned inputs while reusing pinned upstream build output."""
import pathlib
import re
import sys


def refresh(source, project):
    paths = {'.gn', 'BUILD.gn', 'third_party/swiftshader/BUILD.gn'}
    paths.update('components/remote_paint/' + p.name
                 for p in (project / 'native/chromium').iterdir() if p.is_file())
    for patch in (project / 'native/patches').glob('*.patch'):
        paths.update(re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(), re.M))
    for name in sorted(paths):
        path = source / name
        if not path.is_file():
            raise FileNotFoundError('Missing patched/native build input: ' + name)
        path.touch()
    print(f'Refreshed {len(paths)} native/patched build inputs; upstream mtimes remain pinned')


if __name__ == '__main__':
    refresh(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
