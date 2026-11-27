// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertProcessStopped, command, fakeTlc, fixture, includes, isStopped, logs, processesWhere, removeFixtures, root, run, scripts, waitFor } from "./helpers.mjs";

afterEach(removeFixtures);

test("SIGTERM stops TLC and the processes it started, cleans temporary directories and ends the runner by SIGTERM", async () => {
  const dir = fixture();
  const customTmp = join(dir, "nested", "signal-tmp");
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun hang | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const pidFile = join(dir, "child.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const readyFile = join(dir, "ready");
  const java = fakeTlc(dir, [
    'for last; do :; done',
    'mkdir -p "$(dirname "$last")/states"',
    'echo data > "$(dirname "$last")/states/mock.fp"',
    'sleep 30 &',
    'echo "$!" > "$TASK_GRANDCHILD_PID_FILE"',
    'echo "$$" > "$TASK_PID_FILE"',
    'echo ready > "$TASK_READY_FILE"',
    'wait',
  ].join("\n"));
  let signalled;
  const code = await new Promise((resolve) => {
    const child = spawn("python3", [join(scripts, "tlc.py"), join(dir, "One.matrix")], {
      env: {
        ...process.env,
        JAVA: java,
        TLC_JAR: join(dir, "tools.jar"),
        TMPDIR: customTmp,
        TASK_PID_FILE: pidFile,
        TASK_GRANDCHILD_PID_FILE: grandchildPidFile,
        TASK_READY_FILE: readyFile,
        FORMAL_MIN_FREE_GIB: "0",
      },
    });
    const timer = setInterval(() => {
      if (existsSync(readyFile)) {
        clearInterval(timer);
        signalled = Date.now();
        child.kill("SIGTERM");
      }
    }, 20);
    child.on("close", (exitCode, signalName) => {
      clearInterval(timer);
      resolve({ exitCode, signalName, stopped: Date.now() - signalled });
    });
  });
  assertProcessStopped(Number(readFileSync(pidFile, "utf8").trim()));
  assertProcessStopped(Number(readFileSync(grandchildPidFile, "utf8").trim()));
  assert.deepEqual(readdirSync(customTmp), []);
  assert.equal(code.signalName, "SIGTERM", JSON.stringify(code));
  // TLC and its sleep die on SIGTERM, so the runner must not wait out the two seconds it allows,
  // even where nothing reaps the dead processes, as in a container whose first process never does.
  assert.ok(code.stopped < 1500, JSON.stringify(code));
});

test("SIGTERM that arrives while the runner starts TLC still stops TLC and the processes it started", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun hang | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const pidFile = join(dir, "child.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  const readyFile = join(dir, "ready");
  const java = fakeTlc(dir, [
    'sleep 30 &',
    'echo "$!" > "$TASK_GRANDCHILD_PID_FILE"',
    'echo "$$" > "$TASK_PID_FILE"',
    'echo ready > "$TASK_READY_FILE"',
    'wait',
  ].join("\n"));
  const tlc = join(scripts, "tlc.py");
  const script = [
    "import os, runpy, signal, subprocess, sys, time",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "real_init = subprocess.Popen.__init__",
    "def init(self, args, *rest, **kwargs):",
    "    real_init(self, args, *rest, **kwargs)",
    // The readiness check runs tlc2.TLC -help first; the hook waits for the model run.
    "    if 'tlc2.TLC' in args and '-help' not in args:",
    // Bounded, since the handler holds back a signal while Popen runs, the timeout's SIGTERM included.
    "        deadline = time.monotonic() + 5",
    "        while not os.path.exists(os.environ.get('TASK_READY_FILE')):",
    "            if time.monotonic() > deadline:",
    "                raise RuntimeError('the fake TLC never became ready')",
    "            time.sleep(0.02)",
    // The signal handler runs inside Popen, as it does when a signal lands while Popen waits for TLC to start.
    "        os.kill(os.getpid(), signal.SIGTERM)",
    "        time.sleep(0.3)",
    "subprocess.Popen.__init__ = init",
    `sys.argv = [${JSON.stringify(tlc)}, ${JSON.stringify(join(dir, "One.matrix"))}]`,
    `runpy.run_path(${JSON.stringify(tlc)}, run_name='__main__')`,
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], {
    encoding: "utf8",
    timeout: 10000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      JAVA: java,
      TLC_JAR: join(dir, "tools.jar"),
      TASK_PID_FILE: pidFile,
      TASK_GRANDCHILD_PID_FILE: grandchildPidFile,
      TASK_READY_FILE: readyFile,
      FORMAL_MIN_FREE_GIB: "0",
    },
  });
  assert.ok(existsSync(grandchildPidFile) && existsSync(pidFile), result.stderr);
  const pids = [pidFile, grandchildPidFile].map((file) => Number(readFileSync(file, "utf8").trim()));
  try {
    assert.equal(result.signal, "SIGTERM", result.stderr);
    for (const pid of pids) assertProcessStopped(pid);
  } finally {
    killAll(...pids);
  }
});

