"""Run the pinned build bootstrap and receipt checks, never its compilation."""
import pathlib
import re
import subprocess
import sys


def preparation(script):
    marker = 'ninja -C "$output_dir" -j"${BUILD_JOBS:-4}" remote_paint_tools\n'
    if script.count(marker) != 1:
        raise ValueError('Expected the exact single pinned compilation boundary')
    prefix = script.split(marker, 1)[0]
    if re.search(r'^\s*ninja\s+-C\b', prefix, re.MULTILINE):
        raise ValueError('Unexpected earlier Ninja build command')
    return prefix


if __name__ == '__main__':
    prefix = preparation(pathlib.Path(sys.argv[1]).read_text())
    subprocess.run(['sh', '-n'], input=prefix, text=True, check=True)
    subprocess.run(['sh', '-eu', '-c', prefix], check=True)
