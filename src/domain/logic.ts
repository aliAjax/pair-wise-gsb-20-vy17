// 会诊链业务规则：全部实现为“当前状态 + 命令 -> 事件[]”的纯函数，
// 事件只能追加；任何越权 / 冲突都抛异常，由上层记入审计而不落日志。

import type {
  Actor,
  Annotation,
  AppState,
  Chain,
  Conclusion,
  DomainEvent,
  FovCoord,
  OfflinePacket,
  Slide,
  StainVersion,
} from "./types";
import { ConflictError, PermissionError, RuleError } from "./types";

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function coordKey(c: FovCoord): string {
  return `${c.slideId}@${c.x},${c.y}/${c.mag}x`;
}

export function fovLabel(c: FovCoord): string {
  return c.label ?? coordKey(c);
}

export function getActor(state: AppState, actorId: string): Actor {
  const a = state.actors.find((x) => x.id === actorId);
  if (!a) throw new RuleError(`未知操作者：${actorId}`);
  return a;
}

export function getChain(state: AppState, chainId: string): Chain {
  const c = state.chains.find((x) => x.id === chainId);
  if (!c) throw new RuleError(`会诊链不存在：${chainId}`);
  return c;
}

export function getSlide(state: AppState, slideId: string): Slide {
  const s = state.slides.find((x) => x.id === slideId);
  if (!s) throw new RuleError(`玻片不存在：${slideId}`);
  return s;
}

export function currentVersion(slide: Slide): StainVersion {
  const v = slide.versions[slide.versions.length - 1];
  if (!v) throw new RuleError(`玻片 ${slide.id} 没有任何染色版本`);
  return v;
}

export function frozenVersion(chain: Chain, slide: Slide): StainVersion {
  const id = chain.loan?.frozenVersionId;
  if (!id) throw new RuleError("旧会诊缺少玻片版本，需按借片日期回填后再操作");
  const v = slide.versions.find((x) => x.id === id);
  if (!v) throw new RuleError(`冻结版本 ${id} 在玻片 ${slide.id} 上已找不到`);
  return v;
}

// 当前应当依据的版本：借出在外用冻结版，回到本院用最新版
export function effectiveVersion(state: AppState, chain: Chain): StainVersion {
  const slide = getSlide(state, chain.slideId);
  return chain.stage === "loaned" ? frozenVersion(chain, slide) : currentVersion(slide);
}

export function draftConclusions(chain: Chain, versionId?: string): Conclusion[] {
  return chain.conclusions.filter(
    (c) => c.state === "draft" && (!versionId || c.versionId === versionId)
  );
}

function requireHome(actor: Actor, action: string): void {
  if (actor.kind === "external") {
    throw new PermissionError(`越权：${action}属本院记录，外院身份已被拒绝`);
  }
}

// ---- 事件归约：把事件追加到物化状态上 ----

function upsertConclusionFromAnnotation(chain: Chain, a: Annotation): void {
  const ck = coordKey(a.coord);
  // 只并入“同坐标、同结论文本、同版本、仍有效”的结论；
  // 已失效的旧结论绝不允许被新标注“复活”；同坐标但文本不同则并存两版。
  const existing = chain.conclusions.find(
    (c) =>
      c.coordKey === ck &&
      c.text === a.text &&
      c.versionId === a.versionId &&
      c.state !== "invalidated"
  );
  if (existing) {
    if (!existing.authorIds.includes(a.authorId)) {
      existing.authorIds.push(a.authorId);
      existing.authorNames.push(a.authorName);
    }
    existing.updatedAt = a.at;
    return;
  }
  chain.conclusions.push({
    id: uid("con"),
    coordKey: ck,
    coord: a.coord,
    text: a.text,
    authorIds: [a.authorId],
    authorNames: [a.authorName],
    versionId: a.versionId,
    batchNo: a.batchNo,
    state: "draft",
    createdAt: a.at,
    updatedAt: a.at,
  });
}

