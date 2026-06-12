import subprocess
import os

env = os.environ.copy()
env["JEO_DEV_MODE"] = "1"
env["NODE_ENV"] = "development"

try:
    # Use cmd.exe /c to set env vars and run bun
    cmd_string = 'set JEO_DEV_MODE=1 && set NODE_ENV=development && bun run src/cli.ts evolve-core'
    result = subprocess.run(
        ["cmd.exe", "/c", cmd_string],
        env=env,
        cwd=os.getcwd(),
        capture_output=True
    )
    print("STDOUT:", result.stdout.decode('cp949', errors='ignore'))
    print("STDERR:", result.stderr.decode('cp949', errors='ignore'))
    print("EXIT CODE:", result.returncode)
except Exception as e:
    print("ERROR:", str(e))
