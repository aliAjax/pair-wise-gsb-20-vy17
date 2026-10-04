// 会诊批次存储：所有写操作都封装为“完整会诊批次”（journal batch），
// 先构建事件（权限 / 规则在此时校验，拒绝不写日志），再整体落库。
// 落库可被注入部分失败：物化状态停在失败点，完整批次保留，回连后从批次恢复重试。

import { useSyncExternalStore } from "react";
import type { AppState, AuditEntry, DomainEvent, JournalBatch, OfflinePacket } from "./types";
import { PermissionError } from "./types";
import { applyEvent, nowIso, uid } from "./logic";
import { buildSeed } from "./seed";

const STORAGE_KEY = "hxwl-path-consult-chain-v1";

export interface BuildResult {
  chainId: string;
  events: DomainEvent[];
  audits?: Array<Omit<AuditEntry, "id" | "at"> & { at?: string }>;
}

type Builder = (draft: AppState) => BuildResult;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function loadInitial(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppState;
  } catch {
    /* ignore */
  }
  return buildSeed();
}

export class ChainStore {
  private state: AppState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = loadInitial();
  }

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* 存储满等情况忽略：内存状态仍一致 */
    }
  }

  reset(): void {
    this.state = buildSeed();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.emit();
  }

  hasPendingBatch(): boolean {
    return this.state.batches.some((b) => b.failed && !b.committed);
  }

  private audit(state: AppState, tone: AuditEntry["tone"], message: string, at = nowIso()): void {
    state.audit = [{ id: uid("aud"), at, tone, message }, ...state.audit].slice(0, 100);
  }

  // 构建并提交一个完整会诊批次；simulateFailAt 表示前 N 条事件落库后故障，
  // 剩余事件在崩溃中“丢失” -> 批次 failed，等待从完整批次恢复。
  execute(label: string, builder: Builder, simulateFailAt?: number): JournalBatch | null {
    if (this.hasPendingBatch()) {
      const next = clone(this.state);
      this.audit(next, "reject", "存在写入失败未恢复的会诊批次，必须先恢复或丢弃，禁止叠加新写入");
      this.state = next;
      this.emit();
      return null;
    }

    let result: BuildResult;
    try {
      result = builder(clone(this.state));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tone = err instanceof PermissionError ? "reject" : "warn";
      const next = clone(this.state);
      this.audit(next, tone, `${label}：${message}`);
      this.state = next;
      this.emit();
      return null;
    }
    if (result.events.length === 0) {
      const next = clone(this.state);
      this.audit(next, "info", `${label}：无变化`);
      for (const a of result.audits ?? []) this.audit(next, a.tone ?? "info", a.message, a.at);
      this.state = next;
      this.emit();
      return null;
    }

    const batch: JournalBatch = {
      id: uid("batch"),
      chainId: result.chainId,
      label,
      at: nowIso(),
      events: result.events,
      committed: false,
      entryCount: 0,
    };

    const next = clone(this.state);
    for (const e of result.events) {
      applyEvent(next, result.chainId, e);
      batch.entryCount += 1;
      if (simulateFailAt !== undefined && batch.entryCount === simulateFailAt) {
        batch.failed = true;
        batch.failReason = `写入在第 ${simulateFailAt}/${result.events.length} 条事件后中断（模拟存储故障）`;
        break;
      }
    }
    next.batches.unshift(batch);
    if (!batch.failed) {
      batch.committed = true;
      this.audit(next, "ok", `${label}：批次 ${batch.id} 提交成功（${result.events.length} 条事件）`);
      for (const a of result.audits ?? []) {
        this.audit(next, a.tone ?? "info", a.message, a.at ?? batch.at);
      }
    } else {
      this.audit(
        next,
        "warn",
        `${label}：${batch.failReason}；物化状态停在第 ${batch.entryCount} 条，完整批次已保留，可从批次恢复重试`
      );
    }
    this.state = next;
    this.emit();
    return batch;
  }

  // 从完整会诊批次恢复：回到批次前基线重放整个批次，
  // 精确补回“只落库了前半段”时丢失的后半段事件。
  recoverBatch(batchId: string): void {
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch || !batch.failed || batch.committed) return;
    const next = this.rebuildBaseline();
    const replay = clone(next);
    for (const e of batch.events) applyEvent(replay, batch.chainId, e);
    const ci = replay.chains.findIndex((c) => c.id === batch.chainId);
    next.chains[ci] = replay.chains[ci];
    replay.slides.forEach((rs) => {
      const si = next.slides.findIndex((s) => s.id === rs.id);
      if (si >= 0) next.slides[si] = rs;
    });
    const target = next.batches.find((b) => b.id === batchId)!;
    target.committed = true;
    target.failed = false;
    target.failReason = undefined;
    target.entryCount = target.events.length;
    target.recoveredAt = nowIso();
    this.audit(
      next,
      "ok",
      `批次「${target.label}」已从完整会诊批次恢复重试：${target.events.length} 条事件全部生效`
    );
    this.state = next;
    this.emit();
  }

  discardFailedBatch(batchId: string): void {
    const batch = this.state.batches.find((b) => b.id === batchId);
    if (!batch || !batch.failed) return;
    const next = this.rebuildBaseline(batchId);
    this.audit(next, "warn", `批次「${batch.label}」已丢弃，物化状态回滚到批次前基线`);
    this.state = next;
    this.emit();
  }

  // 用已提交批次 + 种子数据重建基线（事件溯源），失败/被丢弃批次不参与
  private rebuildBaseline(excludeBatchId?: string): AppState {
    const fresh = buildSeed();
    const committed = [...this.state.batches]
      .filter((b) => b.committed && !b.failed && b.id !== excludeBatchId)
      .reverse(); // batches 为 unshift 存储，按时间正序重放
    for (const b of committed) {
      for (const e of b.events) applyEvent(fresh, b.chainId, e);
    }
    fresh.batches = clone(this.state.batches).filter((b) => b.id !== excludeBatchId);
    fresh.offlineQueue = clone(this.state.offlineQueue);
    fresh.audit = clone(this.state.audit);
    return fresh;
  }

  // ---- 离线标注包 ----

  queueOffline(packet: Omit<OfflinePacket, "id" | "preparedAt">): OfflinePacket {
    const full: OfflinePacket = { ...packet, id: uid("pkt"), preparedAt: nowIso() };
    const next = clone(this.state);
    next.offlineQueue.push(full);
    this.audit(next, "info", `离线标注已暂存（${full.annotations.length} 条视野），回连后按坐标合并`);
    this.state = next;
    this.emit();
    return full;
  }

  // 返回 true 表示批次已提交（调用方可据此移离线包）
  syncPacket(packetId: string, builder: (s: AppState, p: OfflinePacket) => BuildResult): boolean {
    const packet = this.state.offlineQueue.find((p) => p.id === packetId);
    if (!packet) return false;
    const batch = this.execute(`离线标注回连合并（${packet.id}）`, (draft) => builder(draft, packet));
    const ok = batch !== null && !batch.failed;
    if (ok) {
      const next = clone(this.state);
      next.offlineQueue = next.offlineQueue.filter((p) => p.id !== packetId);
      this.state = next;
      this.emit();
    }
    return ok;
  }
}

export const store = new ChainStore();

// React 订阅钩子：批次提交 / 恢复 / 审计写入后驱动重渲染
export function useStore(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
