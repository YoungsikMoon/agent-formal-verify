// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { excludes, fakeTlc, fixture, includes, logs, removeFixtures, root, run, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

function runPython(code) {
  const result = spawnSync("python3", ["-B", "-c", code], { cwd: root, encoding: "utf8" });
  return result;
}

function callMermaid(logFile, options = {}) {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    `with open(${JSON.stringify(join(logs, logFile))}, encoding="utf-8", newline="") as f:`,
    "    trace = tlc_trace.parse(f)",
    `opts = json.loads(${JSON.stringify(JSON.stringify(options))})`,
    "print(tlc_report.to_mermaid(trace, **opts), end='')",
  ].join("\n");
  return runPython(script);
}

// The report's own script is its last plain <script> element. Find it by index: CodeQL flags a regex over HTML as a tag filter.
function lastInlineScript(html) {
  const start = html.lastIndexOf("<script>");
  assert.ok(start >= 0, "expected inline report script");
  const end = html.indexOf("</script>", start);
  assert.ok(end > start, "expected the inline report script to end");
  return html.slice(start + "<script>".length, end);
}

test("tlc_report.to_mermaid renders invariant trace with state declarations, transitions, and fail class", () => {
  const result = callMermaid("tlc-invariant.log", { kind: "fail", title: "One n=4" });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.ok(out.startsWith("stateDiagram-v2\n"), out);
  includes(out, "%% One n=4");
  includes(out, 'state "State 1: Initial predicate | x=0, y=0" as S1');
  includes(out, 'state "State 2: Step | x=1" as S2');
  includes(out, 'state "State 3: Step | x=2, y=1" as S3');
  includes(out, 'state "State 4: Step | x=3" as S4');
  includes(out, "[*] --> S1");
  includes(out, "S1 --> S2 : Step");
  includes(out, "S2 --> S3 : Step");
  includes(out, "S3 --> S4 : Step");
  includes(out, "classDef fail ");
  includes(out, "classDef reach ");
  includes(out, "classDef lasso ");
  includes(out, "class S4 fail");
});

function callMermaidText(rawLog, options = {}) {
  const script = [
    "import json, re, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    `trace = tlc_trace.parse(re.split(r"\\r\\n|\\r|\\n", ${JSON.stringify(rawLog)}))`,
    `opts = json.loads(${JSON.stringify(JSON.stringify(options))})`,
    "print(tlc_report.to_mermaid(trace, **opts), end='')",
  ].join("\n");
  return runPython(script);
}

test("tlc_report.to_mermaid renders liveness lasso with and without action and handles missing lasso target", () => {
  const withAction = callMermaid("tlc-liveness.log", { kind: "fail" });
  assert.equal(withAction.status, 0, withAction.stderr);
  includes(withAction.stdout, "S3 --> S1 : Back to state 1 - Wrap");
  includes(withAction.stdout, "class S1 lasso");
  includes(withAction.stdout, "class S3 fail");

  const withoutActionLog = [
    "Error: Temporal properties were violated.",
    "Error: The following behavior constitutes a counter-example:",
    "State 1: <Init>",
    "/\\ x = 0",
    "State 2: <Step>",
    "/\\ x = 1",
    "Back to state 2",
  ].join("\n");
  const noAction = callMermaidText(withoutActionLog);
  assert.equal(noAction.status, 0, noAction.stderr);
  includes(noAction.stdout, "S2 --> S2 : Back to state 2");
  excludes(noAction.stdout, "Back to state 2 -");
  includes(noAction.stdout, "class S2 lasso");

  const missingTargetScript = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    "trace = tlc_trace.Trace((tlc_trace.Step(1, 'Init', (('x', '0'),), (tlc_trace.VarDiff('x', None, '0'),)),), tlc_trace.Lasso(99, 'Jump'))",
    "print(tlc_report.to_mermaid(trace), end='')",
  ].join("\n");
  const missingTarget = runPython(missingTargetScript);
  assert.equal(missingTarget.status, 0, missingTarget.stderr);
  excludes(missingTarget.stdout, "--> S99");
  includes(missingTarget.stdout, "Back to state 99");
  includes(missingTarget.stdout, "note right of S1");
});

