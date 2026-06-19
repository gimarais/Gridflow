import { useSyncExternalStore } from 'react';
import {
  ColumnDef,
  GridMode,
  GridSnapshot,
  Row,
  RowData,
  TemplateDef,
  WorkItem,
  WorkItemStatus,
  emptyRow,
  emptyWorkItem,
  makeId,
} from '../shared/types';
import { fanOutSubstitute } from '../shared/workflowCore';
import { post } from './vscode';

/**
 * Minimal external store the React tree subscribes to. We use useSyncExternalStore
 * (not a reducer + context) to keep cell renders cheap: a single subscription per
 * component, no provider re-renders for everything on a focus change.
 */

export interface AppState {
  initialized: boolean;
  mode: GridMode;
  canSendToChat: boolean;
  pendingChatInvocation: boolean;
  /** Pro build only: a tamper-evident audit chain is being recorded for this workflow. */
  auditChain: boolean;
  snapshot: GridSnapshot;
  templates: TemplateDef[];
  focusedCell: { rowId: string; colId: string } | null;
  selectedRowIds: string[];
  /** Row whose work-item detail drawer is open (workflow mode only). */
  expandedRowId: string | null;
  /** Active status filter in workflow mode. 'all' means no filter. */
  statusFilter: WorkItemStatus | 'all';
}

const DEFAULT_SNAPSHOT: GridSnapshot = {
  title: 'GridFlow',
  columns: [],
  rows: [],
};

