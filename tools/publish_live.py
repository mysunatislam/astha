"""Publish the latest Astha web app build to the public astha-live distribution repo.
Usage: python tools/publish_live.py [optional commit message]
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
WEB = ROOT / "web"
SCRATCH_DEPLOY = Path(r"C:\Users\Kotha\.gemini\antigravity\scratch\astha-live")
PUBLIC_REPO = "mysunatislam/astha-live"
LIVE_URL = "https://mysunatislam.github.io/astha-live/"

def run(cmd, cwd=None):
    print(f"--> {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    res = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Error ({res.returncode}):\n{res.stderr}")
        sys.exit(res.returncode)
    return res.stdout.strip()

def main():
    commit_msg = sys.argv[1] if len(sys.argv) > 1 else "Update live web app release"
    
    print("1. Compiling latest web/index.html via tools/build.py...")
    run([sys.executable, str(TOOLS / "build.py")], cwd=str(ROOT))
    
    print("2. Syncing web distribution files to astha-live...")
    if not SCRATCH_DEPLOY.exists() or not (SCRATCH_DEPLOY / ".git").exists():
        SCRATCH_DEPLOY.parent.mkdir(parents=True, exist_ok=True)
        run(["gh", "repo", "clone", PUBLIC_REPO, str(SCRATCH_DEPLOY)])
    else:
        run(["git", "pull", "--rebase", "origin", "main"], cwd=str(SCRATCH_DEPLOY))
        
    for item in WEB.iterdir():
        dest = SCRATCH_DEPLOY / item.name
        if item.is_dir():
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(item, dest)
        else:
            shutil.copy2(item, dest)
            
    print("3. Committing and pushing to public live repository...")
    run(["git", "add", "."], cwd=str(SCRATCH_DEPLOY))
    status = run(["git", "status", "--porcelain"], cwd=str(SCRATCH_DEPLOY))
    if status:
        run(["git", "commit", "-m", commit_msg], cwd=str(SCRATCH_DEPLOY))
        run(["git", "push", "origin", "main"], cwd=str(SCRATCH_DEPLOY))
        print("Successfully deployed new release!")
    else:
        print("No changes to deploy. astha-live is already up to date.")
        
    print(f"\nAstha Live Web App is public at:\n  {LIVE_URL}\n")

if __name__ == "__main__":
    main()