test("tlc_report.to_mermaid renders multi-step and initial-state reach witnesses and sanitizes TLA+ characters", () => {
  const multi = callMermaid("tlc-reach.log", { kind: "witness" });
  assert.equal(multi.status, 0, multi.stderr);
  includes(multi.stdout, "S1 --> S2 : Claim");
  includes(multi.stdout, "class S2 reach");

  const initial = callMermaid("tlc-reach-initial.log", { kind: "witness" });
  assert.equal(initial.status, 0, initial.stderr);
  includes(initial.stdout, "[*] --> S1");
  includes(initial.stdout, "class S1 reach");

  const specialLog = [
    "Error: Invariant Inv is violated.",
    "Error: The behavior up to this point is:",
    "State 1: <Init>",
    '/\\ a = << 1, "two" >>',
    "/\\ b = [k |-> {1, 2}; m: 3]",
    "/\\ c = a --> b\n       more",
  ].join("\n");
  const special = callMermaidText(specialLog, { title: 'Check "x"; a --> b\nline2' });
  assert.equal(special.status, 0, special.stderr);
  includes(special.stdout, "(+1 more)");
  for (const line of special.stdout.split("\n")) {
    if (line.startsWith('state "')) {
      const inner = line.slice(7, line.lastIndexOf('" as S'));
      excludes(inner, '"');
      excludes(inner, ";");
      excludes(inner, "-->");
      excludes(inner, "<");
      excludes(inner, ">");
      excludes(inner, "{");
      excludes(inner, "}");
      excludes(inner, "\n");
    }
    if (line.startsWith("%% ")) {
      excludes(line, "-->");
      excludes(line, ";");
    }
  }
});

function callSvg(logFile, traceId = "trace-0", kind = "fail") {
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    `with open(${JSON.stringify(join(logs, logFile))}, encoding="utf-8", newline="") as f:`,
    "    trace = tlc_trace.parse(f)",
    `print(tlc_report.render_svg(trace, trace_id=${JSON.stringify(traceId)}, kind=${JSON.stringify(kind)}), end='')`,
  ].join("\n");
  return runPython(script);
}

test("tlc_report.render_svg renders clickable state chain, arrow markers, lasso loopback, zero web URLs, and escapes HTML", () => {
  const inv = callSvg("tlc-invariant.log", "trace-0", "fail");
  assert.equal(inv.status, 0, inv.stderr);
  const svg = inv.stdout;
  assert.ok(svg.startsWith("<svg "), svg.slice(0, 80));
  excludes(svg, "http://");
  excludes(svg, "https://");
  includes(svg, "<marker id=\"arrow-trace-0\"");
  for (let i = 0; i < 4; i++) {
    includes(svg, `data-trace-id="trace-0"`);
    includes(svg, `data-step-index="${i}"`);
    includes(svg, `State ${i + 1}`);
  }
  includes(svg, "initial");
  includes(svg, "1 changed");
  includes(svg, "2 changed");
  includes(svg, "trace-node-fail");

  const live = callSvg("tlc-liveness.log", "trace-1", "fail");
  assert.equal(live.status, 0, live.stderr);
  includes(live.stdout, "stroke-dasharray=");
  includes(live.stdout, "Back to state 1");
  includes(live.stdout, "Wrap");

  const reach = callSvg("tlc-reach.log", "trace-2", "witness");
  assert.equal(reach.status, 0, reach.stderr);
  includes(reach.stdout, "trace-node-reach");

  const xssScript = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    "s1 = tlc_trace.Step(1, '<script>alert(1)</script>', (('x', '1'),), (tlc_trace.VarDiff('x', None, '1'),))",
    "s2 = tlc_trace.Step(2, 'Noop', (('x', '1'),), ())",
    "trace = tlc_trace.Trace((s1, s2), tlc_trace.Lasso(1, '<img onerror=alert(1)>'))",
    "print(tlc_report.render_svg(trace, trace_id='t\"<x>', kind='fail'), end='')",
  ].join("\n");
  const xss = runPython(xssScript);
  assert.equal(xss.status, 0, xss.stderr);
  excludes(xss.stdout, "<script>");
  excludes(xss.stdout, "<img");
  includes(xss.stdout, "&lt;script&gt;alert(1)&lt;/script&gt;");
  includes(xss.stdout, "unchanged");
});

