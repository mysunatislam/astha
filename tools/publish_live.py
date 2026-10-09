"""Stage a verified web build in a separate astha-live branch, without publishing.

Usage: python tools/publish_live.py --checkout /path/to/astha-live
Create a clean non-main branch in the distribution checkout first. Review and commit
the staged files, open a pull request, and promote only after the release gates pass.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ("index.html", "backend.js", "config.js", "sw.js", "manifest.webmanifest")
ASSETS = ("icons/icon-192.png", "icons/icon-512.png", "models/yolo26n.onnx")

def git(checkout, *args):
    return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path)
    args = parser.parse_args()
    checkout = args.checkout.resolve()
    if not (checkout / ".git").exists():
        parser.error("--checkout must be an existing astha-live Git checkout")
    if checkout == ROOT or ROOT in checkout.parents or checkout in ROOT.parents:
        parser.error("the distribution checkout must be separate from the source checkout")
    remote = git(checkout, "remote", "get-url", "origin").removesuffix(".git").rstrip("/")
    if remote not in ("https://github.com/mysunatislam/astha-live", "git@github.com:mysunatislam/astha-live"):
        parser.error("origin must be the expected mysunatislam/astha-live repository")
    branch = git(checkout, "branch", "--show-current")
    if not branch or branch in ("main", "master"):
        parser.error("create a separate review branch in the distribution checkout first")
    if git(checkout, "status", "--porcelain"):
        parser.error("the distribution checkout must be clean before staging")
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], cwd=ROOT, check=True)
    for relative in (*FILES, *ASSETS):
        if not (ROOT / "web" / relative).is_file():
            parser.error("missing build asset: " + relative)
    manifest = {"source_commit": git(ROOT, "rev-parse", "HEAD"),
                "source_dirty": bool(git(ROOT, "status", "--porcelain")), "sha256": {}}
    for relative in (*FILES, *ASSETS):
        source = ROOT / "web" / relative
        destination = checkout / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        manifest["sha256"][relative] = hashlib.sha256(source.read_bytes()).hexdigest()
    (checkout / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("Staged verified build on " + branch + ". Review the diff; no commit or push was made.")
    print("The existing APK download is unchanged and is not verified by this web build.")

if __name__ == "__main__":
    main()
