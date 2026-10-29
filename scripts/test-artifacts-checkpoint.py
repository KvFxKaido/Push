"""Linux integration test: real shallow Git repos, not a mocked command list."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'sandbox/bin/push-artifacts-checkpoint'


class CheckpointRoundTrip(unittest.TestCase):
    def test_preserves_shallow_history_index_and_working_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()

            def git(*args, cwd=source):
                return subprocess.check_output(['git', '-c', 'user.name=Test', '-c',
                    'user.email=test@example.invalid', *args], cwd=cwd, stderr=subprocess.PIPE)

            git('init', '--initial-branch=main')
            (source / 'tracked').write_text('base\n')
            (source / 'deleted').write_text('remove me\n')
            (source / 'directory').mkdir()
            (source / 'directory/leaf').write_text('tracked child\n')
            (source / '.gitignore').write_text('ignored\n')
            git('add', '.')
            git('commit', '-m', 'base')
            (source / 'tracked').write_text('remote tip\n')
            git('commit', '-am', 'tip')
            workspace = root / 'workspace'
            git('clone', '--depth=1', source.as_uri(), str(workspace))
            (workspace / 'local').write_text('unpushed commit\n')
            git('add', '.', cwd=workspace)
            git('commit', '-m', 'local', cwd=workspace)
            (workspace / 'tracked').write_text('staged\n')
            git('add', 'tracked', cwd=workspace)
            (workspace / 'tracked').write_text('unstaged\n')
            (workspace / 'deleted').unlink()
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'leaf').write_text('outside workspace\n')
            shutil.rmtree(workspace / 'directory')
            (workspace / 'directory').symlink_to(outside, target_is_directory=True)
            (workspace / 'new file').write_bytes(b'\x00\xff binary')
            (workspace / 'ignored').write_text('must not be stored')
            (workspace / 'link').symlink_to('tracked')
            (workspace / 'executable').write_text('#!/bin/sh\nexit 0\n')
            (workspace / 'executable').chmod(0o755)
            before = git('status', '--porcelain=v1', '-z', cwd=workspace)
            head = git('rev-parse', 'HEAD', cwd=workspace)
            stage = root / 'checkpoint'
            subprocess.run(['python3', str(HELPER), 'capture', str(workspace), str(stage)], check=True)
            self.assertEqual(before, git('status', '--porcelain=v1', '-z', cwd=workspace))
            restored = root / 'restored'
            subprocess.run(['python3', str(HELPER), 'restore', str(stage), str(restored)], check=True)
            self.assertEqual(head, git('rev-parse', 'HEAD', cwd=restored))
            self.assertEqual(before, git('status', '--porcelain=v1', '-z', cwd=restored))
            self.assertEqual(git('show', ':tracked', cwd=restored), b'staged\n')
            self.assertEqual((restored / 'tracked').read_text(), 'unstaged\n')
            self.assertFalse((restored / 'ignored').exists())
            self.assertEqual((restored / 'new file').read_bytes(), b'\x00\xff binary')
            self.assertEqual(os.readlink(restored / 'link'), 'tracked')
            self.assertEqual(os.readlink(restored / 'directory'), str(outside))
            self.assertEqual((outside / 'leaf').read_text(), 'outside workspace\n')
            self.assertTrue(os.access(restored / 'executable', os.X_OK))
            self.assertEqual((restored / '.git/shallow').read_bytes(), (workspace / '.git/shallow').read_bytes())
            git('fsck', '--full', cwd=restored)


if __name__ == '__main__':
    unittest.main()
