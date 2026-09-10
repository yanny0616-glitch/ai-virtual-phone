"""Exercise the actual deployment cleanup against disposable release trees."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

script = (Path(__file__).resolve().parents[1] / 'ops/float-deploy.sh').read_text()
body = script.split('prune_releases() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
subprocess.run(['bash', '-n', str(Path(__file__).resolve().parents[1] / 'ops/float-deploy.sh')], check=True)


def scenario(current_index, previous_index=None):
    with tempfile.TemporaryDirectory(prefix='float-retention-') as temp:
        base = Path(temp)
        root = base / 'releases'
        root.mkdir()
        releases = []
        for i in range(6):
            sha = f'{i:012x}' + 'a' * 28
            path = root / ('float-build-' + sha[:12])
            path.mkdir()
            (path / 'VERSION').write_text(sha + '\n')
            (path / 'server.js').write_text('// fixture')
            os.utime(path, (100 + i, 100 + i))
            releases.append(path)
        unknown = root / 'manual-backup'
        unknown.mkdir()
        malformed = root / 'float-build-ffffffffffff'
        malformed.mkdir()
        outside = base / 'outside'
        outside.mkdir()
        (outside / 'marker').write_text('preserve')
        symlink = root / 'float-build-eeeeeeeeeeee'
        symlink.symlink_to(outside, target_is_directory=True)
        link = base / 'current'
        target = outside if current_index == 'outside' else releases[current_index]
        link.symlink_to(target, target_is_directory=True)
        previous = str(releases[previous_index]) if previous_index is not None else ''
        result = subprocess.run([sys.executable, '-', str(root), str(link), previous], input=body, text=True, capture_output=True)
        if current_index == 'outside':
            assert result.returncode != 0 and all(p.exists() for p in releases), result
        else:
            assert result.returncode == 0, result.stderr
            kept = [p for p in releases if p.exists()]
            expected = {target}
            if previous_index is not None:
                expected.add(releases[previous_index])
            for p in reversed(releases):
                if len(expected) == 3:
                    break
                expected.add(p)
            assert set(kept) == expected, kept
            again = subprocess.run([sys.executable, '-', str(root), str(link), previous], input=body, text=True, capture_output=True)
            assert again.returncode == 0 and 'removed 0' in again.stdout
        assert unknown.is_dir() and malformed.is_dir() and symlink.is_symlink()
        assert (outside / 'marker').read_text() == 'preserve'


scenario(5)
scenario(0)  # A rollback can make the oldest artifact the current release.
scenario(5, 0)  # Explicitly protect the previous target after a deployment.
scenario('outside')
print('PASS: retention, rollback protection, idempotence, unrelated paths, unsafe current target, bash syntax')