test("SIGTERM also stops processes started while the runner is stopping TLC, through every generation", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun hang | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realPs, "ps must be on PATH");
  const listings = join(dir, "listings");
  // Each listing of the checker's descendants lets one more generation of TLC's processes start,
  // and is held back until that generation has started, so the listing misses it. Three
  // generations need three listings that find something, so a stop that lists twice misses one.
  command(dir, "ps", [
    `case "$*" in *ppid*) ;; *) exec "${realPs}" "$@" ;; esac`,
    `listing=$("${realPs}" "$@")`,
    `n=$(($(cat "${listings}" 2> /dev/null | wc -l) + 1))`,
    `printf '%s\\n' "$listing" > "${dir}/listing-$n"`,
    `echo "$n" >> "${listings}"`,
    `touch "${dir}/go-$n"`,
    "i=0",
    `while [ "$n" -lt 3 ] && [ ! -s "${dir}/started-$((n + 1))" ] && [ "$i" -lt 500 ]; do sleep 0.01; i=$((i + 1)); done`,
    `printf '%s\\n' "$listing"`,
  ].join("\n"));
  const nap = `30.${process.pid}${Date.now() % 100000}`;
  const pace = `0.0100${process.pid}`;
  const java = fakeTlc(dir, [
    "grow() {",
    '  sleep "$TASK_NAP" &',
    '  echo "$!" > "$TASK_DIR/started-$1"',
    '  if [ "$1" -lt 3 ]; then',
    '    until [ -e "$TASK_DIR/go-$1" ]; do sleep "$TASK_PACE"; done',
    '    grow $(($1 + 1)) &',
    "  fi",
    "  wait",
    "}",
    "grow 1 &",
    "wait",
  ].join("\n"));
  const marked = () => processesWhere((command) => command === `sleep ${nap}` || command === `sleep ${pace}`);
  const probe = spawn("sleep", [nap]);
  try {
    assert.ok(waitFor(() => marked().includes(probe.pid)), "the process search must find a marked sleep");
  } finally {
    probe.kill("SIGKILL");
  }
  const started = (generation) => join(dir, `started-${generation}`);
  const code = await new Promise((resolve) => {
    const child = spawn("python3", [join(scripts, "tlc.py"), join(dir, "One.matrix")], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        JAVA: java,
        TLC_JAR: join(dir, "tools.jar"),
        TASK_NAP: nap,
        TASK_PACE: pace,
        TASK_DIR: dir,
        FORMAL_MIN_FREE_GIB: "0",
      },
    });
    const timer = setInterval(() => {
      if (existsSync(started(1)) && readFileSync(started(1), "utf8").endsWith("\n")) {
        clearInterval(timer);
        // The runner needs a moment after it starts TLC to reach the code that stops it on a signal; see #152.
        setTimeout(() => child.kill("SIGTERM"), 200);
      }
    }, 20);
    child.on("close", (exitCode, signalName) => {
      clearInterval(timer);
      resolve({ exitCode, signalName });
    });
  });
  const listed = (n) => {
    const file = join(dir, `listing-${n}`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").map((line) => line.trim().split(/\s+/)[0]) : [];
  };
  try {
    assert.equal(code.signalName, "SIGTERM", JSON.stringify(code));
    assert.ok(existsSync(started(3)), "the third generation never started, so the stop listed too few times to tell");
    const last = readFileSync(started(3), "utf8").trim();
    assert.ok(!listed(1).includes(last) && listed(3).includes(last), "a later listing must find the third generation, which the first missed");
    assert.ok(waitFor(() => marked().length === 0), `still running: ${marked()}`);
  } finally {
    for (const find of [() => processesWhere((command) => command.includes(dir)), marked]) {
      for (const pid of find()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }
});

test("a second interrupt while the runner stops TLC does not leave TLC suspended", () => {
  const dir = fixture();
  const ps = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  assert.ok(ps, "ps must be on PATH");
  writeFileSync(join(dir, "ps"), `#!/bin/sh\nkill -INT "$PPID"\nexec "${ps}" "$@"\n`, { mode: 0o755 });
  const script = [
    "import os, signal, subprocess, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import processes",
    "signal.signal(signal.SIGINT, signal.default_int_handler)",
    "checker = subprocess.Popen(['sleep', '30'])",
    "try:",
    "    try:",
    "        processes.stop_process(checker)",
    "        print('not interrupted')",
    "    except KeyboardInterrupt:",
    "        print('interrupted')",
    "    try:",
    "        print('exited', checker.wait(timeout=5))",
    "    except subprocess.TimeoutExpired:",
    "        print('still suspended')",
    "finally:",
    "    checker.kill()",
    "    checker.wait()",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["interrupted", "exited -15"]);
});

test("stopping a checker that exits just after the runner checks it sends no signal to its freed pid", () => {
  const script = [
    "import os, signal, subprocess, sys, time",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import processes",
    "checker = subprocess.Popen(['true'])",
    "# Wait for the exit without reaping the checker; macOS Python has no os.waitid.",
    "while not subprocess.run(['ps', '-o', 'stat=', '-p', str(checker.pid)], capture_output=True, text=True).stdout.strip().startswith('Z'):",
    "    time.sleep(0.01)",
    "# The first poll misses the exit, as it does when the checker exits right after it.",
    "polls = []",
    "real_poll = checker.poll",
    "def poll():",
    "    polls.append(1)",
    "    return None if len(polls) == 1 else real_poll()",
    "checker.poll = poll",
    "sent = []",
    "real_kill = os.kill",
    "def kill(pid, signum):",
    "    if pid != checker.pid:",
    "        return real_kill(pid, signum)",
    "    sent.append(signal.Signals(signum).name)",
    "os.kill = kill",
    "processes.stop_process(checker)",
    "print(checker.returncode, sent)",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0 []");
});

function stopChecker(dir, checker, settings = []) {
  const script = [
    "import os, subprocess, sys, time",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import processes",
    ...settings,
    // A process the checker started keeps any pipe it inherits open, and spawnSync waits for the pipes to close.
    `checker = subprocess.Popen(['bash', '-c', ${JSON.stringify(checker)}, 'checker', sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
    "open(sys.argv[1] + '.checker', 'w').write(str(checker.pid))",
    "while not (os.path.exists(sys.argv[1]) and open(sys.argv[1]).read().endswith('\\n')):",
    "    time.sleep(0.02)",
    "processes.stop_process(checker)",
    "print(checker.returncode)",
  ].join("\n");
  const pidFile = join(dir, "sleep.pid");
  const result = spawnSync("python3", ["-B", "-c", script, pidFile], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  return { result, pid: Number(readFileSync(pidFile, "utf8")), checker: Number(readFileSync(`${pidFile}.checker`, "utf8")) };
}

function killAll(...pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

test("stopping a checker also kills a process it started that ignores SIGTERM", () => {
  const dir = fixture();
  const { result, pid } = stopChecker(dir, 'trap "" TERM; sleep 30 & echo "$!" > "$1"; wait');
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-9");
    assertProcessStopped(pid);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

for (const [scenario, where] of [
  ["wait", "while the stop waits for the checker to exit"],
  ["first-listing", "during the stop's first ps listing"],
  ["kill-listing", "during the ps listing before the stop's SIGKILL"],
]) {
  test(`a signal ${where} is raised after the stop, which still kills a process the checker started that ignores SIGTERM`, () => {
    const dir = fixture();
    const result = spawnSync("python3", ["-B", join(logs, "stop-under-signal.py"), scripts, scenario, dir], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    const [outcome, child, checker] = result.stdout.trim().split("\n");
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(outcome, "SignalTerminated(2)");
      assertProcessStopped(Number(child));
      assertProcessStopped(Number(checker));
    } finally {
      killAll(Number(child), Number(checker));
    }
  });
}

test("an error during the stop's listings still sends the checker SIGTERM and SIGCONT", () => {
  const dir = fixture();
  command(dir, "ps", "exit 1");
  const result = spawnSync("python3", ["-B", join(logs, "stop-after-error.py"), scripts], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  // The warning that ps failed cannot be written to the closed stderr, so the stop raises, after resuming the checker.
  assert.deepEqual(result.stdout.trim().split("\n"), ["raised BrokenPipeError", "-15"]);
});

test("stopping a checker warns when ps cannot list the processes it started", () => {
  const dir = fixture();
  command(dir, "ps", "exit 1");
  const { result, pid } = stopChecker(dir, 'sleep 30 & echo "$!" > "$1"; wait');
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-15");
    includes(result.stderr, "WARN ps cannot list the processes that the checker started; they may still be running");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("stopping a checker gives up on a ps that does not answer, signals the checker and warns", () => {
  const dir = fixture();
  command(dir, "ps", "exec sleep 30");
  const start = Date.now();
  const { result, pid, checker } = stopChecker(dir, 'sleep 30 & echo "$!" > "$1"; wait', ["processes.PS_TIMEOUT = 0.5"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-15");
    includes(result.stderr, "WARN ps cannot list the processes that the checker started; they may still be running");
    assert.ok(Date.now() - start < 5000, `the stop took ${Date.now() - start} ms`);
  } finally {
    killAll(pid, checker);
  }
});

test("stopping a checker stops listing after a bounded number of ps calls and warns", () => {
  const dir = fixture();
  const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  const listings = join(dir, "listings");
  // Each listing names one more child of the checker, as a process that keeps starting others would.
  // The pids are above every system's pid limit, so their signals reach no process.
  command(dir, "ps", [
    `"${realPs}" "$@"`,
    `case "$*" in *ppid*) echo x >> "${listings}"; echo "$((5000000 + $(wc -l < "${listings}"))) $(cat "${join(dir, "sleep.pid.checker")}")" ;; esac`,
  ].join("\n"));
  const { result, pid, checker } = stopChecker(dir, 'sleep 30 & echo "$!" > "$1"; wait', ["processes.MAX_LISTINGS = 5"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-15");
    includes(result.stderr, "WARN the checker kept starting processes through 5 ps listings; processes it started later may still be running");
    assert.equal(readFileSync(listings, "utf8").split("\n").filter(Boolean).length, 5);
  } finally {
    killAll(pid, checker);
  }
});

test("stopping a checker leaves behind a ps that does not die after its timeout, signals the checker and warns", () => {
  const dir = fixture();
  const stuck = join(dir, "stuck");
  command(dir, "ps", `echo "$$" >> "${stuck}"\nexec sleep 30`);
  const start = Date.now();
  // No stand-in can survive SIGKILL, so the runner's kill of ps does nothing, as for a ps in uninterruptible sleep.
  const { result, pid, checker } = stopChecker(dir, 'sleep 30 & echo "$!" > "$1"; wait', [
    "processes.PS_TIMEOUT = 0.5",
    "real_kill = subprocess.Popen.kill",
    "subprocess.Popen.kill = lambda self: None if self.args[0] == 'ps' else real_kill(self)",
  ]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-15");
    includes(result.stderr, "WARN ps cannot list the processes that the checker started; they may still be running");
    assert.ok(Date.now() - start < 6000, `the stop took ${Date.now() - start} ms`);
  } finally {
    killAll(pid, checker, ...readFileSync(stuck, "utf8").split("\n").filter(Boolean).map(Number));
  }
});

test("stopping a checker bounds the time that all its ps listings take together", () => {
  const dir = fixture();
  const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  const listings = join(dir, "listings");
  // Under load the time bound can end the first listing before it counts itself.
  writeFileSync(listings, "");
  // Each slow listing names one more child of the checker, so only the time bound ends the listings.
  // The pids are above every system's pid limit, so their signals reach no process.
  command(dir, "ps", [
    `"${realPs}" "$@"`,
    `case "$*" in *ppid*) sleep 0.3; echo x >> "${listings}"; echo "$((5000000 + $(wc -l < "${listings}"))) $(cat "${join(dir, "sleep.pid.checker")}")" ;; esac`,
  ].join("\n"));
  const start = Date.now();
  const { result, pid, checker } = stopChecker(dir, 'sleep 30 & echo "$!" > "$1"; wait', ["processes.PS_TIMEOUT = 1"]);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "-15");
    includes(result.stderr, "WARN ps cannot list the processes that the checker started; they may still be running");
    assert.ok(readFileSync(listings, "utf8").split("\n").filter(Boolean).length <= 4);
    assert.ok(Date.now() - start < 6000, `the stop took ${Date.now() - start} ms`);
  } finally {
    killAll(pid, checker);
  }
});

test("Ctrl-C stops a shell loop that runs the matrix runner", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun hang | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const starts = join(dir, "starts");
  const java = fakeTlc(dir, 'echo start >> "$TASK_STARTS"\nexec sleep 30');
  const result = await new Promise((resolve) => {
    const child = spawn("bash", ["-c", 'for i in 1 2; do bash "$1" "$2"; done', "loop", join(scripts, "tlc-matrix.sh"), join(dir, "One.matrix")], {
      detached: true,
      env: { ...process.env, JAVA: java, TLC_JAR: join(dir, "tools.jar"), TASK_STARTS: starts, FORMAL_MIN_FREE_GIB: "0" },
    });
    const timer = setInterval(() => {
      if (existsSync(starts) && readFileSync(starts, "utf8").endsWith("\n")) {
        clearInterval(timer);
        process.kill(-child.pid, "SIGINT");
      }
    }, 20);
    const guard = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The loop already ended.
      }
    }, 10000);
    child.on("close", (exitCode, signalName) => {
      clearInterval(timer);
      clearTimeout(guard);
      resolve({ exitCode, signalName });
    });
  });
  assert.equal(readFileSync(starts, "utf8"), "start\n");
  assert.equal(result.signalName, "SIGINT", JSON.stringify(result));
});

test("SIGTERM, SIGHUP and SIGKILL sent to the runner process group still stop TLC", async () => {
  for (const sig of ["SIGTERM", "SIGHUP", "SIGKILL"]) {
    const dir = fixture();
    writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
    writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun hang | N=1\n");
    writeFileSync(join(dir, "tools.jar"), "user supplied");
    const pidFile = join(dir, "child.pid");
    const java = fakeTlc(dir, 'echo "$$" > "$TASK_PID_FILE"\nexec sleep 30');
    await new Promise((resolve) => {
      const child = spawn("bash", [join(scripts, "tlc-matrix.sh"), join(dir, "One.matrix")], {
        detached: true,
        env: { ...process.env, JAVA: java, TLC_JAR: join(dir, "tools.jar"), TASK_PID_FILE: pidFile, FORMAL_MIN_FREE_GIB: "0" },
      });
      const timer = setInterval(() => {
        if (existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n")) {
          clearInterval(timer);
          process.kill(-child.pid, sig);
        }
      }, 20);
      child.on("close", () => {
        clearInterval(timer);
        resolve();
      });
    });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assertProcessStopped(pid);
  }
});

test("isStopped counts a process that its parent reaps during the check as stopped", () => {
  const dir = fixture();
  const pidFile = join(dir, "sleep.pid");
  const parent = spawn("bash", ["-c", 'sleep 30 & echo "$!" > "$1"; wait', "bash", pidFile], { detached: true, stdio: "ignore" });
  const path = process.env.PATH;
  try {
    assert.ok(waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n")), "expected the sleep pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // Stands in for ps while the process ends: bash reaps it, then ps finds no process, lists nothing and exits 1.
    command(dir, "ps", 'for pid; do :; done\nkill -KILL "$pid"\nwhile kill -0 "$pid" 2>/dev/null; do sleep 0.01; done\nexit 1');
    process.env.PATH = join(dir, "bin") + ":" + path;
    assert.ok(isStopped(pid), `expected process ${pid} to count as stopped`);
  } finally {
    process.env.PATH = path;
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch {
      // bash already ended once sleep did.
    }
  }
});

test("signal_cleanup preserves an already ignored SIGINT", () => {
  const script = [
    "import os, signal, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import processes",
    "signal.signal(signal.SIGINT, signal.SIG_IGN)",
    "with processes.signal_cleanup():",
    "    os.kill(os.getpid(), signal.SIGINT)",
    "print('survived')",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "survived");
});
