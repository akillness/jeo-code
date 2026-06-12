import { test, expect } from "bun:test";
import { runSessionCommandWith } from "../src/commands/session";

test("list filters non-jeo sessions and formats output", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      expect(argv).toEqual(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}\t#{@jeo-profile}\t#{@jeo-branch}\t#{@jeo-project}"]);
      return {
        exitCode: 0,
        stdout: "jeo-session-1\t1686259200\t1\nnon-jeo-session\t1686259200\t0\njeo-session-2\t1686262800\t0\n",
        stderr: "",
      };
    };

    await runSessionCommandWith(["list"], fakeTmux);

    expect(process.exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("jeo-session-1");
    expect(output).toContain("jeo-session-2");
    expect(output).not.toContain("non-jeo-session");
    expect(output).toContain(new Date(1686259200 * 1000).toISOString());
    expect(output).toContain("yes");
    expect(output).toContain("no");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("list with --json formats as JSON", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      return {
        exitCode: 0,
        stdout: "jeo-session-1\t1686259200\t1\n",
        stderr: "",
      };
    };

    await runSessionCommandWith(["list", "--json"], fakeTmux);

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toEqual([
      {
        name: "jeo-session-1",
        created: new Date(1686259200 * 1000).toISOString(),
        attached: true,
        owned: false,
      }
    ]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("list with tmux absent (no server or exitCode 1) -> empty-friendly message exit 0", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 99;
    const fakeTmux = (argv: string[]) => {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "error: no server running\n",
      };
    };

    await runSessionCommandWith(["list"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("No active jeo sessions found.");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm refuses non-jeo- name with exitCode 1", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["rm", "non-jeo-session"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Refusing to kill non-jeo session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm jeo- name invokes kill-session argv", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  let killArgs: string[] | null = null;
  try {
    process.exitCode = 99;
    const fakeTmux = (argv: string[]) => {
      killArgs = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["rm", "jeo-session-1"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(killArgs).toEqual(["kill-session", "-t", "=jeo-session-1"]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("attach unknown name (not in list output) -> exitCode 1", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      if (argv[0] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: "jeo-session-1\t1686259200\t1\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["attach", "jeo-session-99"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Session 'jeo-session-99' not found");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("attach known name -> invokes attach -t name", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  let attachArgs: string[] | null = null;
  try {
    process.exitCode = 99;
    const fakeTmux = (argv: string[]) => {
      if (argv[0] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: "jeo-session-1\t1686259200\t1\n",
          stderr: "",
        };
      }
      attachArgs = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["attach", "jeo-session-1"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(attachArgs).toEqual(["attach", "-t", "=jeo-session-1"]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("unknown verb usage exitCode 1", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["foo-bar-verb"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Unknown subcommand: foo-bar-verb");
    expect(logs.join("\n")).toContain("Usage: jeo session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("--help usage exitCode 0", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 99;
    const fakeTmux = (argv: string[]) => {
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["--help"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Usage: jeo session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("list keeps marker-owned sessions regardless of name; records branch/project identity", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (_argv: string[]) => ({
      exitCode: 0,
      stdout: [
        // marker-owned but custom-named (e.g. renamed by the user after launch)
        "my-custom-name\t1686259200\t0\t1\tmain\t/home/u/proj",
        // foreign session, no marker, no prefix → filtered out
        "user-shell\t1686259200\t1\t\t\t",
        // prefix-detected legacy session without marker → kept
        "jeo-old-build\t1686262800\t0\t\t\t",
      ].join("\n") + "\n",
      stderr: "",
    });

    await runSessionCommandWith(["list", "--json"], fakeTmux);

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toEqual([
      {
        name: "my-custom-name",
        created: new Date(1686259200 * 1000).toISOString(),
        attached: false,
        owned: true,
        branch: "main",
        project: "/home/u/proj",
      },
      {
        name: "jeo-old-build",
        created: new Date(1686262800 * 1000).toISOString(),
        attached: false,
        owned: false,
      },
    ]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("list table shows the @jeo-branch identity column", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (_argv: string[]) => ({
      exitCode: 0,
      stdout: "jeo-main-x\t1686259200\t1\t1\tfeature-branch\t/home/u/proj\n",
      stderr: "",
    });

    await runSessionCommandWith(["list"], fakeTmux);

    const output = logs.join("\n");
    expect(output).toContain("Branch");
    expect(output).toContain("feature-branch");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm allows a marker-owned session even without the jeo- prefix (exact kill target)", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  let killArgs: string[] | null = null;
  try {
    process.exitCode = 99;
    const fakeTmux = (argv: string[]) => {
      if (argv[0] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: "my-custom-name\t1686259200\t0\t1\tmain\t/home/u/proj\n",
          stderr: "",
        };
      }
      killArgs = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["rm", "my-custom-name"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(killArgs).toEqual(["kill-session", "-t", "=my-custom-name"]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm still refuses an unmarked, unprefixed session even when it exists", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  let killed = false;
  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      if (argv[0] === "list-sessions") {
        // Visible but unmarked and unprefixed → not jeo-owned.
        return { exitCode: 0, stdout: "user-shell\t1686259200\t1\t\t\t\n", stderr: "" };
      }
      killed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["rm", "user-shell"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(killed).toBe(false);
    expect(logs.join("\n")).toContain("Refusing to kill non-jeo session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});
