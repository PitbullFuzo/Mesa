"""Exercise the installed shim without inference or reading fixture contents."""
import hermes_bootstrap  # activate the installed environment before changing argv
import json
import os
import runpy
import sys
import tempfile
from unittest.mock import patch

helper = sys.argv[1]
sys.argv = [helper, "--check"]
n = runpy.run_path(helper)
dispatch = n["dispatch"]
dispatch.__globals__["original_dispatch"] = lambda *a, **k: "ALLOWED"
web = os.environ.get('AGENTHQ_WEB_ACCESS') != 'false'
assert ('web' in n['policy_config']()['platform_toolsets']['acp']) == web
for tool in ['web_search', 'web_extract']:
    assert (dispatch(tool, {}) == 'ALLOWED') == web
    assert (tool in n['ALLOWED']) == web
original_cwd = os.getcwd()
with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temp:
    vault = os.path.join(temp, "vault")
    work = os.path.join(vault, "Work")
    cwd = os.path.join(work, "agent")
    attachments = os.path.join(vault, "Attachments")
    for p in [cwd, attachments]:
        os.makedirs(p)
    os.chdir(cwd)
    os.environ["AGENTHQ_READ_ROOTS"] = json.dumps([cwd, work, attachments])
    for path in ["ok.txt", os.path.join(work, "other.txt"), os.path.join(attachments, "image.png")]:
        assert dispatch("read_file", {"path": path}) == "ALLOWED", path
    assert dispatch("search_files", {"pattern": "ok"}) == "ALLOWED"
    for path in [os.path.join(vault, "Notes", "secret.md"), "~/.ssh/id_rsa", "../../secret", "..\\..\\secret", "\\\\server\\share\\secret", "//server/share/secret", "\\\\?\\C:\\secret", os.path.join(temp, "vault-other", "secret")]:
        assert "denied" in dispatch("read_file", {"path": path}).lower(), path
        assert "denied" in dispatch("search_files", {"path": path, "pattern": "x"}).lower(), path
    native = os.path.realpath
    link = os.path.join(cwd, "link.txt")
    with patch("os.path.realpath", side_effect=lambda path: os.path.join(temp, "outside.txt") if os.path.abspath(path) == link else native(path)):
        assert "denied" in dispatch("read_file", {"path": link}).lower()
    os.environ.pop("AGENTHQ_READ_ROOTS")
    assert "denied" in dispatch("read_file", {"path": "ok.txt"}).lower()
    assert "denied" in dispatch("search_files", {"pattern": "x"}).lower()
    os.chdir(original_cwd)
print("READ_POLICY_PASS_NO_INFERENCE")
