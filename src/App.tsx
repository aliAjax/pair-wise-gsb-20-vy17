import { useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  backfillSlideVersion,
  mergeFieldConclusions,
  planDraftOpinion,
  planExpertAnnotation,
  planExternalChange,
  planLendSlide,
  planSignOpinion,
  planSlideEvent,
  SlideEventEffects,
} from "./domain/chain";
import { DEMO, seedLegacyRecords, seedState } from "./domain/seed";
import { commit, createStore, Store } from "./domain/store";
import { runSelfTest, TestResult } from "./domain/selftest";
import {
  ChainEvent,
  ConsultationBatch,
  LegacyConsultationRecord,
  Opinion,
  Result,
} from "./domain/types";

type LogKind = "ok" | "rejected" | "conflict" | "info";

interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
  time: string;
}

const now = () => new Date().toISOString().slice(0, 19);

const LOG_LABEL: Record<LogKind, string> = {
  ok: "成功",
  rejected: "拒绝",
  conflict: "冲突",
  info: "提示",
};

const CONSULT_STATUS_LABEL: Record<string, string> = {
  open: "待借出",
  lent: "已借出",
  annotating: "标注中",
  signed: "已签发",
  closed: "已关闭",
};

function OpinionCard({ opinion: o, onSign }: { opinion: Opinion; onSign: (id: string, signer: string) => void }) {
  return (
    <article className={`record-card opinion-${o.status}`}>
      <div className="record-index">{(o.id.split("-").pop() ?? "").padStart(2, "0")}</div>
      <div>
        <h3>
          {o.id} · {o.author}
          <span className={`badge op-${o.status}`}>
            {o.status === "draft" ? "草稿(未签发)" : o.status === "signed" ? "已签发" : "已失效"}
          </span>
          {o.staleReason && <span className="badge badge-stale">基底已变化</span>}
        </h3>
        <p>{o.content}</p>
        <p className="muted small">
          依据 玻片 v{o.basedOnSlideVersion} / {o.basedOnStainingBatch}
          {o.invalidatedReason && ` · 失效原因: ${o.invalidatedReason}`}
          {o.supersededBy && ` · 已由 ${o.supersededBy} 重算接替`}
          {o.staleReason && ` · ${o.staleReason}`}
        </p>
        {o.snapshot && (
          <div className="snapshot-box">
            <b>签发快照(永久保留, 不受后续失效事件影响)</b>
            <span>
              {o.snapshot.signer} 签于 {o.snapshot.signedAt.replace("T", " ")} · 快照基底 v
              {o.snapshot.slideVersion} / {o.snapshot.stainingBatch}
            </span>
            <span>「{o.snapshot.content}」</span>
          </div>
        )}
        {o.status === "draft" && (
          <button className="small-btn" onClick={() => onSign(o.id, o.author)}>
            签发此份
          </button>
        )}
      </div>
    </article>
  );
}

