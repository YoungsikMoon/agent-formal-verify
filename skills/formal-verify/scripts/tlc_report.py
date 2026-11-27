# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Render TLC error and reach-witness traces as Mermaid, inline SVG, and self-contained HTML."""
from __future__ import annotations

import dataclasses
import html
import json
import re
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
import runner
import tlc_trace


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


def _flatten(text: str) -> str:
    return " ".join(text.split())


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _sanitize_mermaid(text: str) -> str:
    cleaned = _flatten(text)
    cleaned = cleaned.replace("-->", "→").replace("|->", "↦")
    cleaned = cleaned.replace("<<", "«").replace(">>", "»")
    cleaned = (
        cleaned.replace('"', "'")
        .replace(";", ",")
        .replace("<", "‹")
        .replace(">", "›")
        .replace(":", "=")
        .replace("{", "(")
        .replace("}", ")")
    )
    while "%%" in cleaned:
        cleaned = cleaned.replace("%%", "% %")
    return cleaned


def _mermaid_step_label(step: tlc_trace.Step) -> str:
    action = _sanitize_mermaid(step.action or "Step")
    if not step.changed:
        return f"State {step.number}: {action} | unchanged"
    parts = [f"{_sanitize_mermaid(d.name)}={_truncate(_sanitize_mermaid(d.new), 32)}" for d in step.changed[:2]]
    extra = len(step.changed) - 2
    if extra > 0:
        parts.append(f"(+{extra} more)")
    return f"State {step.number}: {action} | {', '.join(parts)}"


def to_mermaid(trace: tlc_trace.Trace, *, kind: str = "fail", title: str = "") -> str:
    """Render a TLC trace as a Mermaid stateDiagram-v2 string."""
    lines = ["stateDiagram-v2"]
    if title.strip():
        lines.append(f"%% {_sanitize_mermaid(title)}")
    if not trace.steps:
        return "\n".join(lines) + "\n"
    first_by_num: dict[int, int] = {}
    for idx, step in enumerate(trace.steps):
        first_by_num.setdefault(step.number, idx + 1)
        lines.append(f'state "{_mermaid_step_label(step)}" as S{idx + 1}')
    lines.append("[*] --> S1")
    for idx, step in enumerate(trace.steps[1:], start=1):
        action = _sanitize_mermaid(step.action)
        suffix = f" : {action}" if action else ""
        lines.append(f"S{idx} --> S{idx + 1}{suffix}")
    last_node = f"S{len(trace.steps)}"
    target_num = first_by_num.get(trace.lasso.target) if trace.lasso is not None else None
    if trace.lasso is not None:
        lasso_action = _sanitize_mermaid(trace.lasso.action)
        lasso_label = f"Back to state {trace.lasso.target}"
        if lasso_action:
            lasso_label += f" - {lasso_action}"
        if target_num is not None:
            lines.append(f"{last_node} --> S{target_num} : {lasso_label}")
        else:
            lines.append(f"note right of {last_node} : {lasso_label}")
    lines.extend([
        "classDef fail fill:#fef2f2,stroke:#dc2626,color:#991b1b,stroke-width:2px",
        "classDef reach fill:#f0fdf4,stroke:#16a34a,color:#166534,stroke-width:2px",
        "classDef lasso fill:#fffbeb,stroke:#d97706,color:#92400e,stroke-dasharray:5 3",
    ])
    terminal_class = "reach" if kind == "witness" else "fail"
    lines.append(f"class {last_node} {terminal_class}")
    if target_num is not None:
        lines.append(f"class S{target_num} lasso")
    return "\n".join(lines) + "\n"


def _step_badge(idx: int, step: tlc_trace.Step) -> str:
    if idx == 0:
        return "initial"
    if step.changed:
        return f"{len(step.changed)} changed"
    return "unchanged"


def _svg_node(idx: int, step: tlc_trace.Step, y: int, trace_id: str, classes: list[str]) -> str:
    node_x, node_w, node_h = 16, 248, 68
    action = _esc(_truncate(_flatten(step.action or "Step"), 30))
    badge = _esc(_step_badge(idx, step))
    cls_str = _esc(" ".join(classes))
    tid = _esc(trace_id)
    return "\n".join([
        f'  <g class="{cls_str}" data-trace-id="{tid}" data-step-index="{idx}" data-step-number="{step.number}" role="button" tabindex="0">',
        f'    <rect x="{node_x}" y="{y}" width="{node_w}" height="{node_h}" rx="8" ry="8" class="trace-box" />',
        f'    <text x="{node_x + 12}" y="{y + 22}" class="trace-title">State {step.number}</text>',
        f'    <text x="{node_x + node_w - 12}" y="{y + 22}" text-anchor="end" class="trace-badge">{badge}</text>',
        f'    <text x="{node_x + 12}" y="{y + 46}" class="trace-action">{action}</text>',
        "  </g>",
    ])


