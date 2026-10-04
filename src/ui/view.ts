import type { AppState, Chain, Slide } from "../domain/types";

export const STAGE_LABEL: Record<Chain["stage"], string> = {
  new: "待借出",
  legacy: "旧会诊·版本待回填",
  loaned: "借出中（版本冻结）",
  returned: "已归还",
  redyed: "已重染·版本变化",
  damaged: "原始玻片损坏",
};

export function slideOf(state: AppState, chain: Chain): Slide | undefined {
  return state.slides.find((s) => s.id === chain.slideId);
}

export function versionLabel(id: string | undefined, batchNo: string | undefined): string {
  if (!id) return "版本未登记";
  return batchNo ? `${id} / 批次 ${batchNo}` : id;
}

export function fmt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface FovGroup {
  key: string;
  label: string;
  coord: Chain["conclusions"][number]["coord"];
  items: Chain["conclusions"];
  divergent: boolean;
}

export function groupByFov(chain: Chain): FovGroup[] {
  const map = new Map<string, FovGroup>();
  for (const c of chain.conclusions) {
    let g = map.get(c.coordKey);
    if (!g) {
      g = { key: c.coordKey, label: c.coord.label ?? c.coordKey, coord: c.coord, items: [], divergent: false };
      map.set(c.coordKey, g);
    }
    g.items.push(c);
  }
  for (const g of map.values()) {
    const live = g.items.filter((i) => i.state !== "invalidated");
    g.divergent = new Set(live.map((i) => i.text)).size > 1;
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// 旧意见是否可能被误当成新结论：已失效 / 历史签发但版本与当前有效版本不同
export function isStale(chain: Chain, state: AppState, versionId: string): boolean {
  if (!versionId) return true;
  const slide = slideOf(state, chain);
  if (!slide) return false;
  const cur = slide.versions[slide.versions.length - 1];
  return chain.stage === "loaned" ? versionId !== chain.loan?.frozenVersionId : versionId !== cur.id;
}

export const STATE_PILL: Record<string, { text: string; cls: string }> = {
  draft: { text: "未签发", cls: "pill-draft" },
  invalidated: { text: "已失效", cls: "pill-invalid" },
  issued: { text: "已签发", cls: "pill-issued" },
};

export function metrics(state: AppState) {
  const chains = state.chains;
  const frozen = chains.filter((c) => c.stage === "loaned").length;
  const divergent = chains.reduce(
    (n, c) => n + (groupByFov(c).some((g) => g.divergent) ? 1 : 0),
    0
  );
  const invalid = chains.reduce(
    (n, c) => n + c.conclusions.filter((x) => x.state === "invalidated").length,
    0
  );
  const pending = state.batches.some((b) => b.failed && !b.committed) ? 1 : 0;
  return { frozen, divergent, invalid, pending };
}