export function applyEvent(state: AppState, chainId: string, e: DomainEvent): void {
  const chain = getChain(state, chainId);
  switch (e.type) {
    case "LoanCreated":
      chain.loan = e.loan;
      chain.stage = "loaned";
      break;
    case "AnnotationAdded":
      chain.annotations.push(e.annotation);
      upsertConclusionFromAnnotation(chain, e.annotation);
      break;
    case "ConclusionsInvalidated":
      for (const c of chain.conclusions) {
        if (e.conclusionIds.includes(c.id) && c.state === "draft") {
          c.state = "invalidated";
          c.invalidateReason = e.reason;
          c.invalidatedAt = e.at;
        }
      }
      break;
    case "SlideReturned":
      chain.stage = "returned";
      if (chain.loan) chain.loan.returnedAt = e.at;
      break;
    case "StainVersionChanged": {
      const slide = getSlide(state, chain.slideId);
      if (!slide.versions.some((v) => v.id === e.newVersionId)) {
        const last = slide.versions[slide.versions.length - 1];
        slide.versions.push({
          id: e.newVersionId,
          stain: last ? last.stain : "HE",
          batchNo: e.newBatchNo,
          since: e.at,
        });
      }
      chain.stage = "redyed";
      break;
    }
    case "SlideDamaged": {
      const slide = getSlide(state, chain.slideId);
      slide.damaged = true;
      chain.stage = "damaged";
      break;
    }
    case "Issued": {
      const snapKeys = new Set(
        e.issuance.snapshot.conclusions.map((sc) => `${coordKey(sc.coord)}|${sc.text}`)
      );
      for (const c of chain.conclusions) {
        if (c.state === "draft" && snapKeys.has(`${c.coordKey}|${c.text}`)) {
          c.state = "issued";
        }
      }
      chain.issuances.push(e.issuance);
      break;
    }
    case "VersionBackfilled":
      chain.stage = "loaned";
      if (chain.loan) {
        chain.loan.frozenVersionId = e.versionId;
        chain.loan.frozenBatchNo = e.batchNo;
      }
      chain.backfilled = { versionId: e.versionId, batchNo: e.batchNo, at: e.at, source: e.source };
      break;
  }
  chain.updatedAt = e.at;
}

// ---- 命令（纯函数，不修改入参 state；构建期如需看到中间态，由调用方传克隆）----

interface AnnotateInput {
  chainId: string;
  actorId: string;
  coord: FovCoord;
  text: string;
  offline?: boolean;
  at?: string;
}

export function annotate(state: AppState, input: AnnotateInput): DomainEvent[] {
  const actor = getActor(state, input.actorId);
  const chain = getChain(state, input.chainId);
  const slide = getSlide(state, input.coord.slideId);
  if (slide.id !== chain.slideId) throw new RuleError("视野坐标不属于该会诊链的玻片");
  if (!input.text.trim()) throw new RuleError("标注内容为空");

  // 外院：只能在借出冻结期补标注，其余任何本院记录改动一律拒绝
  if (actor.kind === "external" && chain.stage !== "loaned") {
    throw new PermissionError("越权：外院仅可在玻片借出冻结期补标注，已拒绝");
  }
  // 旧会诊缺玻片版本：任何人都不得继续标注，先按借片日期回填（避免挂错到当前新版本）
  if (chain.stage === "legacy") {
    throw new RuleError("旧会诊缺少玻片版本，需先按借片日期回填后再标注");
  }

  const basis = chain.stage === "loaned" ? "frozen" : "current";
  const version = chain.stage === "loaned" ? frozenVersion(chain, slide) : currentVersion(slide);
  const at = input.at ?? nowIso();

  const annotation: Annotation = {
    id: uid("ann"),
    authorId: actor.id,
    authorName: actor.name,
    authorKind: actor.kind,
    coord: { ...input.coord },
    text: input.text.trim(),
    at,
    offline: !!input.offline,
    basis,
    versionId: version.id,
    batchNo: version.batchNo,
  };
  return [{ type: "AnnotationAdded", at, annotation }];
}