test("tlc_report.to_mermaid and render_svg handle duplicate state numbers without collisions and neutralize %%", () => {
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_report, tlc_trace",
    "s1 = tlc_trace.Step(1, 'Init %% start', (('x', '0 %% zero'),), (tlc_trace.VarDiff('x', None, '0 %% zero'),))",
    "s2 = tlc_trace.Step(1, 'Dup %% mid', (('x', '1'),), (tlc_trace.VarDiff('x', '0 %% zero', '1'),))",
    "s3 = tlc_trace.Step(2, 'Next %% end', (('x', '2'),), (tlc_trace.VarDiff('x', '1', '2'),))",
    "trace = tlc_trace.Trace((s1, s2, s3), tlc_trace.Lasso(1, 'Loop %% back'))",
    "print('===MERMAID===')",
    "print(tlc_report.to_mermaid(trace), end='')",
    "print('===SVG===')",
    "print(tlc_report.render_svg(trace, trace_id='dup', kind='fail'), end='')",
  ].join("\n");
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr);
  const [, mermaidPart, svgPart] = result.stdout.split(/===(?:MERMAID|SVG)===\n/);

  assert.equal((mermaidPart.match(/ as S1\b/g) || []).length, 1);
  includes(mermaidPart, 'state "State 1: Init % % start | x=0 % % zero" as S1');
  includes(mermaidPart, 'state "State 1: Dup % % mid | x=1" as S2');
  includes(mermaidPart, 'state "State 2: Next % % end | x=2" as S3');
  includes(mermaidPart, "[*] --> S1");
  includes(mermaidPart, "S1 --> S2 : Dup % % mid");
  includes(mermaidPart, "S2 --> S3 : Next % % end");
  includes(mermaidPart, "S3 --> S1 : Back to state 1 - Loop % % back");
  includes(mermaidPart, "class S3 fail");
  includes(mermaidPart, "class S1 lasso");
  excludes(mermaidPart, "S1 --> S1");
  excludes(mermaidPart, "class S2 lasso");
  for (const line of mermaidPart.split("\n")) {
    if (!line.startsWith("%% ")) {
      excludes(line, "%%");
    }
  }

  const node0 = svgPart.match(/<g class="([^"]*)"[^>]*data-step-index="0"/);
  const node1 = svgPart.match(/<g class="([^"]*)"[^>]*data-step-index="1"/);
  assert.ok(node0 && node0[1].includes("trace-node-lasso"), svgPart);
  assert.ok(node1 && !node1[1].includes("trace-node-lasso"), svgPart);
  includes(svgPart, 'd="M 264 242 C 320 242, 320 50, 268 50"');
});

test("tlc_report.render_html builds self-contained XSS-safe report with table, SVG, JSON payload, diff, and Mermaid copy", () => {
  const payload = "</script><img src=x onerror=alert(1)><!-- -->\u2028\u2029";
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc, tlc_report, tlc_trace",
    `xss = ${JSON.stringify(payload)}`,
    "fail_trace = tlc_trace.Trace((",
    "  tlc_trace.Step(1, 'Initial predicate', (('x', '0'), ('msg', xss)), (tlc_trace.VarDiff('x', None, '0'), tlc_trace.VarDiff('msg', None, xss))),",
    "  tlc_trace.Step(2, 'Next', (('x', '1'), ('msg', xss + '\\nline2')), (tlc_trace.VarDiff('x', '0', '1'), tlc_trace.VarDiff('msg', xss, xss + '\\nline2'))),",
    "), tlc_trace.Lasso(1, 'Wrap'))",
    "reach_trace = tlc_trace.Trace((tlc_trace.Step(1, 'Initial predicate', (('x', '0'),), (tlc_trace.VarDiff('x', None, '0'),)),))",
    "results = [",
    "  tlc.Result(tlc.Outcome.PASS, 'One', 'ok', detail='4 distinct states found', states=4, constants='N=1', checks=('INVARIANTS Small',), duration_s=0.25),",
    "  tlc.Result(tlc.Outcome.FAIL, 'One', 'bad', detail='Error: Invariant Small is violated.', constants='N=2', checks=('INVARIANTS Small',), duration_s=1.5, trace=fail_trace),",
    "  tlc.Result(tlc.Outcome.FAIL, 'One', 'no-trace', detail='TLC crashed', lines=('line A', 'line B'), constants='N=3', checks=('INVARIANTS Small',), duration_s=0.1),",
    "  tlc.Result(tlc.Outcome.WITNESS, 'One', 'wit', operator='Full', detail='1 states (0 transitions)', constants='N=1', duration_s=0.05, trace=reach_trace),",
    "  tlc.Result(tlc.Outcome.MALFORMED, detail='unknown directive: oops'),",
    "]",
    "html_doc = tlc_report.render_html('checks.matrix', results, 'SUMMARY 1 of 3 runs passed, 1 of 1 reach checks passed, 4 distinct states in total', only='n=', generated_at='2026-11-26T00:00:00Z')",
    "print(html_doc, end='')",
  ].join("\n");
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr);
  const doc = result.stdout;
  assert.ok(doc.startsWith("<!DOCTYPE html>"), doc.slice(0, 60));
  excludes(doc, "http://");
  excludes(doc, "https://");
  excludes(doc, "eval(");
  excludes(doc, "<img src=x");
  excludes(doc, "</script><img");
  includes(doc, "checks.matrix");
  includes(doc, "n=");
  includes(doc, "2026-11-26T00:00:00Z");
  includes(doc, "1.90s");
  includes(doc, "reach Full wit");
  includes(doc, 'href="#trace-1"');
  includes(doc, 'href="#trace-3"');
  includes(doc, "line A");
  includes(doc, "Full State Snapshot");
  includes(doc, "Copy Mermaid");
  includes(doc, "Prev");
  includes(doc, "Next");
  includes(doc, "Back to state 1");

  const match = doc.match(/<script type="application\/json" id="trace-data-1">([\s\S]*?)<\/script>/);
  assert.ok(match, "missing embedded JSON script for trace 1");
  excludes(match[1], "<");
  excludes(match[1], ">");
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].values[1][1], payload);
  assert.equal(parsed.steps[1].changed[1].new, `${payload}\nline2`);
  assert.deepEqual(parsed.lasso, { target: 1, action: "Wrap" });
});