def _svg_lasso(last_y: int, target_y: int, lasso: tlc_trace.Lasso, safe_id: str) -> str:
    node_right, node_h = 16 + 248, 68
    y1 = last_y + node_h // 2 + (8 if last_y == target_y else 0)
    y2 = target_y + node_h // 2 - (8 if last_y == target_y else 0)
    ctrl_x = node_right + 56
    label_x = node_right + 44
    label_y = (y1 + y2) // 2
    action = _truncate(_flatten(lasso.action), 22) if lasso.action else ""
    parts = [
        (
            f'  <path d="M {node_right} {y1} C {ctrl_x} {y1}, {ctrl_x} {y2}, {node_right + 4} {y2}" '
            f'fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 4" '
            f'marker-end="url(#arrow-lasso-{safe_id})" class="trace-lasso-path" />'
        ),
        f'  <text x="{label_x}" y="{label_y - 4}" class="trace-lasso-label">Back to state {lasso.target}</text>',
    ]
    if action:
        parts.append(f'  <text x="{label_x}" y="{label_y + 12}" class="trace-lasso-action">{_esc(action)}</text>')
    return "\n".join(parts)


def render_svg(trace: tlc_trace.Trace, *, trace_id: str, kind: str = "fail") -> str:
    """Render a vertical interactive HTML5 SVG state chain for a TLC trace (without xmlns)."""
    steps = trace.steps
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "-", trace_id) or "trace"
    node_x, node_w, node_h, gap, pad_y = 16, 248, 68, 28, 16
    index_by_num: dict[int, int] = {}
    for idx, step in enumerate(steps):
        index_by_num.setdefault(step.number, idx)
    lasso_idx = index_by_num.get(trace.lasso.target) if trace.lasso else None
    width = node_x + node_w + (176 if lasso_idx is not None else 16)
    height = pad_y * 2 + max(1, len(steps)) * node_h + max(0, len(steps) - 1) * gap
    parts = [
        (
            f'<svg class="trace-svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            f'role="img" aria-label="{_esc(f"Trace {trace_id} with {len(steps)} states")}">'
        ),
        "  <defs>",
        f'    <marker id="arrow-{safe_id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />',
        "    </marker>",
        f'    <marker id="arrow-lasso-{safe_id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">',
        '      <path d="M 0 1 L 10 5 L 0 9 z" fill="#dc2626" />',
        "    </marker>",
        "  </defs>",
    ]
    cx = node_x + node_w // 2
    for idx in range(len(steps) - 1):
        y1 = pad_y + idx * (node_h + gap) + node_h
        y2 = y1 + gap - 4
        parts.append(f'  <line x1="{cx}" y1="{y1}" x2="{cx}" y2="{y2}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow-{safe_id})" />')
    for idx, step in enumerate(steps):
        y = pad_y + idx * (node_h + gap)
        classes = ["trace-node"]
        if idx == len(steps) - 1:
            classes.append("trace-node-reach" if kind == "witness" else "trace-node-fail")
            classes.append("is-selected")
        if lasso_idx == idx:
            classes.append("trace-node-lasso")
        parts.append(_svg_node(idx, step, y, trace_id, classes))
    if lasso_idx is not None and trace.lasso is not None:
        last_y = pad_y + (len(steps) - 1) * (node_h + gap)
        target_y = pad_y + lasso_idx * (node_h + gap)
        parts.append(_svg_lasso(last_y, target_y, trace.lasso, safe_id))
    parts.append("</svg>")
    return "\n".join(parts)


