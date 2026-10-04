import { useMemo, useState } from "react";
import "./styles.css";
import { store, useStore } from "./domain/store";
import type { AppState, Chain, OfflinePacket } from "./domain/types";
import {
  annotate,
  backfillVersion,
  buildSyncEvents,
  changeStain,
  createLoan,
  damageSlide,
  issue,
  issueConcurrent,
  returnSlide,
} from "./domain/logic";
import {
  STAGE_LABEL,
  STATE_PILL,
  fmt,
  groupByFov,
  isStale,
  metrics,
  slideOf,
  versionLabel,
} from "./ui/view";

type Tab = "chain" | "journal" | "audit";

const EXTERNAL_ID = "u3";

function App() {
  const state = useStore();
  const [selectedId, setSelectedId] = useState("C-01");
  const [actorId, setActorId] = useState("u1");
  const [offline, setOffline] = useState(false);
  const [injectFail, setInjectFail] = useState(false);
  const [tab, setTab] = useState<Tab>("chain");
  const [toast, setToast] = useState<string | null>(null);

  const chain = state.chains.find((c) => c.id === selectedId) ?? state.chains[0];
  const actor = state.actors.find((a) => a.id === actorId)!;
  const m = metrics(state);
  const pendingBatch = state.batches.find((b) => b.failed && !b.committed);
  const groups = useMemo(() => groupByFov(chain), [chain]);
  const slide = slideOf(state, chain);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const run = (label: string, build: Parameters<typeof store.execute>[1], failAt?: number) => {
    const failPoint = failAt ?? injectFail ? (failAt ?? 2) : undefined;
    const b = store.execute(label, build, failPoint);
    if (b?.failed) {
      setTab("journal");
      setInjectFail(false);
    }
  };

  const isExternal = actor.kind === "external";

  // ---------- 动作 ----------

  const doBackfill = () =>
    run("旧会诊版本回填", (d) => ({
      chainId: chain.id,
      events: backfillVersion(d, chain.id, actorId),
    }));

  const doCreateLoan = () =>
    run("开具借片单据·冻结版本", (d) => ({
      chainId: chain.id,
      events: createLoan(d, { chainId: chain.id, actorId, toHospital: "省肿瘤医院" }),
    }));

  const doAnnotate = (coordInput: string, text: string, viaOffline = false) => {
    if (!text.trim()) return flash("标注内容不能为空");
    const [label, xs, ys, ms] = coordInput.split("/");
    const coord = {
      slideId: chain.slideId,
      label,
      x: Number(xs),
      y: Number(ys),
      mag: Number(ms),
    };
    if ([coord.x, coord.y, coord.mag].some((n) => Number.isNaN(n))) {
      return flash("坐标格式应为 视野名/x/y/倍数，如 A2/150/90/400");
    }
    if (offline || viaOffline) {
      store.queueOffline({
        chainId: chain.id,
        authorId: actorId,
        annotations: [{ coord, text, at: new Date().toISOString() }],
      });
      flash("已离线暂存，回连后按坐标合并");
      return;
    }
    run(isExternal ? "外院补标注（冻结版本）" : "在线视野标注", (d) => ({
      chainId: chain.id,
      events: annotate(d, { chainId: chain.id, actorId, coord, text }),
    }));
  };

  const doSync = (packet: OfflinePacket) => {
    const ok = store.syncPacket(packet.id, (d, p) => {
      const { events, skipped } = buildSyncEvents(d, p);
      return {
        chainId: p.chainId,
        events,
        audits: skipped
          ? [
              {
                tone: "info" as const,
                message: `离线合并：${skipped} 条与既有标注同坐标同文本，已去重；同坐标不同结论两版并存`,
              },
            ]
          : undefined,
      };
    });
    if (ok) flash("离线标注已按坐标合并");
  };

  const doReturn = () =>
    run("玻片归还登记", (d) => ({ chainId: chain.id, events: returnSlide(d, chain.id, actorId) }));

  const doRedye = () =>
    run("重染·染色版本变化", (d) => ({ chainId: chain.id, events: changeStain(d, chain.id, actorId) }));

  const doDamage = () =>
    run("原始玻片损坏登记", (d) => ({
      chainId: chain.id,
      events: damageSlide(d, chain.id, actorId, "封片边缘碎裂"),
    }));

  const doIssue = () =>
    run("专家签发会诊意见", (d) => ({ chainId: chain.id, events: issue(d, chain.id, actorId) }));

  const doConcurrentIssue = () =>
    run("两名专家同时提交签发", (d) => {
      const { events, rejectedExpertId, reason } = issueConcurrent(d, chain.id, ["u1", "u2"]);
      return {
        chainId: chain.id,
        events,
        audits:
          rejectedExpertId && reason
            ? [
                {
                  tone: "reject" as const,
                  message: `并发签发：${d.actors.find((a) => a.id === rejectedExpertId)?.name} 的签发被拒绝——${reason}`,
                },
              ]
            : undefined,
      };
    });

  // ---------- 渲染 ----------

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">病理科 · 外院会诊续作链</p>
          <h1>借片会诊一张链</h1>
          <p className="subtitle">
            借片单据、玻片染色版本、视野标注、会诊签发共用同一条只增不改的事件链：
            借出即冻结版本与染色批次，外院只能补标注；离线标注回连按坐标合并、同视野分歧两版并存；
            归还 / 重染 / 损坏后未签发结论立即失效，已签发意见保留快照。
          </p>
        </div>
        <div className="stack-card">
          <span>身份与链路状态</span>
          <strong>
            {actor.name} · {actor.title}
          </strong>
          <div className="switch-row">
            <select value={actorId} onChange={(e) => setActorId(e.target.value)}>
              {state.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.kind === "external" ? "【外院】" : "【本院】"}
                  {a.name}（{a.title}）
                </option>
              ))}
            </select>
            <button
              className={offline ? "offline-on" : "offline-off"}
              onClick={() => setOffline((v) => !v)}
              title="模拟专家网络中断 / 回连"
            >
              {offline ? "● 离线标注中" : "○ 在线"}
            </button>
          </div>
          <em className="hint">
            {isExternal
              ? "外院身份：仅可在借出冻结期补标注，改动本院记录将被拒绝"
              : "本院身份：可登记借还、重染、损坏与签发"}
          </em>
        </div>
      </section>

      {pendingBatch && (
        <section className="banner danger">
          <div>
            <strong>会诊批次写入失败，等待恢复</strong>
            <p>
              {pendingBatch.label}：{pendingBatch.failReason}（已落 {pendingBatch.entryCount}/
              {pendingBatch.events.length} 条事件）
            </p>
          </div>
          <div className="banner-actions">
            <button className="primary-action" onClick={() => store.recoverBatch(pendingBatch.id)}>
              从完整批次恢复重试
            </button>
            <button onClick={() => store.discardFailedBatch(pendingBatch.id)}>丢弃并回滚</button>
          </div>
        </section>
      )}

      <section className="metrics-grid">
        <Metric label="借出冻结中" value={m.frozen} tone="ok" />
        <Metric label="含分歧视野的链" value={m.divergent} tone="watch" />
        <Metric label="已失效未签发结论" value={m.invalid} tone="danger" />
        <Metric label="待恢复批次" value={m.pending} tone={m.pending ? "danger" : "ok"} />
      </section>

      <nav className="tabs">
        <button className={tab === "chain" ? "active" : ""} onClick={() => setTab("chain")}>
          会诊链
        </button>
        <button className={tab === "journal" ? "active" : ""} onClick={() => setTab("journal")}>
          事件批次（{state.batches.length}）
        </button>
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
          越权与规则审计（{state.audit.length}）
        </button>
        <button
          className={injectFail ? "inject-on" : "inject-off"}
          onClick={() => setInjectFail((v) => !v)}
          title="开启后，下一个多事件批次（归还 / 重染 / 损坏）在第 1 条事件落库后模拟写入失败"
        >
          {injectFail ? "⚡ 故障注入已开启（下一动作）" : "⚡ 模拟写入失败"}
        </button>
        <button className="reset" onClick={() => store.reset()}>
          重置演示数据
        </button>
      </nav>

      {tab === "chain" && (
        <section className="workspace">
          <aside className="panel narrow">
            <h2>会诊链 / 借片单据</h2>
            <div className="chain-list">
              {state.chains.map((c) => {
                const s = slideOf(state, c);
                return (
                  <button
                    key={c.id}
                    className={`chain-item ${c.id === chain.id ? "sel" : ""}`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <span className="chain-id">{c.id}</span>
                    <strong>{c.caseNo}</strong>
                    <em>{s?.part ?? c.slideId}</em>
                    <i className={`stage stage-${c.stage}`}>{STAGE_LABEL[c.stage]}</i>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="panel detail">
            <ChainHeader chain={chain} state={state} />

            <div className="action-bar">
              {chain.stage === "legacy" && (
                <>
                  <ActionBtn onClick={doBackfill} disabled={isExternal}>
                    按借片日期回填玻片版本
                  </ActionBtn>
                  <ActionBtn
                    onClick={() => run("外院尝试改动旧会诊（应拒绝）", (d) => ({
                      chainId: chain.id,
                      events: annotate(d, {
                        chainId: chain.id,
                        actorId: EXTERNAL_ID,
                        coord: { slideId: chain.slideId, x: 10, y: 10, mag: 100, label: "X" },
                        text: "外院尝试越权改写",
                      }),
                    }))}
                    variant="ghost-danger"
                  >
                    模拟越权：外院改本院记录
                  </ActionBtn>
                </>
              )}
              {chain.stage === "new" && (
                <ActionBtn onClick={doCreateLoan} disabled={isExternal}>
                  开借片单并冻结 {slide?.versions[slide.versions.length - 1]?.id}
                </ActionBtn>
              )}
              {chain.stage === "loaned" && (
                <>
                  <ActionBtn onClick={doReturn} disabled={isExternal}>
                    玻片归还（未签发结论立即失效）
                  </ActionBtn>
                  <ActionBtn onClick={doIssue} disabled={isExternal}>
                    以当前身份签发
                  </ActionBtn>
                  <ActionBtn onClick={doConcurrentIssue} disabled={isExternal} variant="ghost">
                    模拟双专家同时提交
                  </ActionBtn>
                </>
              )}
              {chain.stage === "returned" && (
                <>
                  <ActionBtn onClick={doRedye} disabled={isExternal}>
                    模拟重染 / 染色版本变化
                  </ActionBtn>
                  <ActionBtn onClick={doIssue} disabled={isExternal} variant="ghost">
                    以当前版本签发
                  </ActionBtn>
                </>
              )}
              {(chain.stage === "redyed" || chain.stage === "returned") && (
                <ActionBtn onClick={doDamage} disabled={isExternal} variant="ghost-danger">
                  模拟原始玻片损坏
                </ActionBtn>
              )}
              {chain.stage === "redyed" && (
                <ActionBtn onClick={doIssue} disabled={isExternal}>
                  重算后签发
                </ActionBtn>
              )}
              {chain.stage === "damaged" && (
                <ActionBtn onClick={doIssue} disabled={isExternal} variant="ghost">
                  依损坏前标注出限制性意见
                </ActionBtn>
              )}
            </div>

            <FovPanel chain={chain} state={state} groups={groups} actorId={actorId} offline={offline} onAnnotate={doAnnotate} />

            <IssuancePanel chain={chain} state={state} />

            {state.offlineQueue.some((p) => p.chainId === chain.id) && (
              <div className="subpanel">
                <h3>离线标注暂存（回连后合并）</h3>
                {state.offlineQueue.filter((p) => p.chainId === chain.id).map((p) => (
                  <div key={p.id} className="offline-row">
                    <span>
                      {state.actors.find((a) => a.id === p.authorId)?.name} · {p.annotations.length} 条 ·{" "}
                      {fmt(p.preparedAt)} 暂存
                    </span>
                    <button disabled={offline} onClick={() => doSync(p)}>
                      {offline ? "仍离线，无法回连" : "回连：按坐标合并"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
      )}

      {tab === "journal" && <JournalView state={state} />}
      {tab === "audit" && <AuditView state={state} />}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "ok" | "watch" | "danger" }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={`status-${tone}`} />
    </article>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "ghost" | "ghost-danger";
}) {
  return (
    <button
      className={`action ${variant ?? ""}`}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? "当前身份无权执行" : undefined}
    >
      {children}
    </button>
  );
}

function ChainHeader({ chain, state }: { chain: Chain; state: AppState }) {
  const s = slideOf(state, chain);
  const cur = s?.versions[s.versions.length - 1];
  const frozen = chain.loan?.frozenVersionId
    ? versionLabel(chain.loan.frozenVersionId, chain.loan.frozenBatchNo)
    : null;
  return (
    <div className="chain-head">
      <div>
        <p className="eyebrow">
          {chain.id} · 玻片 {chain.slideId} · 病理号 {chain.caseNo}
        </p>
        <h2>{s?.part}</h2>
        <i className={`stage stage-${chain.stage}`}>{STAGE_LABEL[chain.stage]}</i>
      </div>
      <div className="version-grid">
        <div>
          <span>当前玻片版本</span>
          <strong>{cur ? versionLabel(cur.id, cur.batchNo) : "—"}</strong>
          {s?.damaged && <em className="danger-text">原始玻片已损坏</em>}
        </div>
        <div>
          <span>借出冻结版本</span>
          <strong className={frozen ? "" : "missing"}>{frozen ?? "未登记（旧会诊待回填）"}</strong>
        </div>
        {chain.loan && (
          <div>
            <span>借片单据</span>
            <strong>
              {chain.loan.toHospital}
            </strong>
            <em>
              借 {fmt(chain.loan.loanedAt)}
              {chain.loan.returnedAt ? ` · 还 ${fmt(chain.loan.returnedAt)}` : ""}
            </em>
          </div>
        )}
        {chain.backfilled && (
          <div className="backfill">
            <span>已回填</span>
            <strong>{versionLabel(chain.backfilled.versionId, chain.backfilled.batchNo)}</strong>
            <em>{chain.backfilled.source}</em>
          </div>
        )}
      </div>
    </div>
  );
}

function FovPanel({
  chain,
  state,
  groups,
  actorId,
  offline,
  onAnnotate,
}: {
  chain: Chain;
  state: AppState;
  groups: ReturnType<typeof groupByFov>;
  actorId: string;
  offline: boolean;
  onAnnotate: (coord: string, text: string, viaOffline?: boolean) => void;
}) {
  const [coord, setCoord] = useState("A2/150/90/400");
  const [text, setText] = useState("");
  const firstLive = groups.find((g) => g.items.some((i) => i.state !== "invalidated"));

  return (
    <div className="subpanel">
      <div className="sub-head">
        <h3>视野标注与结论（按镜下坐标合并）</h3>
        <span className="rule-note">
          同坐标 + 同文本 → 合并署名；同坐标不同文本 → 两版并存；已失效结论不会被新标注复活
        </span>
      </div>

      <div className="annotate-form">
        <input value={coord} onChange={(e) => setCoord(e.target.value)} placeholder="视野名/x/y/倍数" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="该视野镜下所见 / 结论"
        />
        <button
          onClick={() => {
            onAnnotate(coord, text, false);
            setText("");
          }}
        >
          {offline ? "离线：提交即暂存" : "提交标注"}
        </button>
        <button className="ghost" onClick={() => { onAnnotate(coord, text, true); setText(""); }}>
          存为离线标注
        </button>
        {firstLive && (
          <button
            className="ghost"
            title="快速在首个有效视野补一条不同结论，演示同视野两版"
            onClick={() =>
              onAnnotate(
                `${firstLive.label}/${firstLive.coord.x}/${firstLive.coord.y}/${firstLive.coord.mag}`,
                `补充意见（${state.actors.find((a) => a.id === actorId)?.name} ${Date.now() % 1000}）`
              )
            }
          >
            在 {firstLive.label} 补不同结论
          </button>
        )}
      </div>

      {groups.length === 0 && <p className="empty">尚无视野标注</p>}
      <div className="fov-list">
        {groups.map((g) => (
          <div key={g.key} className={`fov-card ${g.divergent ? "divergent" : ""}`}>
            <div className="fov-title">
              <strong>视野 {g.label}</strong>
              <span>
                ({g.coord.x}, {g.coord.y}) · {g.coord.mag}x
              </span>
              {g.divergent && <i className="badge badge-div">同一视野两版结论并存</i>}
            </div>
            {g.items.map((c) => {
              const stale = isStale(chain, state, c.versionId);
              const pill = STATE_PILL[c.state];
              return (
                <div key={c.id} className={`conclusion ${c.state}`}>
                  <div className="conclusion-main">
                    <p>{c.text}</p>
                    <small>
                      {c.authorNames.join("、")} · 依据 {versionLabel(c.versionId, c.batchNo)} ·{" "}
                      {fmt(c.createdAt)}
                      {c.state === "draft" && stale && "（旧版本草稿，不能当当前结论）"}
                      {c.state === "invalidated" && ` · 失效原因：${c.invalidateReason}`}
                    </small>
                  </div>
                  <span className={`pill ${pill.cls}`}>{pill.text}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function IssuancePanel({ chain, state }: { chain: Chain; state: AppState }) {
  if (chain.issuances.length === 0) {
    return (
      <div className="subpanel">
        <h3>签发与快照</h3>
        <p className="empty">尚未签发。签发后意见随版本快照留存，后续归还 / 重染 / 损坏均不改动。</p>
      </div>
    );
  }
  return (
    <div className="subpanel">
      <h3>签发与快照（{chain.issuances.length}）</h3>
      {chain.issuances.map((iss) => (
        <div key={iss.id} className="iss-card">
          <div className="iss-head">
            <strong>{iss.expertName}</strong>
            <span>{fmt(iss.issuedAt)}</span>
            {iss.snapshot.versionId && (
              <i className="badge">快照 {versionLabel(iss.snapshot.versionId, iss.snapshot.batchNo)}</i>
            )}
            {!iss.snapshot.versionId && <i className="badge badge-old">历史签发·版本未登记</i>}
          </div>
          <p>{iss.diagnosis}</p>
          <ul>
            {iss.snapshot.conclusions.map((sc) => (
              <li key={`${sc.coordLabel}-${sc.text}`}>
                {sc.coordLabel}：{sc.text}
                <small>（{sc.authorNames.join("、")}）</small>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function JournalView({ state }: { state: AppState }) {
  return (
    <section className="panel">
      <div className="sub-head">
        <h2>完整会诊批次日志（append-only）</h2>
        <span className="rule-note">写入失败的批次保留全部事件，回连后从批次恢复重试，不允许半截状态继续接受写入</span>
      </div>
      {state.batches.length === 0 && <p className="empty">本会话尚无新批次（种子数据发生在迁移前）</p>}
      <div className="journal-list">
        {state.batches.map((b) => (
          <article key={b.id} className={`journal-card ${b.failed ? "failed" : b.committed ? "ok" : ""}`}>
            <header>
              <div>
                <strong>{b.label}</strong>
                <p>
                  {b.id} · 链 {b.chainId} · {fmt(b.at)}
                </p>
              </div>
              <span className={`pill ${b.failed ? "pill-invalid" : "pill-issued"}`}>
                {b.failed ? `写入中断 ${b.entryCount}/${b.events.length}` : "已提交"}
              </span>
            </header>
            {b.failed && (
              <div className="journal-actions">
                <button className="primary-action" onClick={() => store.recoverBatch(b.id)}>
                  从完整批次恢复重试
                </button>
                <button onClick={() => store.discardFailedBatch(b.id)}>丢弃并回滚基线</button>
              </div>
            )}
            {b.recoveredAt && <p className="recovered">已于 {fmt(b.recoveredAt)} 从完整批次恢复</p>}
            <ol>
              {b.events.map((e, i) => (
                <li key={i} className={b.failed && i >= b.entryCount ? "lost" : ""}>
                  <code>{e.type}</code>
                  <span>{describeEvent(e.type)}</span>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}

function describeEvent(t: string): string {
  switch (t) {
    case "LoanCreated":
      return "开借片单，冻结玻片染色版本与批次";
    case "AnnotationAdded":
      return "视野标注并入（按坐标合并 / 两版并存）";
    case "ConclusionsInvalidated":
      return "未签发结论失效，等待在新版本重算";
    case "SlideReturned":
      return "玻片归还入库";
    case "StainVersionChanged":
      return "重染 / 染色版本变化";
    case "SlideDamaged":
      return "原始玻片损坏登记";
    case "Issued":
      return "专家签发，结论与版本写入不可变快照";
    case "VersionBackfilled":
      return "旧会诊按借片日期回填玻片版本";
    default:
      return "";
  }
}

function AuditView({ state }: { state: AppState }) {
  return (
    <section className="panel">
      <div className="sub-head">
        <h2>越权拒绝与规则审计</h2>
        <span className="rule-note">被拒绝的操作不进入事件日志，只在此留痕</span>
      </div>
      <div className="audit-list">
        {state.audit.map((a) => (
          <article key={a.id} className={`audit-row tone-${a.tone}`}>
            <span className="audit-time">{fmt(a.at)}</span>
            <p>{a.message}</p>
          </article>
        ))}
      </div>
      <p className="empty hint">
        提示：切换到外院身份后点击“模拟越权”，或在已归还链上尝试外院标注，可看到拒绝记录。
      </p>
    </section>
  );
}

export default App;