test("tlc_report.render_html handles all-PASS matrix with zero traces and write_html writes atomically", () => {
  const dir = fixture();
  const outFile = join(dir, "report.html");
  const script = [
    "from pathlib import Path",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc, tlc_report",
    "results = [tlc.Result(tlc.Outcome.PASS, 'One', 'ok', detail='4 distinct states found', states=4, constants='N=1', duration_s=0.1)]",
    `written = tlc_report.write_html(Path(${JSON.stringify(outFile)}), 'ok.matrix', results, 'SUMMARY 1 of 1 runs passed, 4 distinct states in total')`,
    "print(str(written))",
  ].join("\n");
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), outFile);
  const doc = readFileSync(outFile, "utf8");
  includes(doc, "ok.matrix");
  includes(doc, "PASS");
  includes(doc, "no counter-example or witness traces");
  excludes(doc, 'class="trace-card"');
});

test("tlc-matrix.sh writes HTML report for mixed PASS, FAIL, and reach WITNESS without changing stdout or exit code", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  writeFileSync(join(dir, "checks.matrix"), [
    "spec One.tla",
    "check INVARIANTS Small",
    "reach Full | ok",
    "run ok | N=1",
    "run inv | N=2",
    "run live | N=3",
  ].join("\n") + "\n");
  const java = fakeTlc(dir, [
    'for last; do :; done',
    'cfg="$(dirname "$last")/MC.cfg"',
    'if grep -q "^INVARIANT Reach" "$cfg"; then',
    '  name=$(sed -n "s/^INVARIANT //p" "$cfg")',
    `  sed "s/ReachNegated/$name/g" ${JSON.stringify(join(logs, "tlc-reach.log"))}`,
    '  exit 12',
    'elif grep -q "N = 1" "$cfg"; then',
    '  echo "Model checking completed. No error has been found."',
    '  echo "4 distinct states found"',
    'elif grep -q "N = 2" "$cfg"; then',
    `  cat ${JSON.stringify(join(logs, "tlc-invariant.log"))}`,
    '  exit 12',
    'else',
    `  cat ${JSON.stringify(join(logs, "tlc-liveness.log"))}`,
    '  exit 12',
    'fi',
  ].join("\n"));

  const without = run(dir, "tlc-matrix.sh", [join(dir, "checks.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
  });
  const reportPath = join(dir, "report.html");
  const withReport = run(dir, "tlc-matrix.sh", [join(dir, "checks.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: reportPath,
  });

  assert.equal(without.status, 1);
  assert.equal(withReport.status, without.status);
  assert.equal(withReport.stdout, without.stdout);
  assert.ok(existsSync(reportPath), "expected HTML report file to be created");
  const html = readFileSync(reportPath, "utf8");
  includes(html, "checks.matrix");
  includes(html, "<td>One</td><td>ok</td>");
  includes(html, "4 distinct states found");
  includes(html, "Error: Invariant Small is violated.");
  includes(html, "Back to state 1");
  includes(html, "reach Full ok");
  includes(html, "WITNESS");
  excludes(html, "http://");
  excludes(html, "https://");
});

test("tlc-matrix.sh rejects invalid TLC_HTML_REPORT paths upfront without invoking TLC", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo started >> "$TASK_TRACE"');
  const existingDir = join(dir, "existing-dir");
  mkdirSync(existingDir);

  for (const badPath of [join(dir, "missing", "report.html"), existingDir]) {
    const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
      JAVA: java,
      TLC_JAR: join(dir, "tools.jar"),
      TLC_HTML_REPORT: badPath,
    });
    assert.equal(res.status, 1, badPath);
    includes(res.stdout, "FAIL TLC_HTML_REPORT");
    assert.equal(existsSync(join(dir, "calls")), false);
  }

  if (process.getuid && process.getuid() !== 0) {
    const roDir = join(dir, "readonly");
    mkdirSync(roDir);
    chmodSync(roDir, 0o555);
    try {
      const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
        JAVA: java,
        TLC_JAR: join(dir, "tools.jar"),
        TLC_HTML_REPORT: join(roDir, "report.html"),
      });
      assert.equal(res.status, 1);
      includes(res.stdout, "FAIL TLC_HTML_REPORT");
      assert.equal(existsSync(join(dir, "calls")), false);
    } finally {
      chmodSync(roDir, 0o755);
    }
  }
});