function App() {
  const [store, setStore] = useState<Store>(() => createStore(seedState()));
  const [log, setLog] = useState<LogEntry[]>([
    { id: 0, kind: "info", text: "会诊链已就绪: 从「办理借出」开始, 各环节依次串联", time: now() },
  ]);
  const [legacy, setLegacy] = useState<LegacyConsultationRecord[]>(() => seedLegacyRecords());
  const [selfTest, setSelfTest] = useState<TestResult[] | null>(null);
  const logSeq = useRef(1);
  const annSeq = useRef(0);
  const draftSeq = useRef(1); // O-0417-1 为种子草稿

  const pushLog = (kind: LogKind, text: string) => {
    setLog((prev) => [{ id: logSeq.current++, kind, text, time: now() }, ...prev].slice(0, 80));
  };

  /** 统一提交入口: 规划失败即拒绝; 冲突/写失败如实记录 */
  const runBatch = (planned: Result<ConsultationBatch>, effects?: SlideEventEffects) => {
    if (!planned.ok) {
      pushLog("rejected", `${planned.error.code} · ${planned.error.message}`);
      return;
    }
    const res = commit(store, planned.value);
    if (res.ok) {
      let extra = "";
      if (effects) {
        const parts: string[] = [];
        if (effects.invalidated.length) parts.push(`失效 ${effects.invalidated.join(", ")}`);
        if (effects.recomputed.length) parts.push(`重算 ${effects.recomputed.join(", ")}`);
        if (effects.staleSigned.length) parts.push(`快照保留 ${effects.staleSigned.join(", ")}`);
        if (parts.length) extra = ` [${parts.join("; ")}]`;
      }
      pushLog("ok", `${planned.value.label} — ${res.note}${extra}`);
    } else if (res.conflict) {
      pushLog("conflict", `${planned.value.label} — ${res.conflict}`);
    } else {
      pushLog("rejected", `${planned.value.label} — ${res.note}`);
    }
    setStore({ ...store });
  };

  const s = store.state;
  const cid = DEMO.consultationId;
  const consultation = s.consultations[cid];
  const loan = consultation.loanId ? s.loans[consultation.loanId] : null;
  const slide = s.slides[DEMO.slideId];

  const annotations = useMemo(
    () => Object.values(s.annotations).filter((a) => a.consultationId === cid),
    [s.annotations, cid],
  );
  const merged = useMemo(() => mergeFieldConclusions(annotations), [annotations]);
  const opinions = useMemo(
    () =>
      Object.values(s.opinions)
        .filter((o) => o.consultationId === cid)
        .sort((a, b) => a.id.localeCompare(b.id)),
    [s.opinions, cid],
  );
  const drafts = opinions.filter((o) => o.status === "draft");

  // ---------------- ① 借出与冻结 ----------------
  const doLend = () =>
    runBatch(
      planLendSlide(s, {
        loanId: DEMO.loanId,
        consultationId: cid,
        slideId: DEMO.slideId,
        borrower: DEMO.borrower,
        at: now(),
      }),
    );

  // ---------------- ② 外院权限 ----------------
  const doExternalAnnotate = () =>
    runBatch(
      planExternalChange(s, {
        kind: "add_annotation",
        id: `A-E${++annSeq.current}`,
        consultationId: cid,
        field: DEMO.fieldB,
        author: DEMO.externalDoctor,
        text: "外院补充: 可见灶状坏死, 建议加做免疫组化",
        origin: "online",
      }),
    );
  const doExternalModifyLoan = () =>
    runBatch(planExternalChange(s, { kind: "modify_loan", loanId: DEMO.loanId }));
  const doExternalSign = () =>
    runBatch(planExternalChange(s, { kind: "sign_opinion", opinionId: "O-0417-1" }));

  // ---------------- ③ 专家离线标注 ----------------
  const doExpertOffline = (expert: "A" | "B") => {
    const isA = expert === "A";
    runBatch(
      planExpertAnnotation(s, {
        id: `A-X${++annSeq.current}`,
        consultationId: cid,
        field: DEMO.fieldA,
        author: isA ? DEMO.expertA : DEMO.expertB,
        text: isA ? "贴壁型腺癌" : "浸润性鳞癌",
        origin: "offline",
      }),
    );
  };

  // ---------------- ④ 起草与签发 ----------------
  const doDraft = (author: string) =>
    runBatch(planDraftOpinion(s, { id: `O-0417-${++draftSeq.current}`, consultationId: cid, author }));

  const doSignOne = (opinionId: string, signer: string) =>
    runBatch(planSignOpinion(s, { opinionId, signer, at: now() }));

  /** 两名专家基于同一时刻的状态同时提交签发 → CAS 只放行一份 */
  const doSignConcurrently = () => {
    if (drafts.length < 2) {
      pushLog("info", "并发签发演示需要至少两份草稿, 请先为两位专家各起草一份");
      return;
    }
    const [first, second] = drafts;
    const p1 = planSignOpinion(s, { opinionId: first.id, signer: first.author, at: now() });
    const p2 = planSignOpinion(s, { opinionId: second.id, signer: second.author, at: now() });
    pushLog("info", `${first.author} 与 ${second.author} 同时提交签发(均基于会诊 v${consultation.version})…`);
    if (p1.ok) {
      const r1 = commit(store, p1.value);
      pushLog(r1.ok ? "ok" : "rejected", `${p1.value.label} — ${r1.ok ? r1.note : r1.conflict ?? r1.note}`);
    }
    if (p2.ok) {
      const r2 = commit(store, p2.value);
      pushLog(r2.ok ? "ok" : "conflict", `${p2.value.label} — ${r2.ok ? r2.note : r2.conflict ?? r2.note}`);
    }
    setStore({ ...store });
  };

  // ---------------- ⑤ 玻片事件 ----------------
  const doSlideEvent = (event: ChainEvent) => {
    const planned = planSlideEvent(s, event);
    if (!planned.ok) {
      pushLog("rejected", `${planned.error.code} · ${planned.error.message}`);
      return;
    }
    runBatch({ ok: true, value: planned.value.batch }, planned.value.effects);
  };

  // ---------------- ⑥ 持久化: 故障注入 + 整批重试 ----------------
  const doCommitWithFailures = () => {
    store.failNextWrites = 2;
    pushLog("info", "已注入 2 次写入故障, 提交下一份会诊批次(自动回滚重试)…");
    runBatch(planDraftOpinion(s, { id: `O-0417-${++draftSeq.current}`, consultationId: cid, author: DEMO.expertA }));
  };

  // ---------------- ⑦ 旧会诊回填 ----------------
  const doBackfill = () => {
    const loans = Object.values(s.loans);
    let filled = 0;
    let failed = 0;
    const next = legacy.map((rec) => {
      const r = backfillSlideVersion(rec, loans);
      if (r.ok) {
        if (r.value !== rec) filled += 1;
        return r.value;
      }
      failed += 1;
      pushLog("rejected", `${rec.id} 回填失败 · ${r.error.message}`);
      return rec;
    });
    setLegacy(next);
    pushLog("ok", `回填完成: ${filled} 条按借片日期补上玻片版本${failed ? `, ${failed} 条无覆盖借片区间` : ""}`);
  };

  const doReset = () => {
    setStore(createStore(seedState()));
    setLegacy(seedLegacyRecords());
    setSelfTest(null);
    pushLog("info", "已重置为初始会诊链");
  };

  const stages = [
    {
      name: "① 借出冻结",
      done: !!loan,
      desc: loan ? `v${loan.frozenSlideVersion} / ${loan.frozenStainingBatch}` : "未借出",
    },
    {
      name: "② 外院标注",
      done: annotations.some((a) => a.role === "external"),
      desc: `${annotations.filter((a) => a.role === "external").length} 条`,
    },
    {
      name: "③ 离线合并",
      done: annotations.some((a) => a.origin === "offline"),
      desc: merged.length
        ? `${merged.length} 个视野 / ${merged.filter((m) => m.conflict).length} 处冲突`
        : "无离线标注",
    },
    {
      name: "④ 签发",
      done: !!consultation.signedOpinionId,
      desc: consultation.signedOpinionId ?? "未签发",
    },
    {
      name: "⑤ 归还/失效",
      done: !!loan?.returnedAt,
      desc: loan?.returnedAt ? "已归还" : slide.status === "damaged" ? "玻片损坏" : "在途",
    },
  ];

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-06 · 病理科会诊链</p>
          <h1>借片—标注—签发 一体化会诊链</h1>
          <p className="subtitle">
            借出即冻结玻片版本与染色批次; 外院只能补标注, 越权即拒; 离线标注回连按坐标合并、结论冲突保留多版;
            归还/重染/损坏后未签发结论立即失效重算、已签发保留快照; 并发签发 CAS 只放行一份; 批次写失败整体重试。
          </p>
        </div>
        <div className="stack-card">
          <span>当前会诊</span>
          <strong>{consultation.id}</strong>
          <span>{consultation.patientRef}</span>
          <span>
            状态 <b className={`badge st-${consultation.status}`}>{CONSULT_STATUS_LABEL[consultation.status]}</b>
            {" "}· 乐观锁 v{consultation.version} · 申请方 {consultation.requester}
          </span>
          <button onClick={doReset}>重置演示数据</button>
        </div>
      </section>

      <section className="chain-stepper">
        {stages.map((st) => (
          <div key={st.name} className={`stage ${st.done ? "stage-done" : ""}`}>
            <b>{st.name}</b>
            <span>{st.desc}</span>
          </div>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>玻片台账</h2>
          {Object.values(s.slides).map((sl) => (
            <div key={sl.id} className="kv-card">
              <b>{sl.label}</b>
              <span>
                {sl.staining} · 批次 {sl.stainingBatch} · 版本 v{sl.version}
              </span>
              <span className={`badge slide-${sl.status}`}>
                {sl.status === "in_house" ? "在库" : sl.status === "lent" ? "借出中" : "已损坏"}
              </span>
            </div>
          ))}

          <h2>借片单(冻结快照)</h2>
          {loan ? (
            <div className="kv-card frozen">
              <b>{loan.id}</b>
              <span>借往 {loan.borrower}</span>
              <span>
                冻结版本 <b>v{loan.frozenSlideVersion}</b> · 冻结批次 <b>{loan.frozenStainingBatch}</b>
              </span>
              <span>
                借出 {loan.lentAt.replace("T", " ")}
                {loan.returnedAt ? ` → 归还 ${loan.returnedAt.replace("T", " ")}` : " · 在途"}
              </span>
            </div>
          ) : (
            <p className="muted">尚无借片单, 点击「办理借出」。</p>
          )}
          <p className="muted small">
            历史借片单 {Object.values(s.loans).filter((l) => l.returnedAt).length} 份(供旧会诊回填)。
          </p>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>操作台</p>
              <h2>会诊链各环节</h2>
            </div>
          </div>

          <div className="action-groups">
            <div className="action-group">
              <h3>① 借出与冻结</h3>
              <div className="btn-row">
                <button className="primary-action" onClick={doLend}>
                  办理借出(冻结 v{slide.version}/{slide.stainingBatch})
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>② 外院权限(只能补标注)</h3>
              <div className="btn-row">
                <button onClick={doExternalAnnotate}>外院补充标注</button>
                <button className="danger-ghost" onClick={doExternalModifyLoan}>
                  外院尝试改借片单
                </button>
                <button className="danger-ghost" onClick={doExternalSign}>
                  外院尝试签发
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>③ 专家离线标注(同一视野, 结论不同)</h3>
              <div className="btn-row">
                <button onClick={() => doExpertOffline("A")}>王主任离线标注「贴壁型腺癌」</button>
                <button onClick={() => doExpertOffline("B")}>李教授离线标注「浸润性鳞癌」</button>
              </div>
            </div>

            <div className="action-group">
              <h3>④ 起草与签发</h3>
              <div className="btn-row">
                <button onClick={() => doDraft(DEMO.expertA)}>起草(王主任)</button>
                <button onClick={() => doDraft(DEMO.expertB)}>起草(李教授)</button>
                <button className="primary-action" onClick={doSignConcurrently}>
                  两名专家同时签发
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>⑤ 玻片事件(未签发失效重算 / 已签发留快照)</h3>
              <div className="btn-row">
                <button onClick={() => doSlideEvent({ type: "slide_returned", loanId: DEMO.loanId, at: now() })}>
                  玻片归还
                </button>
                <button
                  onClick={() =>
                    doSlideEvent({
                      type: "staining_changed",
                      slideId: DEMO.slideId,
                      newBatch: "HE-2610-C",
                      at: now(),
                    })
                  }
                >
                  染色批次变更 → HE-2610-C
                </button>
                <button
                  className="danger-ghost"
                  onClick={() => doSlideEvent({ type: "slide_damaged", slideId: DEMO.slideId, at: now() })}
                >
                  原始玻片损坏
                </button>
              </div>
            </div>

            <div className="action-group">
              <h3>⑥ 持久化(写失败整批重试)</h3>
              <div className="btn-row">
                <button onClick={doCommitWithFailures}>注入 2 次写失败后提交批次</button>
              </div>
            </div>

            <div className="action-group">
              <h3>⑦ 旧会诊版本回填</h3>
              <div className="btn-row">
                <button onClick={doBackfill}>按借片日期回填旧会诊</button>
              </div>
            </div>

            <div className="action-group">
              <h3>⑧ 领域自检</h3>
              <div className="btn-row">
                <button onClick={() => setSelfTest(runSelfTest())}>运行自检(10 项)</button>
              </div>
            </div>
          </div>
        </section>
      </section>

      <section className="grid-2col">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p>回连合并 · 按视野坐标</p>
              <h2>视野结论({merged.length} 个视野)</h2>
            </div>
          </div>
          {merged.length === 0 && <p className="muted">暂无标注。外院/专家标注后按坐标自动归组。</p>}
          <div className="record-list">
            {merged.map((m) => (
              <article key={m.key} className={`record-card ${m.conflict ? "conflict" : ""}`}>
                <div className="record-index">{m.field.magnification}x</div>
                <div>
                  <h3>
                    视野 ({m.field.x}, {m.field.y}) · {m.field.slideId}
                    {m.conflict && (
                      <span className="badge badge-conflict">结论冲突 · 保留 {m.versions.length} 版</span>
                    )}
                  </h3>
                  {m.versions.map((v) => (
                    <p key={v.annotationId}>
                      <b>{v.author}</b>
                      {v.origin === "offline" ? "(离线)" : ""}: {v.text}
                    </p>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="section-heading">
            <div>
              <p>会诊意见</p>
              <h2>草稿 / 签发 / 失效链</h2>
            </div>
          </div>
          <div className="record-list">
            {opinions.map((o) => (
              <OpinionCard key={o.id} opinion={o} onSign={doSignOne} />
            ))}
          </div>
        </div>
      </section>

      <section className="grid-2col">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p>历史档案</p>
              <h2>旧会诊版本回填</h2>
            </div>
            <button onClick={doBackfill}>按借片日期回填</button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>旧会诊号</th>
                <th>玻片</th>
                <th>会诊日期</th>
                <th>玻片版本</th>
                <th>染色批次</th>
              </tr>
            </thead>
            <tbody>
              {legacy.map((rec) => (
                <tr key={rec.id}>
                  <td>{rec.id}</td>
                  <td>{rec.slideId}</td>
                  <td>{rec.consultDate.slice(0, 10)}</td>
                  <td>{rec.slideVersion !== null ? `v${rec.slideVersion}` : <span className="badge badge-missing">缺失</span>}</td>
                  <td>{rec.stainingBatch ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">按会诊日期匹配覆盖该区间的借片单, 回填其冻结版本与批次。</p>
        </div>

        <div className="panel">
          <div className="section-heading">
            <div>
              <p>领域自检</p>
              <h2>十条规则全量验证</h2>
            </div>
            <button onClick={() => setSelfTest(runSelfTest())}>运行自检</button>
          </div>
          {selfTest ? (
            <ul className="selftest-list">
              {selfTest.map((t) => (
                <li key={t.name} className={t.pass ? "pass" : "fail"}>
                  <b>{t.pass ? "✓" : "✗"}</b> {t.name}
                  <span>{t.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">点击「运行自检」验证冻结、越权、合并、失效重算、并发签发、批次重试、回填。</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>链上流水</p>
            <h2>事件日志</h2>
          </div>
        </div>
        <div className="log-list">
          {log.map((entry) => (
            <div key={entry.id} className={`log-entry log-${entry.kind}`}>
              <span className="log-badge">{LOG_LABEL[entry.kind]}</span>
              <span className="log-text">{entry.text}</span>
              <span className="log-time">{entry.time.slice(11)}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
