// 存储层: 唯一落库入口 commit(store, batch)。
// - 乐观锁 CAS: put_consultation 携带 expectedVersion, 对不上即冲突(不重试)
// - 写入失败: 回滚到批次前快照, 用完整会诊批次整体重试
// - 幂等: 批次号进 journal, 重复提交直接跳过

import { BatchOp, ChainState, ConsultationBatch } from "./types";

export class WriteFailure extends Error {
  readonly code = "WRITE_FAILURE";
  constructor(message: string) {
    super(message);
    this.name = "WriteFailure";
  }
}

export class Conflict extends Error {
  readonly code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

export interface Store {
  state: ChainState;
  /** 已应用批次号(幂等键) */
  journal: string[];
  /** 故障注入: 接下来 N 次写入必定失败 */
  failNextWrites: number;
}

export interface CommitResult {
  ok: boolean;
  attempts: number;
  note: string;
  conflict?: string;
}

export function createStore(state: ChainState): Store {
  return { state, journal: [], failNextWrites: 0 };
}

function applyOp(state: ChainState, op: BatchOp): void {
  switch (op.op) {
    case "put_slide":
      state.slides[op.value.id] = op.value;
      break;
    case "put_loan":
      state.loans[op.value.id] = op.value;
      break;
    case "put_annotation":
      state.annotations[op.value.id] = op.value;
      break;
    case "put_opinion":
      state.opinions[op.value.id] = op.value;
      break;
    case "put_consultation": {
      const current = state.consultations[op.value.id];
      if (!current) {
        state.consultations[op.value.id] = op.value;
        break;
      }
      if (current.version !== op.expectedVersion) {
        throw new Conflict(
          `会诊 ${op.value.id} 版本冲突: 期望 v${op.expectedVersion}, 实际 v${current.version}(另一份提交已先生效)`,
        );
      }
      state.consultations[op.value.id] = op.value;
      break;
    }
  }
}

/**
 * 提交一个完整会诊批次。
 * 写入失败时整体回滚, 再以同一个完整批次重试 —— 恢复单元是批次, 不是单条写。
 */
export function commit(store: Store, batch: ConsultationBatch, maxAttempts = 5): CommitResult {
  if (store.journal.includes(batch.id)) {
    return { ok: true, attempts: 0, note: `批次 ${batch.id} 已应用, 幂等跳过` };
  }
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    const snapshot = structuredClone(store.state);
    try {
      for (const op of batch.ops) {
        if (store.failNextWrites > 0) {
          store.failNextWrites -= 1;
          throw new WriteFailure(`写入 ${op.op} 时存储故障(剩余注入 ${store.failNextWrites} 次)`);
        }
        applyOp(store.state, op);
      }
      store.journal.push(batch.id);
      return {
        ok: true,
        attempts,
        note: attempts > 1 ? `第 ${attempts} 次尝试成功(前 ${attempts - 1} 次失败已回滚重试)` : "一次写入成功",
      };
    } catch (e) {
      store.state = snapshot; // 回滚, 保证重试时从完整批次重新应用
      if (e instanceof WriteFailure) continue;
      if (e instanceof Conflict) {
        return { ok: false, attempts, note: "并发冲突, 本批次作废", conflict: e.message };
      }
      throw e;
    }
  }
  return { ok: false, attempts, note: `连续 ${maxAttempts} 次写入失败, 批次 ${batch.id} 待人工介入` };
}