test("empty or whitespace TLC_HTML_REPORT and tlc.py ready do not write reports", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo "Model checking completed. No error has been found."; echo "4 distinct states found"');

  for (const envVal of ["", "   \t  "]) {
    const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
      JAVA: java,
      TLC_JAR: join(dir, "tools.jar"),
      TLC_HTML_REPORT: envVal,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  }
  const readyReport = join(dir, "ready-report.html");
  const ready = run(dir, "tlc.py", ["ready"], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: readyReport,
  });
  assert.equal(ready.status, 0, ready.stdout + ready.stderr);
  assert.equal(existsSync(readyReport), false);
});

test("mutate.py with TLC_HTML_REPORT set does not create or overwrite the report file", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x' = x + 1\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\ncheck INVARIANTS Small\nrun n=4 | N=4\n");
  writeFileSync(join(dir, "One.mutations"), "mutation skip\ndetects Small\n- x' = x + 1\n+ x' = x + 2 \\* BUG\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, [
    'for last; do :; done',
    `if grep -q BUG "$last"; then cat ${JSON.stringify(join(logs, "tlc-invariant.log"))}; exit 12; fi`,
    'echo "Model checking completed. No error has been found."',
  ].join("\n"));

  const absentReport = join(dir, "should-not-exist.html");
  const res1 = run(dir, "mutate.py", [join(dir, "One.mutations")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: absentReport,
  });
  assert.equal(res1.status, 0, res1.stdout + res1.stderr);
  assert.equal(existsSync(absentReport), false);

  const existingReport = join(dir, "keep-me.html");
  writeFileSync(existingReport, "sentinel");
  const res2 = run(dir, "mutate.py", [join(dir, "One.mutations")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: existingReport,
  });
  assert.equal(res2.status, 0, res2.stdout + res2.stderr);
  assert.equal(readFileSync(existingReport, "utf8"), "sentinel");
});