let state: AppState = {
  initialized: false,
  mode: 'standalone',
  canSendToChat: false,
  pendingChatInvocation: false,
  auditChain: false,
  snapshot: DEFAULT_SNAPSHOT,
  templates: [],
  focusedCell: null,
  selectedRowIds: [],
  expandedRowId: null,
  statusFilter: 'all',
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(updater: (prev: AppState) => AppState, pushToHost = true) {
  const next = updater(state);
  if (next === state) return;
  state = next;
  emit();
  if (pushToHost) {
    post({ type: 'updateState', snapshot: state.snapshot });
  }
}

export const store = {
  getState: (): AppState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /* ---------- initialization ---------- */
  init(snapshot: GridSnapshot, mode: GridMode, canSendToChat: boolean, auditChain = false) {
    set(
      () => ({
        ...state,
        initialized: true,
        snapshot,
        mode,
        canSendToChat,
        auditChain,
        statusFilter: 'all',
      }),
      false,
    );
  },

  setSnapshot(snapshot: GridSnapshot, pushToHost = false) {
    set(() => ({ ...state, snapshot }), pushToHost);
  },

  setTemplates(templates: TemplateDef[]) {
    set(() => ({ ...state, templates }), false);
  },

  setPendingChat(pending: boolean) {
    set(() => ({ ...state, pendingChatInvocation: pending }), false);
  },

  /* ---------- focus / selection ---------- */
  focusCell(rowId: string, colId: string) {
    set(() => ({ ...state, focusedCell: { rowId, colId } }), false);
  },

  clearFocus() {
    if (!state.focusedCell) return;
    set(() => ({ ...state, focusedCell: null }), false);
  },

  toggleSelectRow(rowId: string, additive: boolean) {
    set(() => {
      let next: string[];
      if (additive) {
        next = state.selectedRowIds.includes(rowId)
          ? state.selectedRowIds.filter((id) => id !== rowId)
          : [...state.selectedRowIds, rowId];
      } else {
        next = state.selectedRowIds.length === 1 && state.selectedRowIds[0] === rowId ? [] : [rowId];
      }
      return { ...state, selectedRowIds: next };
    }, false);
  },

  clearSelection() {
    set(() => ({ ...state, selectedRowIds: [] }), false);
  },

  /* ---------- work-item detail drawer ---------- */
  expandRow(rowId: string) {
    set(() => ({ ...state, expandedRowId: rowId }), false);
  },

  collapseDetail() {
    if (!state.expandedRowId) return;
    set(() => ({ ...state, expandedRowId: null }), false);
  },

  setStatusFilter(filter: WorkItemStatus | 'all') {
    set(() => ({ ...state, statusFilter: filter }), false);
  },

  /* ---------- row mutations ---------- */
  setCell(rowId: string, colId: string, value: string | number | boolean | null) {
    set((s) => {
      const rows = s.snapshot.rows.map((r) =>
        r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r,
      );
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  addRow(afterRowId?: string) {
    set((s) => {
      const newRow = emptyRow(s.snapshot.columns, s.snapshot.kind ?? 'data');
      if (!afterRowId) {
        return { ...s, snapshot: { ...s.snapshot, rows: [...s.snapshot.rows, newRow] } };
      }
      const idx = s.snapshot.rows.findIndex((r) => r.id === afterRowId);
      const rows = [...s.snapshot.rows];
      rows.splice(idx + 1, 0, newRow);
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  deleteRows(rowIds: string[]) {
    set((s) => {
      const removed = new Set(rowIds);
      // Prune dangling dependsOn references so surviving rows don't wait
      // forever on a row that no longer exists.
      const rows = s.snapshot.rows
        .filter((r) => !removed.has(r.id))
        .map((r) => {
          const deps = r.work?.dependsOn;
          if (!deps?.length || !deps.some((d) => removed.has(d))) return r;
          const kept = deps.filter((d) => !removed.has(d));
          return { ...r, work: { ...r.work!, dependsOn: kept.length ? kept : undefined } };
        });
      return {
        ...s,
        snapshot: { ...s.snapshot, rows },
        selectedRowIds: s.selectedRowIds.filter((id) => !removed.has(id)),
        expandedRowId: s.expandedRowId && removed.has(s.expandedRowId) ? null : s.expandedRowId,
      };
    });
  },

  /**
   * Fan a template row out into one row per list item (the map primitive),
   * substituting {{item}} in cell text and the inputs prompt. New rows inherit
   * the template's agent/model/dependencies but start fresh (no history).
   */
  fanOutRow(templateRowId: string, items: string[]) {
    set((s) => {
      const idx = s.snapshot.rows.findIndex((r) => r.id === templateRowId);
      if (idx < 0) return s;
      const tmpl = s.snapshot.rows[idx];
      const clean = items.map((i) => i.trim()).filter(Boolean);
      if (!clean.length) return s;
      const newRows: Row[] = clean.map((item) => {
        const cells: RowData = {};
        for (const [k, v] of Object.entries(tmpl.cells)) {
          cells[k] = typeof v === 'string' ? fanOutSubstitute(v, item) : v;
        }
        const work: WorkItem = {
          ...emptyWorkItem(),
          assignedAgent: tmpl.work?.assignedAgent,
          model: tmpl.work?.model,
          inputs: tmpl.work?.inputs ? fanOutSubstitute(tmpl.work.inputs, item) : undefined,
          dependsOn: tmpl.work?.dependsOn,
        };
        return { id: makeId('row'), cells, work };
      });
      const rows = [...s.snapshot.rows];
      rows.splice(idx + 1, 0, ...newRows);
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  duplicateRow(rowId: string) {
    set((s) => {
      const idx = s.snapshot.rows.findIndex((r) => r.id === rowId);
      if (idx < 0) return s;
      const orig = s.snapshot.rows[idx];
      const copy: Row = { id: makeId('row'), cells: { ...orig.cells } };
      // A duplicated work item starts fresh — carry intent (agent/inputs), drop the
      // execution trail (history/outputs/usage) so it reads as a new unit of work.
      if (orig.work) {
        copy.work = {
          ...emptyWorkItem(),
          assignedAgent: orig.work.assignedAgent,
          model: orig.work.model,
          inputs: orig.work.inputs,
        };
      }
      const rows = [...s.snapshot.rows];
      rows.splice(idx + 1, 0, copy);
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  /* ---------- work-item mutations (workflow mode) ---------- */
  updateWork(rowId: string, patch: Partial<WorkItem>) {
    set((s) => {
      const rows = s.snapshot.rows.map((r) => {
        if (r.id !== rowId) return r;
        const base = r.work ?? emptyWorkItem();
        return { ...r, work: { ...base, ...patch, updatedAt: new Date().toISOString() } };
      });
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  moveRow(rowId: string, direction: -1 | 1) {
    set((s) => {
      const idx = s.snapshot.rows.findIndex((r) => r.id === rowId);
      if (idx < 0) return s;
      const target = idx + direction;
      if (target < 0 || target >= s.snapshot.rows.length) return s;
      const rows = [...s.snapshot.rows];
      const [item] = rows.splice(idx, 1);
      rows.splice(target, 0, item);
      return { ...s, snapshot: { ...s.snapshot, rows } };
    });
  },

  /* ---------- column mutations ---------- */
  addColumn(after?: string) {
    set((s) => {
      const col: ColumnDef = {
        id: makeId('col'),
        name: `Column ${s.snapshot.columns.length + 1}`,
        type: 'text',
      };
      const cols = [...s.snapshot.columns];
      const idx = after ? cols.findIndex((c) => c.id === after) : cols.length - 1;
      cols.splice(idx + 1, 0, col);
      const rows = s.snapshot.rows.map((r) => ({
        ...r,
        cells: { ...r.cells, [col.id]: '' },
      }));
      return { ...s, snapshot: { ...s.snapshot, columns: cols, rows } };
    });
  },

  renameColumn(colId: string, name: string) {
    set((s) => ({
      ...s,
      snapshot: {
        ...s.snapshot,
        columns: s.snapshot.columns.map((c) => (c.id === colId ? { ...c, name } : c)),
      },
    }));
  },

  setColumnType(colId: string, type: ColumnDef['type'], options?: string[]) {
    set((s) => {
      const cols = s.snapshot.columns.map((c) =>
        c.id === colId ? { ...c, type, options: type === 'select' ? options ?? c.options ?? [] : undefined } : c,
      );
      const rows = s.snapshot.rows.map((r) => {
        const cur = r.cells[colId];
        let next: string | number | boolean | null = cur ?? null;
        if (type === 'boolean') next = !!cur;
        else if (type === 'number') {
          const n = typeof cur === 'number' ? cur : Number(cur);
          next = Number.isFinite(n) ? n : null;
        } else next = cur == null ? '' : String(cur);
        return { ...r, cells: { ...r.cells, [colId]: next } };
      });
      return { ...s, snapshot: { ...s.snapshot, columns: cols, rows } };
    });
  },

  setSelectOptions(colId: string, options: string[]) {
    set((s) => ({
      ...s,
      snapshot: {
        ...s.snapshot,
        columns: s.snapshot.columns.map((c) => (c.id === colId ? { ...c, options } : c)),
      },
    }));
  },

  deleteColumn(colId: string) {
    set((s) => {
      const cols = s.snapshot.columns.filter((c) => c.id !== colId);
      const rows = s.snapshot.rows.map((r) => {
        const cells = { ...r.cells };
        delete cells[colId];
        return { ...r, cells };
      });
      return { ...s, snapshot: { ...s.snapshot, columns: cols, rows } };
    });
  },

  moveColumn(colId: string, direction: -1 | 1) {
    set((s) => {
      const idx = s.snapshot.columns.findIndex((c) => c.id === colId);
      if (idx < 0) return s;
      const target = idx + direction;
      if (target < 0 || target >= s.snapshot.columns.length) return s;
      const cols = [...s.snapshot.columns];
      const [item] = cols.splice(idx, 1);
      cols.splice(target, 0, item);
      return { ...s, snapshot: { ...s.snapshot, columns: cols } };
    });
  },

  resizeColumn(colId: string, width: number) {
    set((s) => ({
      ...s,
      snapshot: {
        ...s.snapshot,
        columns: s.snapshot.columns.map((c) => (c.id === colId ? { ...c, width } : c)),
      },
    }));
  },

  /* ---------- replace from CSV import ---------- */
  replaceFromCsv(columns: ColumnDef[], rows: Row[]) {
    set((s) => ({ ...s, snapshot: { ...s.snapshot, columns, rows } }));
  },

  setTitle(title: string) {
    set((s) => ({ ...s, snapshot: { ...s.snapshot, title } }));
  },

  setInstructions(instructions: string) {
    set((s) => ({ ...s, snapshot: { ...s.snapshot, instructions } }));
  },

  /** Set or clear the workflow spend cap. Passing an empty object clears it. */
  setBudget(budget: { maxTokens?: number; maxCostUsd?: number }) {
    set((s) => {
      const next = { ...budget };
      if (next.maxTokens == null) delete next.maxTokens;
      if (next.maxCostUsd == null) delete next.maxCostUsd;
      const hasBudget = next.maxTokens != null || next.maxCostUsd != null;
      return { ...s, snapshot: { ...s.snapshot, budget: hasBudget ? next : undefined } };
    });
  },
};

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

// Re-export for convenience
export type { ColumnDef, Row, RowData };
