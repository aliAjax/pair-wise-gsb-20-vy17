// 领域规则冒烟测试（node 环境，esbuild 临时打包执行）

// node 下无 localStorage：内存桩（必须在导入 store 之前安装）
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  get length() {
    return mem.size;
  },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => void mem.delete(k),
  setItem: (k: string, v: string) => void mem.set(k, v),
};

async function main() {
  const [{ buildSeed }, typesMod, logicMod, storeMod] = await Promise.all([
    import("../src/domain/seed"),
    import("../src/domain/types"),
    import("../src/domain/logic"),
    import("../src/domain/store"),
  ]);
  const { PermissionError, ConflictError, RuleError } = typesMod;
  const {
    annotate,
    applyEvent,
    backfillVersion,
    buildSyncEvents,
    changeStain,
    createLoan,
    damageSlide,
    issue,
    issueConcurrent,
    returnSlide,
  } = logicMod;

  let passed = 0;
  let failed = 0;
  function ok(name: string, cond: boolean, extra = "") {
    if (cond) {
      passed += 1;
      console.log(`  ✓ ${name}`);
    } else {
      failed += 1;
      console.error(`  ✗ ${name} ${extra}`);
    }
  }
  function rejects(name: string, fn: () => unknown, ctor: Function) {
    try {
      fn();
      ok(name, false, "未抛错");
    } catch (e) {
      ok(name, e instanceof ctor, (e as Error).message);
    }
  }
  type Events = ReturnType<typeof annotate>;
  function commit(state: typesMod.AppState, chainId: string, events: Events) {
    events.forEach((e) => applyEvent(state, chainId, e));
  }
  type AppState = typesMod.AppState;
  type OfflinePacket = typesMod.OfflinePacket;

// 1. 借出冻结：C-04 新开借片单
{
  const s = buildSeed();
  const ev = createLoan(s, { chainId: "C-04", actorId: "u4", toHospital: "省肿瘤医院" });
  commit(s, "C-04", ev);
  const c = s.chains.find((x) => x.id === "C-04")!;
  ok("借出时冻结玻片版本与染色批次", c.loan!.frozenVersionId === "HE-v1" && c.loan!.frozenBatchNo === "B26088");
  ok("借据开具后进入借出冻结态", c.stage === "loaned");
}

// 2. 外院权限：只能借出期补标注，归还/损坏登记等被拒
{
  const s = buildSeed();
  const ev = annotate(s, {
    chainId: "C-02",
    actorId: "u3",
    coord: { slideId: "S-205", x: 10, y: 10, mag: 400, label: "Z9" },
    text: "外院补充镜下所见",
  });
  ok("借出冻结期外院可补标注", ev.length === 1 && ev[0].type === "AnnotationAdded");
  rejects("外院签发被拒", () => issue(s, "C-02", "u3"), PermissionError);
  rejects("外院登记归还被拒", () => returnSlide(s, "C-02", "u3"), PermissionError);
  rejects("外院在已归还链标注被拒（C-03）", () => annotate(s, {
    chainId: "C-03", actorId: "u3",
    coord: { slideId: "S-188", x: 1, y: 1, mag: 100, label: "Z" }, text: "x",
  }), PermissionError);
}

// 3. 标注携带冻结版本；同坐标同文本合并署名；同坐标不同文本两版并存
{
  const s = buildSeed();
  const ev = annotate(s, {
    chainId: "C-02", actorId: "u2",
    coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" },
    text: "甲状腺乳头状微小癌，直径约 0.4 cm", // 与王德明同坐标同文本
  });
  commit(s, "C-02", ev);
  const c = s.chains.find((x) => x.id === "C-02")!;
  const same = c.conclusions.filter((x) => x.text.includes("乳头状微小癌"));
  ok("同坐标同文本合并为一条、两位作者署名", same.length === 1 && same[0].authorIds.length === 2);
  ok("A1 视野分歧两版并存", new Set(c.conclusions.filter((x) => x.coordKey === "S-205@132,88/400x").map((x) => x.text)).size === 2);
  ok("外院标注依据冻结版本", c.annotations.some((a) => a.authorId === "u3" && a.versionId === "HE-v1" && a.basis === "frozen"));
}

// 4. 离线回连：按坐标合并；同专家同坐标同文本去重（重传幂等）；非借出期外院包拒绝
{
  const s = buildSeed();
  const mkPkt = (): OfflinePacket => ({
    id: "p1", chainId: "C-02", authorId: "u3", preparedAt: "2026-10-02T08:00:00.000Z",
    annotations: [
      { coord: { slideId: "S-205", x: 300, y: 200, mag: 400, label: "D1" }, text: "外院离线新视野结论", at: "2026-10-02T07:00:00.000Z" },
      // 与赵一凡既有标注同坐标同文本（本人重传）
      { coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" }, text: "倾向结节性甲状腺肿伴乳头状增生，未见明确包膜侵犯", at: "2026-10-02T07:05:00.000Z" },
    ],
  });
  const first = buildSyncEvents(s, mkPkt());
  ok("离线包仅一条新事件", first.events.length === 1);
  ok("本人同坐标同文本重传被去重", first.skipped === 1);
  commit(s, "C-02", first.events);
  // 同一包再次回连：全部幂等
  const second = buildSyncEvents(s, mkPkt());
  ok("离线重连整包幂等（无新事件）", second.events.length === 0 && second.skipped === 2);

  // 不同专家同坐标同文本：不做去重，结论层合并署名
  const other: OfflinePacket = {
    id: "p1b", chainId: "C-02", authorId: "u2", preparedAt: "x",
    annotations: [{ coord: { slideId: "S-205", x: 132, y: 88, mag: 400, label: "A1" }, text: "倾向结节性甲状腺肿伴乳头状增生，未见明确包膜侵犯", at: "x" }],
  };
  const otherRes = buildSyncEvents(s, other);
  ok("他人同坐标同文本不予去重（进结论层合并）", otherRes.events.length === 1);
  commit(s, "C-02", otherRes.events);
  const c = s.chains.find((x) => x.id === "C-02")!;
  const merged = c.conclusions.find((x) => x.text.includes("结节性甲状腺肿"))!;
  ok("结论层追加署名（李素华）", merged.authorIds.includes("u2") && merged.authorIds.includes("u3"));

  const badPkt: OfflinePacket = {
    id: "p2", chainId: "C-03", authorId: "u3", preparedAt: "x",
    annotations: [{ coord: { slideId: "S-188", x: 1, y: 1, mag: 100, label: "Z" }, text: "y", at: "x" }],
  };
  rejects("归还后外院离线包回连被拒", () => buildSyncEvents(s, badPkt), PermissionError);
}

// 5. 归还：未签发失效、已签发留快照；之后重染再失效（此时无草稿）；新版本需重算
{
  const s = buildSeed();
  // C-02 走 借出 -> 签发 -> 再补草稿 -> 归还
  let c = s.chains.find((x) => x.id === "C-02")!;
  const iss = issue(s, "C-02", "u1");
  commit(s, "C-02", iss);
  const add = annotate(s, {
    chainId: "C-02", actorId: "u1",
    coord: { slideId: "S-205", x: 50, y: 60, mag: 100, label: "E1" }, text: "归还前新增草稿",
  });
  commit(s, "C-02", add);
  const ret = returnSlide(s, "C-02", "u4");
  // 事件1 失效草稿，事件2 归还
  ok("归还批次含失效+归还两事件", ret.length === 2 && ret[0].type === "ConclusionsInvalidated" && ret[1].type === "SlideReturned");
  commit(s, "C-02", ret);
  c = s.chains.find((x) => x.id === "C-02")!;
  ok("归还后新草稿立即失效", c.conclusions.find((x) => x.text === "归还前新增草稿")!.state === "invalidated");
  ok("已签发结论保持 issued", c.conclusions.some((x) => x.state === "issued"));
  ok("已签发意见快照仍在（不被归还改动）", c.issuances.length === 1 && c.issuances[0].snapshot.versionId === "HE-v1");

  // 重染：版本 HE-v2；旧版本草稿不能签发
  const dye = changeStain(s, "C-02", "u4");
  ok("重染产生新版本事件", dye.some((e) => e.type === "StainVersionChanged"));
  commit(s, "C-02", dye);
  c = s.chains.find((x) => x.id === "C-02")!;
  const slide = s.slides.find((x) => x.id === "S-205")!;
  ok("玻片出现 HE-v2 新批次", slide.versions.some((v) => /^HE-v2$/.test(v.id)));
  rejects("新版本下无草稿不能签发（旧意见不能当新结论）", () => issue(s, "C-02", "u1"), RuleError);

  // 在新版本重算标注后可签发；历史快照仍保留
  const reann = annotate(s, {
    chainId: "C-02", actorId: "u1",
    coord: { slideId: "S-205", x: 50, y: 60, mag: 100, label: "E1" }, text: "HE-v2 重算后结论",
  });
  commit(s, "C-02", reann);
  const iss2Events = issue(s, "C-02", "u2");
  commit(s, "C-02", iss2Events);
  c = s.chains.find((x) => x.id === "C-02")!;
  ok("重算签发形成第二份快照、旧快照保留", c.issuances.length === 2);
  ok("两份快照绑定不同版本", new Set(c.issuances.map((i) => i.snapshot.versionId)).size === 2);
}

// 6. 原始玻片损坏：未签发失效，已签发快照保留，可出限制性意见
{
  const s = buildSeed();
  const dmg = damageSlide(s, "C-03", "u4", "封片碎裂");
  commit(s, "C-03", dmg);
  const c = s.chains.find((x) => x.id === "C-03")!;
  ok("损坏后进入 damaged 且玻片标记损坏", c.stage === "damaged" && s.slides.find((x) => x.id === "S-188")!.damaged);
  ok("历史已签发快照仍保留", c.issuances.length === 1);
}

// 7. 双专家同时提交签发：只一份生效
{
  const s = buildSeed();
  const { events, rejectedExpertId, reason } = issueConcurrent(s, "C-02", ["u1", "u2"]);
  ok("仅一人生效", events.length === 1);
  ok("后提交者被识别拒绝", rejectedExpertId === "u2" && !!reason);
  commit(s, "C-02", events);
  rejects("再次签发同版本冲突", () => issue(s, "C-02", "u2"), ConflictError);
}

// 8. 旧会诊回填：按借片日期取最近版本
{
  const s = buildSeed();
  rejects("回填前外院补标注被拒（链未入冻结期）", () => annotate(s, {
    chainId: "C-01", actorId: "u3",
    coord: { slideId: "S-101", x: 1, y: 1, mag: 100, label: "Z" }, text: "q",
  }), PermissionError);
  rejects("回填前本院标注同样拒绝（缺冻结版本）", () => annotate(s, {
    chainId: "C-01", actorId: "u1",
    coord: { slideId: "S-101", x: 1, y: 1, mag: 100, label: "Z" }, text: "q",
  }), RuleError);
  const bf = backfillVersion(s, "C-01", "u4");
  ok("回填批次另含旧草稿失效事件", bf.length === 2 && bf[1].type === "ConclusionsInvalidated");
  commit(s, "C-01", bf);
  const c = s.chains.find((x) => x.id === "C-01")!;
  // 借片日 2025-12-03，HE-v1 2025-11-20 合格；HE-v2 2026-01-15 不合格
  ok("按借片日期回填 HE-v1 / B23101", c.loan!.frozenVersionId === "HE-v1" && c.loan!.frozenBatchNo === "B23101");
  ok("回填来源已记录", !!c.backfilled && c.backfilled.source.includes("2025-12-03"));
  ok("版本未登记的历史草稿回填后失效", c.conclusions.find((x) => x.id === "con-old-draft")!.state === "invalidated");
  ok("历史已签发快照回填后仍保留", c.issuances.length === 1 && c.conclusions.some((x) => x.state === "issued"));
  // 回填后旧标注仍可被外院继续补充
  const ev = annotate(s, {
    chainId: "C-01", actorId: "u3",
    coord: { slideId: "S-101", x: 9, y: 9, mag: 200, label: "A2" }, text: "回填后外院补标注",
  });
  ok("回填后外院可在冻结期补标注", ev[0].type === "AnnotationAdded");
}

// 9. 失效结论不会被新标注复活
{
  const s = buildSeed(); // C-03 的 con-3-2 已失效
  const ev = annotate(s, {
    chainId: "C-03", actorId: "u1",
    coord: { slideId: "S-188", x: 512, y: 77, mag: 400, label: "C2" },
    text: "局部见脉管内癌栓待免疫组化确认（未签发草稿）", // 与失效结论同坐标同文本
  });
  commit(s, "C-03", ev);
  const c = s.chains.find((x) => x.id === "C-03")!;
  const sameText = c.conclusions.filter((x) => x.text.includes("脉管内癌栓"));
  ok("同坐标同文本产生新草稿而非复活失效条目", sameText.length === 2 && sameText.some((x) => x.state === "invalidated") && sameText.some((x) => x.state === "draft"));
}

  // 10. 存储层：多事件批次第 1 条后写入失败 -> 状态半截 -> 从完整批次恢复重试
  {
    const store = new storeMod.ChainStore();
    // 回到干净种子
    store.reset();
    const before = store.getState().chains.find((x) => x.id === "C-02")!;
    const draftCountBefore = before.conclusions.filter((x) => x.state === "draft").length;

    const batch = store.execute(
      "故障演练：归还批次第 1 条后中断",
      (d) => ({ chainId: "C-02", events: returnSlide(d, "C-02", "u4") }),
      1
    );
    ok("失败批次被保留且未提交", !!batch && batch!.failed && !batch!.committed);
    let c = store.getState().chains.find((x) => x.id === "C-02")!;
    ok("半截状态：草稿已失效但仍处于借出态", c.stage === "loaned" && c.conclusions.filter((x) => x.state === "draft").length === 0);

    // 挂起期间禁止叠加写入
    const blocked = store.execute("挂起期间尝试再写", (d) => ({ chainId: "C-02", events: annotate(d, {
      chainId: "C-02", actorId: "u1",
      coord: { slideId: "S-205", x: 1, y: 1, mag: 100, label: "Q" }, text: "不应进入",
    }) }));
    ok("挂起批次期间新写入被拒绝", blocked === null);

    store.recoverBatch(batch!.id);
    c = store.getState().chains.find((x) => x.id === "C-02")!;
    const b2 = store.getState().batches.find((x) => x.id === batch!.id)!;
    ok("恢复后批次全部提交", b2.committed && !b2.failed && !!b2.recoveredAt);
    ok("恢复后状态完整：已归还", c.stage === "returned" && c.loan?.returnedAt !== undefined);
    ok("恢复后仍有 2 条事件且草稿失效数与演练前一致（幂等重放）",
      b2.events.length === 2 && c.conclusions.filter((x) => x.state === "invalidated").length >= draftCountBefore);
    ok("恢复后可接受新写入（重染）", !!store.execute("恢复后重染", (d) => ({ chainId: "C-02", events: changeStain(d, "C-02", "u4") })));
  }

  console.log(`\n含存储层恢复：${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