test("tlc-matrix.sh rejects trailing slash TLC_HTML_REPORT without creating or modifying target", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo started >> "$TASK_TRACE"');

  const missingOut = join(dir, "out-missing");
  const resMissing = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: `${missingOut}/`,
  });
  assert.equal(resMissing.status, 1, resMissing.stdout + resMissing.stderr);
  includes(resMissing.stdout, "FAIL TLC_HTML_REPORT");
  assert.equal(existsSync(missingOut), false);
  assert.equal(existsSync(join(dir, "calls")), false);

  const existingOut = join(dir, "out-existing");
  writeFileSync(existingOut, "keep-sentinel");
  const resExisting = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: `${existingOut}/`,
  });
  assert.equal(resExisting.status, 1, resExisting.stdout + resExisting.stderr);
  includes(resExisting.stdout, "FAIL TLC_HTML_REPORT");
  assert.equal(readFileSync(existingOut, "utf8"), "keep-sentinel");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("tlc-matrix.sh rejects dot and parent-dot TLC_HTML_REPORT paths without modifying target or calling TLC", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo started >> "$TASK_TRACE"; echo "Model checking completed. No error has been found."');
  const existingFile = join(dir, "existing.txt");
  writeFileSync(existingFile, "keep-existing");

  for (const badPath of [`${existingFile}/.`, ".", "..", `${dir}/missing/..`]) {
    const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
      JAVA: java,
      TLC_JAR: join(dir, "tools.jar"),
      TLC_HTML_REPORT: badPath,
    });
    assert.equal(res.status, 1, `${badPath}: ${res.stdout}${res.stderr}`);
    includes(res.stdout, "FAIL TLC_HTML_REPORT");
    includes(res.stdout, "is a directory");
    assert.equal(readFileSync(existingFile, "utf8"), "keep-existing");
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});

test("tlc-matrix.sh rejects overlong filename and 0o000 parent directory without traceback or TLC call", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo started >> "$TASK_TRACE"');

  const overlong = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: join(dir, "a".repeat(300)),
  });
  assert.equal(overlong.status, 1, overlong.stdout + overlong.stderr);
  includes(overlong.stdout, "FAIL TLC_HTML_REPORT");
  excludes(overlong.stderr, "Traceback");
  assert.equal(existsSync(join(dir, "calls")), false);

  if (process.getuid && process.getuid() !== 0) {
    const lockedDir = join(dir, "locked");
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o000);
    try {
      const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
        JAVA: java,
        TLC_JAR: join(dir, "tools.jar"),
        TLC_HTML_REPORT: join(lockedDir, "report.html"),
      });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      includes(res.stdout, "FAIL TLC_HTML_REPORT");
      excludes(res.stderr, "Traceback");
      assert.equal(existsSync(join(dir, "calls")), false);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  }
});

test("tlc-matrix.sh rejects non-regular file (FIFO) TLC_HTML_REPORT without invoking TLC", (t) => {
  const dir = fixture();
  const fifoPath = join(dir, "report.fifo");
  const mk = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  if (mk.error || mk.status !== 0) {
    t.skip("mkfifo unavailable");
    return;
  }
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo started >> "$TASK_TRACE"');

  const res = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: fifoPath,
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  includes(res.stdout, "FAIL TLC_HTML_REPORT");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("tlc-matrix.sh with zero-run matrix or non-matching filter exits 1 without creating or overwriting TLC_HTML_REPORT", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "Zero.matrix"), "spec One.tla\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, 'echo "Model checking completed. No error has been found."');

  const absentReport = join(dir, "zero-absent.html");
  const zeroRes = run(dir, "tlc-matrix.sh", [join(dir, "Zero.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: absentReport,
  });
  assert.equal(zeroRes.status, 1, zeroRes.stdout + zeroRes.stderr);
  includes(zeroRes.stdout, "FAIL no run");
  assert.equal(existsSync(absentReport), false);

  const existingReport = join(dir, "filter-keep.html");
  writeFileSync(existingReport, "sentinel");
  const filterRes = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix"), "no-such-label"], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_HTML_REPORT: existingReport,
  });
  assert.equal(filterRes.status, 1, filterRes.stdout + filterRes.stderr);
  includes(filterRes.stdout, "FAIL no run");
  assert.equal(readFileSync(existingReport, "utf8"), "sentinel");
});

test("tlc_report.render_html handles empty Trace(()) without IndexError, trace link, or trace card", () => {
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc, tlc_report, tlc_trace",
    "results = [tlc.Result(tlc.Outcome.FAIL, 'One', 'empty-trace', detail='TLC failed without states', lines=('err line',), trace=tlc_trace.Trace(()))]",
    "print(tlc_report.render_html('empty.matrix', results, 'SUMMARY 0 of 1 runs passed, 0 distinct states in total'), end='')",
  ].join("\n");
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr);
  excludes(result.stdout, 'href="#trace-');
  excludes(result.stdout, 'class="card trace-card"');
  includes(result.stdout, "err line");
  includes(result.stdout, "no counter-example or witness traces");
});