// 离线标注回连：按坐标合并；同坐标同文本去重（含本人离线重传）；
// 同坐标不同文本 -> 同一视野保留两版结论。全程只读，不修改入参。
export function buildSyncEvents(
  state: AppState,
  packet: OfflinePacket
): { events: DomainEvent[]; skipped: number } {
  const chain = getChain(state, packet.chainId);
  const actor = getActor(state, packet.authorId);
  if (actor.kind === "external" && chain.stage !== "loaned") {
    throw new PermissionError("越权：玻片已不在借出冻结期，外院离线标注拒绝并入");
  }
  const seen = new Set(
    chain.annotations.map((a) => `${a.authorId}|${coordKey(a.coord)}|${a.text}`)
  );
  const events: DomainEvent[] = [];
  let skipped = 0;
  // 构建事件时让后续条目能看到包内前序条目，用于包内去重
  const probe = structuredClone(state);
  for (const item of packet.annotations) {
    if (item.coord.slideId !== chain.slideId) {
      throw new RuleError("离线包含非本链玻片坐标，整包拒绝");
    }
    const key = `${actor.id}|${coordKey(item.coord)}|${item.text.trim()}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const evts = annotate(probe, {
      chainId: packet.chainId,
      actorId: packet.authorId,
      coord: item.coord,
      text: item.text,
      offline: true,
      at: item.at,
    });
    evts.forEach((e) => applyEvent(probe, packet.chainId, e));
    events.push(...evts);
  }
  return { events, skipped };
}

function invalidateDrafts(chain: Chain, at: string, reason: string): DomainEvent | null {
  const ids = chain.conclusions.filter((c) => c.state === "draft").map((c) => c.id);
  if (ids.length === 0) return null;
  return { type: "ConclusionsInvalidated", at, reason, conclusionIds: ids };
}

export function returnSlide(
  state: AppState,
  chainId: string,
  actorId: string,
  at = nowIso()
): DomainEvent[] {
  requireHome(getActor(state, actorId), "玻片归还登记");
  const chain = getChain(state, chainId);
  if (chain.stage !== "loaned") throw new RuleError("只有借出中的会诊链可以登记归还");
  const events: DomainEvent[] = [];
  const inv = invalidateDrafts(chain, at, "玻片已归还：未签发结论立即失效，需在本院版本上重算");
  if (inv) events.push(inv);
  events.push({ type: "SlideReturned", at });
  return events;
}

export function changeStain(
  state: AppState,
  chainId: string,
  actorId: string,
  at = nowIso()
): DomainEvent[] {
  requireHome(getActor(state, actorId), "重染 / 染色版本变更");
  const chain = getChain(state, chainId);
  const slide = getSlide(state, chain.slideId);
  if (chain.stage !== "returned") {
    throw new RuleError("需先登记玻片归还，才能记录重染 / 染色版本变化");
  }
  const prev = currentVersion(slide);
  const match = /^(.*?-v)(\d+)$/.exec(prev.id);
  const nextNo = match ? Number(match[2]) + 1 : 2;
  const newVersionId = `${match ? match[1] : `${prev.id}-v`}${nextNo}`;
  const newBatchNo = `B${String(Date.now()).slice(-6)}`;
  const events: DomainEvent[] = [];
  events.push({ type: "StainVersionChanged", at, newVersionId, newBatchNo });
  // 事件顺序：版本先变，失效结论携带新版本号上下文
  const probe = structuredClone(state);
  applyEvent(probe, chainId, events[0]);
  const inv = invalidateDrafts(
    probe.chains.find((c) => c.id === chainId)!,
    at,
    `染色版本变化（${prev.id} → ${newVersionId}）：未签发结论立即失效重算`
  );
  if (inv) events.push(inv);
  return events;
}

export function damageSlide(
  state: AppState,
  chainId: string,
  actorId: string,
  reason: string,
  at = nowIso()
): DomainEvent[] {
  requireHome(getActor(state, actorId), "原始玻片损坏登记");
  const chain = getChain(state, chainId);
  const events: DomainEvent[] = [];
  const inv = invalidateDrafts(chain, at, `原始玻片损坏（${reason}）：未签发结论立即失效重算`);
  if (inv) events.push(inv);
  events.push({ type: "SlideDamaged", at, reason });
  return events;
}

function buildIssuance(
  state: AppState,
  chain: Chain,
  expert: Actor,
  at: string
): DomainEvent {
  const version = effectiveVersion(state, chain);
  // 并发判定优先：同版本已有他人生效签发 -> 冲突拒绝
  const live = chain.issuances.find(
    (iss) => !iss.superseded && iss.snapshot.versionId === version.id
  );
  if (live) {
    throw new ConflictError(
      `并发冲突：版本 ${version.id} 已由 ${live.expertName} 签发，本份只允许一份生效`
    );
  }
  const drafts = draftConclusions(chain, version.id);
  if (drafts.length === 0) {
    throw new RuleError("当前版本下没有可签发的有效结论（旧结论已失效，请先重算标注）");
  }
  return {
    type: "Issued",
    at,
    issuance: {
      id: uid("iss"),
      expertId: expert.id,
      expertName: expert.name,
      issuedAt: at,
      diagnosis:
        chain.stage === "damaged"
          ? "原始玻片损坏，依据损坏前标注出具限制性意见"
          : `依据 ${version.id}（批次 ${version.batchNo}）复核，同意当前会诊结论`,
      snapshot: {
        slideId: chain.slideId,
        versionId: version.id,
        batchNo: version.batchNo,
        conclusions: drafts.map((d) => ({
          coordLabel: fovLabel(d.coord),
          coord: d.coord,
          text: d.text,
          authorNames: d.authorNames,
        })),
      },
    },
  };
}

export function issue(
  state: AppState,
  chainId: string,
  expertId: string,
  at = nowIso()
): DomainEvent[] {
  const expert = getActor(state, expertId);
  if (expert.kind !== "home") {
    throw new PermissionError("越权：外院专家不得签发本院会诊意见，已拒绝");
  }
  const chain = getChain(state, chainId);
  return [buildIssuance(state, chain, expert, at)];
}

// 两名专家“同时”提交：同一基线生成、顺序落库——先到者生效，后到者冲突拒绝（仅审计）
export function issueConcurrent(
  state: AppState,
  chainId: string,
  expertIds: [string, string],
  at = nowIso()
): { events: DomainEvent[]; rejectedExpertId?: string; reason?: string } {
  const probe = structuredClone(state);
  const events: DomainEvent[] = [];
  let rejectedExpertId: string | undefined;
  let reason: string | undefined;
  for (const expertId of expertIds) {
    const expert = getActor(probe, expertId);
    if (expert.kind !== "home") {
      throw new PermissionError(`越权：${expert.name} 非本院专家，不得签发`);
    }
    const chain = getChain(probe, chainId);
    try {
      const e = buildIssuance(probe, chain, expert, at);
      applyEvent(probe, chainId, e);
      events.push(e);
    } catch (err) {
      if (err instanceof ConflictError) {
        rejectedExpertId = expertId;
        reason = err.message;
      } else {
        throw err;
      }
    }
  }
  return { events, rejectedExpertId, reason };
}

export function createLoan(
  state: AppState,
  input: { chainId: string; actorId: string; toHospital: string; at?: string; note?: string }
): DomainEvent[] {
  requireHome(getActor(state, input.actorId), "借片单据开具");
  const chain = getChain(state, input.chainId);
  if (chain.loan) throw new RuleError("该会诊链已存在借片单据");
  const slide = getSlide(state, chain.slideId);
  const version = currentVersion(slide); // 借出瞬间冻结
  const at = input.at ?? nowIso();
  return [
    {
      type: "LoanCreated",
      at,
      loan: {
        loanId: uid("loan"),
        loanedAt: at,
        toHospital: input.toHospital,
        frozenVersionId: version.id,
        frozenBatchNo: version.batchNo,
        note: input.note,
      },
    },
  ];
}

// 旧会诊缺少玻片版本：按借片日期回填（取借片日期当日或之前最近的版本）；
// 回填后，版本未登记的历史草稿立即失效（不能在新版本上被签发），历史已签发快照保留。
export function backfillVersion(
  state: AppState,
  chainId: string,
  actorId: string,
  at = nowIso()
): DomainEvent[] {
  requireHome(getActor(state, actorId), "旧会诊版本回填");
  const chain = getChain(state, chainId);
  if (chain.loan?.frozenVersionId) throw new RuleError("冻结版本齐全，无需回填");
  const loanedAt = chain.loan?.loanedAt;
  if (!loanedAt) throw new RuleError("缺少借片日期，无法回填版本");
  const slide = getSlide(state, chain.slideId);
  const eligible = slide.versions
    .filter((v) => v.since <= loanedAt)
    .sort((a, b) => (a.since < b.since ? 1 : -1));
  const version = eligible[0] ?? slide.versions[0];
  if (!version) throw new RuleError("玻片没有任何版本记录可回填");
  const source = `按借片日期 ${loanedAt.slice(0, 10)} 回填`;
  const events: DomainEvent[] = [
    { type: "VersionBackfilled", at, versionId: version.id, batchNo: version.batchNo, source },
  ];
  const probe = structuredClone(state);
  applyEvent(probe, chainId, events[0]);
  const probeChain = probe.chains.find((c) => c.id === chainId)!;
  const orphanIds = probeChain.conclusions
    .filter((c) => c.state === "draft" && !c.versionId)
    .map((c) => c.id);
  if (orphanIds.length > 0) {
    events.push({
      type: "ConclusionsInvalidated",
      at,
      reason: `旧会诊版本回填（${source}）：版本未登记的历史草稿失效，需在 ${version.id} 上重算`,
      conclusionIds: orphanIds,
    });
  }
  return events;
}
