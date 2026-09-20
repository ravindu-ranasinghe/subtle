/**
 * The debug panel, rendered into the caption overlay's shadow root so it
 * inherits the same protection from site CSS.
 *
 * Read-only: it shows what the offscreen document reports and owns no state
 * of its own beyond the last snapshot.
 */

import { STAGES, emptySnapshot, type DebugSnapshot, type StageSummary } from './stats.js';

const STYLE = `
.subtle-debug {
  pointer-events: auto;
  position: fixed;
  top: 12px; right: 12px;
  width: 268px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(12, 14, 18, 0.93);
  color: #e8ecf2;
  border: 1px solid #333a45;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  z-index: 2147483647;
}
.subtle-debug h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; color: #9aa4b2; }
.subtle-debug table { width: 100%; border-collapse: collapse; }
.subtle-debug td { padding: 1px 0; vertical-align: baseline; }
.subtle-debug td.k { color: #9aa4b2; padding-right: 8px; white-space: nowrap; }
.subtle-debug td.v { text-align: right; font-variant-numeric: tabular-nums; }
.subtle-debug .sep { border-top: 1px solid #2a303a; padding-top: 5px; margin-top: 5px; }
.subtle-debug .warn { color: #fbbf24; }
.subtle-debug .bad { color: #f87171; }
.subtle-debug .good { color: #4ade80; }
.subtle-debug .urls { color: #6b7480; word-break: break-all; margin-top: 4px; }
`;

const ms = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}ms`);

export class DebugPanel {
  private readonly root: HTMLElement;
  private snapshot: DebugSnapshot = emptySnapshot();
  private mounted = false;

  constructor(
    private readonly shadow: ShadowRoot,
    private readonly doc: Document = document,
  ) {
    const style = doc.createElement('style');
    style.textContent = STYLE;
    this.root = doc.createElement('div');
    this.root.className = 'subtle-debug';
    shadow.append(style);
  }

  get visible(): boolean {
    return this.mounted;
  }

  show(): void {
    if (this.mounted) return;
    this.shadow.append(this.root);
    this.mounted = true;
    this.render();
  }

  hide(): void {
    this.root.remove();
    this.mounted = false;
  }

  toggle(): boolean {
    if (this.mounted) this.hide();
    else this.show();
    return this.mounted;
  }

  update(snapshot: DebugSnapshot): void {
    this.snapshot = snapshot;
    if (this.mounted) this.render();
  }

  private render(): void {
    const s = this.snapshot;
    const table = this.doc.createElement('table');

    const row = (key: string, value: string, className = ''): void => {
      const tr = this.doc.createElement('tr');
      const k = this.doc.createElement('td');
      k.className = 'k';
      k.textContent = key;
      const v = this.doc.createElement('td');
      v.className = `v ${className}`.trim();
      v.textContent = value;
      tr.append(k, v);
      table.append(tr);
    };

    row('capture', s.capturing ? 'running' : 'stopped', s.capturing ? 'good' : '');
    if (s.contextState) {
      row('audio context', s.contextState, s.contextState === 'running' ? 'good' : 'bad');
      // Splits "the tab is sending nothing" from "we are not playing it back".
      row(
        'input level',
        `${s.inputLevel.toFixed(3)} (${s.channels} track${s.channels === 1 ? '' : 's'})`,
        s.inputLevel > 0.001 ? 'good' : 'warn',
      );
      // If this is live but nothing is audible, the graph is fine and the
      // platform is not playing the offscreen document's output.
      row('output level', s.outputLevel.toFixed(3), s.outputLevel > 0.001 ? 'good' : 'bad');
    }
    const yes = Object.entries(s.env).filter(([, v]) => v).map(([k]) => k);
    row('offscreen can', yes.length > 0 ? yes.join(' ') : '—');
    row('model', s.model);
    row('asr backend', s.backend, s.backend === 'wasm' ? 'warn' : 'good');
    if (s.adapter) row('gpu', s.adapter);
    if (s.translator) row('translator', s.translator);
    if (s.translationModel) row('mt model', s.translationModel.replace(/^.*\//, ''));

    row('rtf', s.rtf === null ? '—' : s.rtf.toFixed(2), (s.rtf ?? 0) > 1 ? 'bad' : 'good');
    row('queue', `${s.queueSeconds.toFixed(1)}s`, s.queueSeconds > 3 ? 'bad' : '');
    if (s.droppedChunks > 0) row('dropped', String(s.droppedChunks), 'bad');

    const header = this.doc.createElement('tr');
    const cell = this.doc.createElement('td');
    cell.colSpan = 2;
    cell.className = 'sep k';
    cell.textContent = 'stage        last   p50   p95';
    header.append(cell);
    table.append(header);

    for (const stage of STAGES) {
      const summary: StageSummary = s.stages[stage];
      if (summary.count === 0) continue;
      row(stage, `${ms(summary.last)}  ${ms(summary.p50)}  ${ms(summary.p95)}`);
    }

    const net = s.network.offscreen + s.network.asr + s.network.mt;
    const netRow = this.doc.createElement('tr');
    const netCell = this.doc.createElement('td');
    netCell.colSpan = 2;
    netCell.className = 'sep k';
    netCell.textContent = 'network since start';
    netRow.append(netCell);
    table.append(netRow);
    row(
      'requests',
      `${net} (os ${s.network.offscreen} asr ${s.network.asr} mt ${s.network.mt})`,
      net === 0 ? 'good' : 'warn',
    );

    const title = this.doc.createElement('h3');
    title.textContent = 'Subtle debug';
    this.root.replaceChildren(title, table);

    if (net > 0) {
      const note = this.doc.createElement('div');
      note.className = 'urls';
      note.textContent = 'expected 0 once weights are cached';
      this.root.append(note);
    }
  }
}