test("tlc_report inline copy-mermaid script falls back to execCommand on clipboard rejection and cleans up textarea", async () => {
  const py = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc, tlc_report, tlc_trace",
    "trace = tlc_trace.Trace((tlc_trace.Step(1, 'Init', (('x', '0'),), (tlc_trace.VarDiff('x', None, '0'),)),))",
    "results = [tlc.Result(tlc.Outcome.FAIL, 'One', 'n=1', detail='err', trace=trace)]",
    "print(tlc_report.render_html('One.matrix', results, 'SUMMARY'), end='')",
  ].join("\n");
  const rendered = runPython(py);
  assert.equal(rendered.status, 0, rendered.stderr);
  const inlineJs = lastInlineScript(rendered.stdout);

  async function triggerCopy(execMode) {
    let clickHandler = null;
    const statusEl = { textContent: "" };
    const btn = {
      dataset: { copyTarget: "mermaid-0" },
      parentElement: { querySelector: (sel) => (sel === ".copy-status" ? statusEl : null) },
      addEventListener: (ev, fn) => {
        if (ev === "click") clickHandler = fn;
      },
    };
    const textareas = [];
    const execCalls = [];
    const doc = {
      body: { appendChild: (el) => { el.appended = true; } },
      querySelectorAll: (sel) => (sel === "button.copy-mermaid" ? [btn] : []),
      getElementById: (id) => (id === "mermaid-0" ? { textContent: "stateDiagram-v2\n" } : null),
      createElement: (tag) => {
        const el = {
          tag,
          value: "",
          appended: false,
          removed: false,
          selected: false,
          select: () => { el.selected = true; },
          remove: () => { el.removed = true; },
        };
        textareas.push(el);
        return el;
      },
      execCommand: (cmd) => {
        execCalls.push(cmd);
        if (execMode === "throw") throw new Error("exec blocked");
        return execMode === "true";
      },
    };
    const nav = { clipboard: { writeText: async () => { throw new Error("denied on file://"); } } };
    vm.runInNewContext(inlineJs, { document: doc, navigator: nav, setTimeout: () => {} });
    assert.ok(clickHandler, "expected click handler on button.copy-mermaid");
    await clickHandler();
    return { status: statusEl.textContent, textareas, execCalls };
  }

  const ok = await triggerCopy("true");
  assert.deepEqual(ok.execCalls, ["copy"]);
  assert.equal(ok.status, "Copied!");
  assert.equal(ok.textareas.length, 1);
  assert.equal(ok.textareas[0].removed, true);

  const denied = await triggerCopy("false");
  assert.deepEqual(denied.execCalls, ["copy"]);
  assert.equal(denied.status, "Copy failed");
  assert.equal(denied.textareas.length, 1);
  assert.equal(denied.textareas[0].removed, true);

  const threw = await triggerCopy("throw");
  assert.deepEqual(threw.execCalls, ["copy"]);
  assert.equal(threw.status, "Copy failed");
  assert.equal(threw.textareas.length, 1);
  assert.equal(threw.textareas[0].removed, true);
});