_STYLE = """
:root { color-scheme: light; --bg: #f8fafc; --card: #ffffff; --border: #cbd5e1; --text: #0f172a; --muted: #475569; --pass: #15803d; --pass-bg: #dcfce7; --fail: #b91c1c; --fail-bg: #fee2e2; --warn: #b45309; --warn-bg: #fef3c7; --accent: #2563eb; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
.page { max-width: 1280px; margin: 0 auto; display: grid; gap: 20px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
.header-top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between; }
.meta { display: flex; flex-wrap: wrap; gap: 16px; color: var(--muted); font-size: 13px; margin-top: 8px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 12px; text-transform: uppercase; }
.badge-pass, .badge-witness { background: var(--pass-bg); color: var(--pass); }
.badge-fail, .badge-missing, .badge-unreached, .badge-incomplete, .badge-no-run, .badge-malformed { background: var(--fail-bg); color: var(--fail); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-weight: 600; color: var(--muted); background: #f1f5f9; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.trace-grid { display: grid; grid-template-columns: minmax(280px, auto) 1fr; gap: 20px; align-items: start; margin-top: 12px; }
@media (max-width: 860px) { .trace-grid { grid-template-columns: 1fr; } }
.trace-nav { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
button { cursor: pointer; padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text); font: inherit; font-size: 13px; }
button:hover { border-color: var(--accent); color: var(--accent); }
.trace-svg { max-width: 100%; height: auto; display: block; }
.trace-node { cursor: pointer; }
.trace-box { fill: #fff; stroke: #94a3b8; stroke-width: 1.5; }
.trace-node-fail .trace-box { fill: #fef2f2; stroke: #dc2626; }
.trace-node-reach .trace-box { fill: #f0fdf4; stroke: #16a34a; }
.trace-node-lasso .trace-box { stroke-dasharray: 5 3; }
.trace-node.is-selected .trace-box { stroke: var(--accent); stroke-width: 3; }
.trace-title { font: 600 13px sans-serif; fill: #0f172a; }
.trace-badge { font: 600 11px sans-serif; fill: #475569; }
.trace-action { font: 12px ui-monospace, monospace; fill: #334155; }
.trace-lasso-label { font: 600 11px sans-serif; fill: #b91c1c; }
.trace-lasso-action { font: 11px ui-monospace, monospace; fill: #7f1d1d; }
.lasso-banner { background: var(--warn-bg); color: var(--warn); padding: 6px 10px; border-radius: 6px; font-size: 13px; margin: 8px 0; }
.mermaid-details { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
.mermaid-actions { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.copy-status { color: var(--pass); font-size: 12px; font-weight: 600; }
.empty-note { color: var(--muted); font-style: italic; }
""".strip()

_SCRIPT = """
(() => {
  const stateByTrace = new Map();
  function renderStep(traceIdx, stepIdx) {
    const data = stateByTrace.get(traceIdx);
    if (!data || !data.steps.length) return;
    const clamped = Math.max(0, Math.min(stepIdx, data.steps.length - 1));
    data.current = clamped;
    const step = data.steps[clamped];
    const counter = document.getElementById("step-counter-" + traceIdx);
    if (counter) counter.textContent = "Step " + (clamped + 1) + " / " + data.steps.length;
    const header = document.getElementById("step-header-" + traceIdx);
    if (header) header.textContent = "State " + step.number + " — " + (step.action || "Step");
    document.querySelectorAll('.trace-node[data-trace-id="trace-' + traceIdx + '"]').forEach((node) => {
      node.classList.toggle("is-selected", Number(node.dataset.stepIndex) === clamped);
    });
    const diffBody = document.getElementById("diff-body-" + traceIdx);
    if (diffBody) {
      diffBody.textContent = "";
      if (!step.changed.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 3;
        td.className = "empty-note";
        td.textContent = "No variable changes in this step.";
        tr.appendChild(td);
        diffBody.appendChild(tr);
      } else {
        for (const item of step.changed) {
          const tr = document.createElement("tr");
          for (const val of [item.name, item.old === null ? "(initial)" : item.old, item.new]) {
            const td = document.createElement("td");
            const pre = document.createElement("pre");
            pre.textContent = val;
            td.appendChild(pre);
            tr.appendChild(td);
          }
          diffBody.appendChild(tr);
        }
      }
    }
    const snapSummary = document.getElementById("snapshot-summary-" + traceIdx);
    if (snapSummary) snapSummary.textContent = "Full State Snapshot (" + step.values.length + " variables)";
    const snapBody = document.getElementById("snapshot-body-" + traceIdx);
    if (snapBody) {
      snapBody.textContent = "";
      for (const pair of step.values) {
        const tr = document.createElement("tr");
        for (const val of pair) {
          const td = document.createElement("td");
          const pre = document.createElement("pre");
          pre.textContent = val;
          td.appendChild(pre);
          tr.appendChild(td);
        }
        snapBody.appendChild(tr);
      }
    }
  }
  document.querySelectorAll('script[type="application/json"][id^="trace-data-"]').forEach((el) => {
    const idx = el.id.slice("trace-data-".length);
    const parsed = JSON.parse(el.textContent);
    stateByTrace.set(idx, { steps: parsed.steps || [], current: Math.max(0, (parsed.steps || []).length - 1) });
  });
  document.querySelectorAll(".trace-node[data-trace-id]").forEach((node) => {
    const select = () => renderStep(node.dataset.traceId.replace(/^trace-/, ""), Number(node.dataset.stepIndex));
    node.addEventListener("click", select);
    node.addEventListener("keydown", (ev) => {
      if (["Enter", "NumpadEnter", "Space"].includes(ev.code)) { ev.preventDefault(); select(); }
    });
  });
  document.querySelectorAll("button[data-action][data-trace-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.traceId.replace(/^trace-/, "");
      const data = stateByTrace.get(idx);
      if (!data) return;
      renderStep(idx, data.current + (btn.dataset.action === "prev" ? -1 : 1));
    });
  });
  document.querySelectorAll("button.copy-mermaid").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = document.getElementById(btn.dataset.copyTarget);
      const status = btn.parentElement && btn.parentElement.querySelector(".copy-status");
      if (!code) return;
      const text = code.textContent || "";
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        const ta = document.createElement("textarea");
        try {
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          copied = Boolean(document.execCommand && document.execCommand("copy"));
        } catch {
          copied = false;
        } finally {
          ta.remove();
        }
      }
      if (copied) {
        if (status) { status.textContent = "Copied!"; setTimeout(() => { status.textContent = ""; }, 1500); }
      } else if (status) {
        status.textContent = "Copy failed";
      }
    });
  });
})();
""".strip()


