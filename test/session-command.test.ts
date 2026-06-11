import { test, expect } from "bun:test";
import { runSessionCommandWith } from "../src/commands/session";

test("list filters non-joc sessions and formats output", async () => {
  const originalExitCode = process.exitCode;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };

  try {
    process.exitCode = 0;
    const fakeTmux = (argv: string[]) => {
      expect(argv).toEqual(["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}"]);
      return {
        exitCode: 0,
        stdout: "joc-session-1\t1686259200\t1\nnon-joc-session\t1686259200\t0\njoc-session-2\t1686262800\t0\n",
        stderr: "",
      };
    };

    await runSessionCommandWith(["list"], fakeTmux);

    expect(process.exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("joc-session-1");
    expect(output).toContain("joc-session-2");
    expect(output).not.toContain("non-joc-session");
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
        stdout: "joc-session-1\t1686259200\t1\n",
        stderr: "",
      };
    };

    await runSessionCommandWith(["list", "--json"], fakeTmux);

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toEqual([
      {
        name: "joc-session-1",
        created: new Date(1686259200 * 1000).toISOString(),
        attached: true,
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
    expect(logs.join("\n")).toContain("No active joc sessions found.");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm refuses non-joc- name with exitCode 1", async () => {
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

    await runSessionCommandWith(["rm", "non-joc-session"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Refusing to kill non-joc session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});

test("rm joc- name invokes kill-session argv", async () => {
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

    await runSessionCommandWith(["rm", "joc-session-1"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(killArgs).toEqual(["kill-session", "-t", "joc-session-1"]);
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
          stdout: "joc-session-1\t1686259200\t1\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["attach", "joc-session-99"], fakeTmux);

    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Session 'joc-session-99' not found");
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
          stdout: "joc-session-1\t1686259200\t1\n",
          stderr: "",
        };
      }
      attachArgs = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await runSessionCommandWith(["attach", "joc-session-1"], fakeTmux);

    expect(process.exitCode).toBe(0);
    expect(attachArgs).toEqual(["attach", "-t", "joc-session-1"]);
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
    expect(logs.join("\n")).toContain("Usage: joc session");
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
    expect(logs.join("\n")).toContain("Usage: joc session");
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
});