test("tlc_report inline script renderStep updates counter, header, diff, snapshot, and snapshot-summary across stuttering traces", () => {
  const py = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc, tlc_report, tlc_trace",
    "steps = (",
    "  tlc_trace.Step(1, 'Init', (('x', '0'), ('y', '10')), (tlc_trace.VarDiff('x', None, '0'), tlc_trace.VarDiff('y', None, '10'))),",
    "  tlc_trace.Step(2, 'Inc', (('x', '1'), ('y', '10')), (tlc_trace.VarDiff('x', '0', '1'),)),",
    "  tlc_trace.Step(3, 'Stuttering', (), ()),",
    ")",
    "results = [tlc.Result(tlc.Outcome.FAIL, 'One', 'stutter', detail='err', trace=tlc_trace.Trace(steps))]",
    "print(tlc_report.render_html('One.matrix', results, 'SUMMARY'), end='')",
  ].join("\n");
  const rendered = runPython(py);
  assert.equal(rendered.status, 0, rendered.stderr);
  const htmlDoc = rendered.stdout;
  includes(htmlDoc, 'id="snapshot-summary-0"');
  includes(htmlDoc, "Full State Snapshot (0 variables)");

  const dataMatch = htmlDoc.match(/<script type="application\/json" id="trace-data-0">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, "missing trace-data-0 payload");
  const inlineJs = lastInlineScript(htmlDoc);

  function makeEl(tag = "div") {
    let text = "";
    return {
      tag,
      children: [],
      className: "",
      colSpan: 0,
      appendChild(child) { this.children.push(child); },
      get textContent() { return text; },
      set textContent(v) {
        text = String(v);
        if (text === "") this.children = [];
      },
    };
  }

  const counterEl = makeEl("span");
  counterEl.textContent = "Step 3 / 3";
  const headerEl = makeEl("h4");
  headerEl.textContent = "State 3 — Stuttering";
  const diffBodyEl = makeEl("tbody");
  const snapSummaryEl = makeEl("summary");
  snapSummaryEl.textContent = "Full State Snapshot (0 variables)";
  const snapBodyEl = makeEl("tbody");

  const dataScriptEl = { id: "trace-data-0", textContent: dataMatch[1] };
  const traceNodes = [0, 1, 2].map((i) => {
    const listeners = {};
    const node = {
      dataset: { traceId: "trace-0", stepIndex: String(i) },
      selected: i === 2,
      listeners,
      addEventListener(evName, fn) { listeners[evName] = fn; },
      classList: {
        toggle(cls, force) {
          if (cls === "is-selected") node.selected = Boolean(force);
        },
      },
    };
    return node;
  });
  const buttons = ["prev", "next"].map((action) => {
    const listeners = {};
    return {
      dataset: { action, traceId: "trace-0" },
      listeners,
      addEventListener(evName, fn) { listeners[evName] = fn; },
    };
  });

  const byId = {
    "step-counter-0": counterEl,
    "step-header-0": headerEl,
    "diff-body-0": diffBodyEl,
    "snapshot-summary-0": snapSummaryEl,
    "snapshot-body-0": snapBodyEl,
  };
  const doc = {
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => {
      if (sel === 'script[type="application/json"][id^="trace-data-"]') return [dataScriptEl];
      if (sel === ".trace-node[data-trace-id]" || sel === '.trace-node[data-trace-id="trace-0"]') return traceNodes;
      if (sel === "button[data-action][data-trace-id]") return buttons;
      return [];
    },
  };
  vm.runInNewContext(inlineJs, { document: doc, navigator: {}, setTimeout: () => {} });

  const rowTexts = (tbody) => tbody.children.map((tr) => tr.children.map((td) => (
    td.children.length ? td.children[0].textContent : td.textContent
  )));

  buttons[0].listeners.click();
  assert.equal(counterEl.textContent, "Step 2 / 3");
  assert.equal(headerEl.textContent, "State 2 — Inc");
  assert.equal(snapSummaryEl.textContent, "Full State Snapshot (2 variables)");
  assert.deepEqual(rowTexts(diffBodyEl), [["x", "0", "1"]]);
  assert.deepEqual(rowTexts(snapBodyEl), [["x", "1"], ["y", "10"]]);
  assert.deepEqual(traceNodes.map((n) => n.selected), [false, true, false]);

  traceNodes[0].listeners.click();
  assert.equal(counterEl.textContent, "Step 1 / 3");
  assert.equal(headerEl.textContent, "State 1 — Init");
  assert.equal(snapSummaryEl.textContent, "Full State Snapshot (2 variables)");
  assert.deepEqual(rowTexts(diffBodyEl), [["x", "(initial)", "0"], ["y", "(initial)", "10"]]);
  assert.deepEqual(rowTexts(snapBodyEl), [["x", "0"], ["y", "10"]]);
  assert.deepEqual(traceNodes.map((n) => n.selected), [true, false, false]);

  buttons[1].listeners.click();
  buttons[1].listeners.click();
  assert.equal(counterEl.textContent, "Step 3 / 3");
  assert.equal(headerEl.textContent, "State 3 — Stuttering");
  assert.equal(snapSummaryEl.textContent, "Full State Snapshot (0 variables)");
  assert.deepEqual(rowTexts(diffBodyEl), [["No variable changes in this step."]]);
  assert.deepEqual(rowTexts(snapBodyEl), []);
  assert.deepEqual(traceNodes.map((n) => n.selected), [false, false, true]);
});