def _safe_json(payload: object) -> str:
    raw = json.dumps(payload, ensure_ascii=False)
    return (
        raw.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def _result_type(result: object) -> str:
    if result.outcome.value == "malformed":
        return "error"
    return "reach" if result.operator else "run"


def _result_label(result: object) -> str:
    if result.operator:
        return f"reach {result.operator} {result.label}".strip()
    return result.label or "-"


def _table_row(idx: int, result: object) -> str:
    outcome_val = result.outcome.value
    badge_cls = f"badge-{outcome_val.replace(' ', '-')}"
    checks = ", ".join(result.checks) if result.checks else "-"
    if result.trace is not None and bool(result.trace.steps):
        ref = f'<a href="#trace-{idx}">View trace ({len(result.trace.steps)})</a>'
    elif result.lines:
        joined = _esc("\n".join(result.lines))
        ref = f"<details><summary>Output ({len(result.lines)} lines)</summary><pre>{joined}</pre></details>"
    else:
        ref = "-"
    cells = [
        _esc(_result_type(result)),
        _esc(result.name or "-"),
        _esc(_result_label(result)),
        f"<code>{_esc(result.constants or '-')}</code>",
        _esc(checks),
        f'<span class="badge {badge_cls}">{_esc(outcome_val.upper())}</span>',
        _esc(result.detail or "-"),
        f"{result.duration_s:.2f}s",
        ref,
    ]
    return "<tr>" + "".join(f"<td>{cell}</td>" for cell in cells) + "</tr>"


def _diff_rows(step: tlc_trace.Step) -> str:
    if not step.changed:
        return '<tr><td colspan="3" class="empty-note">No variable changes in this step.</td></tr>'
    rows = []
    for diff in step.changed:
        before = "(initial)" if diff.old is None else diff.old
        rows.append(f"<tr><td><pre>{_esc(diff.name)}</pre></td><td><pre>{_esc(before)}</pre></td><td><pre>{_esc(diff.new)}</pre></td></tr>")
    return "".join(rows)


def _snapshot_rows(step: tlc_trace.Step) -> str:
    return "".join(f"<tr><td><pre>{_esc(name)}</pre></td><td><pre>{_esc(val)}</pre></td></tr>" for name, val in step.values)


def _trace_card(idx: int, result: object) -> str:
    trace = result.trace
    kind = "witness" if result.outcome.value == "witness" else "fail"
    title = f"{result.name} {_result_label(result)}".strip()
    last_idx = len(trace.steps) - 1
    last_step = trace.steps[last_idx]
    badge_cls = f"badge-{result.outcome.value.replace(' ', '-')}"
    lasso_html = ""
    if trace.lasso is not None:
        lasso_text = f"Loop back to state {trace.lasso.target}" + (f" ({trace.lasso.action})" if trace.lasso.action else "")
        lasso_html = f'<div class="lasso-banner">{_esc(lasso_text)}</div>'
    mermaid_text = to_mermaid(trace, kind=kind, title=title)
    svg_html = render_svg(trace, trace_id=f"trace-{idx}", kind=kind)
    return "\n".join([
        f'<article class="card trace-card" id="trace-{idx}">',
        '  <div class="header-top">',
        f'    <h3>{_esc(title)}</h3>',
        f'    <span class="badge {badge_cls}">{_esc(result.outcome.value.upper())}</span>',
        "  </div>",
        f'  <p>{_esc(result.detail)}</p>',
        '  <div class="trace-grid">',
        '    <div class="trace-left">',
        svg_html,
        '      <div class="trace-nav">',
        f'        <button type="button" data-action="prev" data-trace-id="trace-{idx}">Prev</button>',
        f'        <span id="step-counter-{idx}">Step {last_idx + 1} / {len(trace.steps)}</span>',
        f'        <button type="button" data-action="next" data-trace-id="trace-{idx}">Next</button>',
        "      </div>",
        "    </div>",
        f'    <div class="trace-right" id="trace-panel-{idx}">',
        f'      <h4 id="step-header-{idx}">State {last_step.number} — {_esc(last_step.action or "Step")}</h4>',
        lasso_html,
        "      <table><thead><tr><th>Variable</th><th>Before</th><th>After</th></tr></thead>",
        f'      <tbody id="diff-body-{idx}">{_diff_rows(last_step)}</tbody></table>',
        f'      <details style="margin-top:12px"><summary id="snapshot-summary-{idx}">Full State Snapshot ({len(last_step.values)} variables)</summary>',
        '        <table><thead><tr><th>Variable</th><th>Value</th></tr></thead>',
        f'        <tbody id="snapshot-body-{idx}">{_snapshot_rows(last_step)}</tbody></table>',
        "      </details>",
        "    </div>",
        "  </div>",
        '  <details class="mermaid-details">',
        "    <summary>Mermaid stateDiagram-v2</summary>",
        '    <div class="mermaid-actions">',
        f'      <button type="button" class="copy-mermaid" data-copy-target="mermaid-{idx}">Copy Mermaid</button>',
        '      <span class="copy-status" aria-live="polite"></span>',
        "    </div>",
        f'    <pre><code id="mermaid-{idx}">{_esc(mermaid_text)}</code></pre>',
        "  </details>",
        f'  <script type="application/json" id="trace-data-{idx}">{_safe_json(dataclasses.asdict(trace))}</script>',
        "</article>",
    ])


def render_html(matrix_name: str, results: list, summary: str, *, only: str = "", generated_at: str | None = None) -> str:
    """Render a complete, self-contained HTML5 report for a TLC matrix run."""
    timestamp = generated_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    has_failure = (not results) or any(r.outcome.value not in ("pass", "witness") for r in results)
    overall = "FAIL" if has_failure else "PASS"
    overall_cls = "badge-fail" if has_failure else "badge-pass"
    total_s = sum(r.duration_s for r in results)
    filter_html = f"<span>Filter: <code>{_esc(only)}</code></span>" if only else ""
    rows_html = "\n".join(_table_row(idx, r) for idx, r in enumerate(results))
    trace_cards = [_trace_card(idx, r) for idx, r in enumerate(results) if r.trace is not None and bool(r.trace.steps)]
    traces_html = "\n".join(trace_cards) if trace_cards else '<p class="empty-note">There are no counter-example or witness traces for this run.</p>'
    return "\n".join([
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">',
        f"  <title>TLC Report — {_esc(matrix_name)}</title>",
        f"  <style>{_STYLE}</style>",
        "</head>",
        "<body>",
        '  <main class="page">',
        '    <section class="card">',
        '      <div class="header-top">',
        f"        <h1>TLC Matrix Report: {_esc(matrix_name)}</h1>",
        f'        <span class="badge {overall_cls}">{overall}</span>',
        "      </div>",
        f"      <p>{_esc(summary)}</p>",
        '      <div class="meta">',
        f"        <span>Total duration: <strong>{total_s:.2f}s</strong></span>",
        f"        <span>Generated (UTC): <code>{_esc(timestamp)}</code></span>",
        f"        {filter_html}",
        "      </div>",
        "    </section>",
        '    <section class="card">',
        "      <h2>Matrix Runs</h2>",
        "      <table><thead><tr><th>Type</th><th>Spec</th><th>Label</th><th>Constants</th><th>Checks</th><th>Outcome</th><th>States / Detail</th><th>Duration</th><th>Trace / Output</th></tr></thead>",
        f"      <tbody>{rows_html}</tbody></table>",
        "    </section>",
        '    <section class="card">',
        "      <h2>Interactive Trace Explorer</h2>",
        f"      {traces_html}",
        "    </section>",
        "  </main>",
        f"  <script>{_SCRIPT}</script>",
        "</body>",
        "</html>",
    ])


def write_html(path: Path, matrix_name: str, results: list, summary: str, *, only: str = "") -> Path:
    """Render the HTML report and write it atomically to path."""
    target = Path(path)
    runner.atomic_write(target, render_html(matrix_name, results, summary, only=only))
    return target
