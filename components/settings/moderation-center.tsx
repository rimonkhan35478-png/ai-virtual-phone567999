"use client";

// 管理中心（仅管理员可见）：举报队列 / 应用审核 / 用户管理。
// 依赖 docs/moderation-supabase.sql（role 列 + content_reports 表）。

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";

import { ConfirmDialog } from "../ui/modal";
import { Toggle } from "../ui/form";
import { fetchReports, moderationApi, type ContentReport } from "@/lib/moderation-client";
import { fetchCustomAppMarketAdminItems, reviewCustomAppMarketItem } from "@/lib/custom-app-market-client";
import type { CustomAppMarketItem } from "@/lib/custom-app-market-types";
import {
  approveShareClaim,
  approveShareSubmission,
  canManageShareRepo,
  fetchAutoApprove,
  setAutoApprove,
  fetchClaimProofFiles,
  fetchShareSubmissionFiles,
  listShareSubmissions,
  parseShareClaim,
  rejectShareSubmission,
  type ShareSubmission,
  type ShareSubmissionFile,
} from "@/lib/resource-hub-review";

const TYPE_LABELS: Record<string, string> = {
  market_app: "市场APP",
  game: "游戏",
  game_comment: "游戏评论",
  online_doc: "联机云内容",
  online_room: "联机房间",
};

type Tab = "reports" | "review" | "share" | "users";

type FoundUser = { id: string; username: string; displayName: string; status: string };

export function ModerationCenter({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [tab, setTab] = useState<Tab>("reports");
  const notice = useCallback((msg: string) => onNotice?.(msg), [onNotice]);

  // ── 举报队列 ──
  const [reportStatus, setReportStatus] = useState<"pending" | "resolved" | "dismissed">("pending");
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [confirmAction, setConfirmAction] = useState<{ kind: "takedown" | "ban"; report: ContentReport } | null>(null);

  const loadReports = useCallback(async (status: "pending" | "resolved" | "dismissed") => {
    setReportsLoading(true);
    try {
      setReports(await fetchReports(status));
    } catch (err) {
      notice(err instanceof Error ? err.message : "举报列表加载失败");
    } finally {
      setReportsLoading(false);
    }
  }, [notice]);

  useEffect(() => {
    if (tab === "reports") void loadReports(reportStatus);
  }, [tab, reportStatus, loadReports]);

  const runReportAction = async (report: ContentReport, body: Record<string, unknown>, successText: string) => {
    setBusyIds(current => ({ ...current, [report.id]: true }));
    try {
      await moderationApi(body);
      notice(successText);
      await loadReports(reportStatus);
    } catch (err) {
      notice(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyIds(current => {
        const next = { ...current };
        delete next[report.id];
        return next;
      });
    }
  };

  // ── 应用审核 ──
  const [reviewItems, setReviewItems] = useState<CustomAppMarketItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewBusyIds, setReviewBusyIds] = useState<Record<string, boolean>>({});

  const loadReviewItems = useCallback(async () => {
    setReviewLoading(true);
    try {
      setReviewItems(await fetchCustomAppMarketAdminItems({ adminKey: "", view: "pending" }));
    } catch (err) {
      notice(err instanceof Error ? err.message : "审核列表加载失败（未开启先审后发时通常为空）");
      setReviewItems([]);
    } finally {
      setReviewLoading(false);
    }
  }, [notice]);

  useEffect(() => {
    if (tab === "review") void loadReviewItems();
  }, [tab, loadReviewItems]);

  const reviewApp = async (item: CustomAppMarketItem, action: "approve" | "reject") => {
    setReviewBusyIds(current => ({ ...current, [item.id]: true }));
    try {
      await reviewCustomAppMarketItem({ adminKey: "", id: item.id, action });
      notice(action === "approve" ? `已通过「${item.name}」` : `已驳回「${item.name}」`);
      await loadReviewItems();
    } catch (err) {
      notice(err instanceof Error ? err.message : "审核操作失败");
    } finally {
      setReviewBusyIds(current => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  };

  // ── 集市审核（share 仓库待审投稿；权限由 GitHub 服务端裁决）──
  const [shareItems, setShareItems] = useState<ShareSubmission[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  // 记录正在进行的动作，按钮上好显示「上架中…/拒绝中…」
  const [shareBusy, setShareBusy] = useState<Record<number, "approve" | "reject">>({});
  const [shareExpanded, setShareExpanded] = useState<number | null>(null);
  const [shareFiles, setShareFiles] = useState<Record<number, ShareSubmissionFile[] | "loading">>({});
  const [shareRejectFor, setShareRejectFor] = useState<number | null>(null);
  const [shareRejectReason, setShareRejectReason] = useState("");
  // 自动审核：开关存在资源仓库里，只有对仓库有写权限的人才改得动
  const [autoApprove, setAutoApproveState] = useState(false);
  const [canManageRepo, setCanManageRepo] = useState(false);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);

  const loadShareItems = useCallback(async () => {
    setShareLoading(true);
    try {
      setShareItems(await listShareSubmissions());
    } catch (err) {
      notice(err instanceof Error ? err.message : "投稿列表加载失败");
      setShareItems([]);
    } finally {
      setShareLoading(false);
    }
  }, [notice]);

  useEffect(() => {
    if (tab === "share") void loadShareItems();
  }, [tab, loadShareItems]);

  useEffect(() => {
    if (tab !== "share") return;
    let cancelled = false;
    void (async () => {
      const [manage, auto] = await Promise.all([
        canManageShareRepo(),
        fetchAutoApprove().catch(() => false),
      ]);
      if (cancelled) return;
      setCanManageRepo(manage);
      setAutoApproveState(auto);
    })();
    return () => { cancelled = true; };
  }, [tab]);

  const toggleAutoApprove = async (next: boolean) => {
    setAutoApproveBusy(true);
    try {
      await setAutoApprove(next);
      setAutoApproveState(next);
      onNotice?.(next ? "已开启自动审核：新投稿会直接上架" : "已关闭自动审核：新投稿重新排队等人工");
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "改不动这个开关（需要资源仓库的写权限）");
    } finally {
      setAutoApproveBusy(false);
    }
  };

  const toggleShareDetail = async (item: ShareSubmission) => {
    if (shareExpanded === item.number) { setShareExpanded(null); return; }
    setShareExpanded(item.number);
    if (!shareFiles[item.number]) {
      setShareFiles(current => ({ ...current, [item.number]: "loading" }));
      try {
        // 找回申请的证明材料在私有保管库里，走专用读取；普通投稿读 PR 文件
        const claim = parseShareClaim(item);
        const files = claim
          ? await fetchClaimProofFiles(item.number, claim)
          : await fetchShareSubmissionFiles(item.number);
        setShareFiles(current => ({ ...current, [item.number]: files }));
      } catch (err) {
        notice(err instanceof Error ? err.message : "内容加载失败");
        setShareFiles(current => { const next = { ...current }; delete next[item.number]; return next; });
      }
    }
  };

  const runShareAction = async (item: ShareSubmission, action: "approve" | "reject", reason?: string) => {
    setShareBusy(current => ({ ...current, [item.number]: action }));
    try {
      if (action === "approve") {
        // 找回申请是特殊 PR：通过=改写 .owner 并关闭，绝不合并（证明材料不进仓库）
        const claim = parseShareClaim(item);
        if (claim) {
          await approveShareClaim(item.number, claim);
          notice(`已通过找回申请，「${claim.entryPath.split("/").pop()}」的所有权已重绑给 ${claim.nickname}`);
        } else {
          await approveShareSubmission(item.number);
          notice(`已上架「${item.title}」（CDN 缓存刷新后集市可见）`);
        }
      } else {
        await rejectShareSubmission(item.number, reason);
        notice(`已拒绝「${item.title}」`);
      }
      setShareExpanded(null);
      setShareRejectFor(null);
      setShareRejectReason("");
      await loadShareItems();
    } catch (err) {
      notice(err instanceof Error ? err.message : "操作失败");
    } finally {
      setShareBusy(current => { const next = { ...current }; delete next[item.number]; return next; });
    }
  };

  // ── 用户管理 ──
  const [userQuery, setUserQuery] = useState("");
  const [foundUser, setFoundUser] = useState<FoundUser | null>(null);
  const [userSearched, setUserSearched] = useState(false);
  const [userBusy, setUserBusy] = useState(false);

  const searchUser = async () => {
    const username = userQuery.trim();
    if (!username) return;
    setUserBusy(true);
    try {
      const data = await moderationApi({ action: "findUser", username });
      setFoundUser((data.user as FoundUser | null) ?? null);
      setUserSearched(true);
    } catch (err) {
      notice(err instanceof Error ? err.message : "查询失败");
    } finally {
      setUserBusy(false);
    }
  };

  const toggleBan = async (user: FoundUser) => {
    setUserBusy(true);
    try {
      const banning = user.status !== "disabled";
      await moderationApi({ action: banning ? "banUser" : "unbanUser", userId: user.id });
      notice(banning ? `已封禁 @${user.username}（无法再登录）` : `已解封 @${user.username}`);
      setFoundUser({ ...user, status: banning ? "disabled" : "active" });
    } catch (err) {
      notice(err instanceof Error ? err.message : "操作失败");
    } finally {
      setUserBusy(false);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-card, rgba(255,255,255,.65))",
    border: "1px solid var(--border-soft, rgba(0,0,0,.06))",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 10,
    fontSize: 13,
    lineHeight: 1.6,
  };
  const subStyle: React.CSSProperties = { color: "var(--text-tertiary, #8a8f98)", fontSize: 11.5 };
  const btnStyle: React.CSSProperties = {
    border: "1px solid var(--border-soft, rgba(0,0,0,.1))",
    background: "none",
    borderRadius: 999,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: "inherit",
  };
  const dangerBtn: React.CSSProperties = { ...btnStyle, color: "var(--c-danger, #d9534f)", borderColor: "rgba(217,83,79,.4)" };
  const segStyle = (active: boolean): React.CSSProperties => ({
    ...btnStyle,
    border: "none",
    background: active ? "var(--c-ink, #17181c)" : "var(--surface-inset, rgba(0,0,0,.05))",
    color: active ? "#fff" : "inherit",
  });

  return (
    <div style={{ padding: "4px 2px 24px" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" style={segStyle(tab === "reports")} onClick={() => setTab("reports")}>举报队列</button>
        <button type="button" style={segStyle(tab === "review")} onClick={() => setTab("review")}>应用审核</button>
        <button type="button" style={segStyle(tab === "share")} onClick={() => setTab("share")}>集市审核</button>
        <button type="button" style={segStyle(tab === "users")} onClick={() => setTab("users")}>用户管理</button>
      </div>

      {tab === "reports" ? (
        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
            {(["pending", "resolved", "dismissed"] as const).map(status => (
              <button key={status} type="button" style={segStyle(reportStatus === status)} onClick={() => setReportStatus(status)}>
                {status === "pending" ? "待处理" : status === "resolved" ? "已处理" : "已驳回"}
              </button>
            ))}
            <button type="button" style={{ ...btnStyle, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void loadReports(reportStatus)}>
              <RefreshCw size={12} />刷新
            </button>
          </div>
          {reportsLoading ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> 加载中…</p> : null}
          {!reportsLoading && reports.length === 0 ? <p style={subStyle}>没有{reportStatus === "pending" ? "待处理的" : ""}举报。</p> : null}
          {reports.map(report => (
            <div key={report.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 12.5 }}>[{TYPE_LABELS[report.contentType] ?? report.contentType}] {report.contentOwnerName || "未知作者"}</strong>
                <span style={subStyle}>{new Date(report.createdAt).toLocaleString()}</span>
              </div>
              <div style={{ margin: "4px 0", wordBreak: "break-all" }}>{report.contentPreview || "（无内容摘要）"}</div>
              <div style={subStyle}>举报人：{report.reporterName}{report.reason ? ` · 理由：${report.reason}` : ""}</div>
              {report.status === "pending" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button type="button" style={dangerBtn} disabled={busyIds[report.id]} onClick={() => setConfirmAction({ kind: "takedown", report })}>下架内容</button>
                  {report.contentOwnerId ? (
                    <button type="button" style={dangerBtn} disabled={busyIds[report.id]} onClick={() => setConfirmAction({ kind: "ban", report })}>封禁作者</button>
                  ) : null}
                  <button
                    type="button"
                    style={btnStyle}
                    disabled={busyIds[report.id]}
                    onClick={() => void runReportAction(report, { action: "dismiss", reportId: report.id }, "已驳回举报")}
                  >驳回</button>
                </div>
              ) : (
                <div style={{ ...subStyle, marginTop: 6 }}>
                  <ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {report.resolution || report.status}{report.handledBy ? ` · ${report.handledBy}` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {tab === "review" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={subStyle}>待审核的市场 APP（需环境变量 APP_MARKET_REVIEW_ENABLED=true 开启先审后发）</span>
            <button type="button" style={{ ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void loadReviewItems()}><RefreshCw size={12} />刷新</button>
          </div>
          {reviewLoading ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> 加载中…</p> : null}
          {!reviewLoading && reviewItems.length === 0 ? <p style={subStyle}>没有待审核的 APP。</p> : null}
          {reviewItems.map(item => (
            <div key={item.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{item.name} <span style={subStyle}>v{item.version}</span></strong>
                <span style={subStyle}>{item.authorName}</span>
              </div>
              <div style={{ margin: "4px 0" }}>{item.description || "（无简介）"}</div>
              <div style={subStyle}>权限：{item.permissions.length > 0 ? item.permissions.join(", ") : "无"}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" style={btnStyle} disabled={reviewBusyIds[item.id]} onClick={() => void reviewApp(item, "approve")}>通过</button>
                <button type="button" style={dangerBtn} disabled={reviewBusyIds[item.id]} onClick={() => void reviewApp(item, "reject")}>驳回</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "share" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={subStyle}>待审投稿（通过=上架）与找回申请（通过=所有权重绑，证明材料在「查看内容」里）</span>
            <button type="button" style={{ ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void loadShareItems()}><RefreshCw size={12} />刷新</button>
          </div>
          {canManageRepo ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 12, borderRadius: 12, background: "var(--surface-inset, rgba(0,0,0,.03))" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>自动审核</div>
                <div style={{ ...subStyle, marginTop: 2 }}>
                  开启后新投稿直接上架、不再排队。任何人传的东西都会立刻公开，只能事后下架。
                </div>
              </div>
              {autoApproveBusy
                ? <Loader2 size={16} className="animate-spin" />
                : <Toggle checked={autoApprove} onChange={next => void toggleAutoApprove(next)} />}
            </div>
          ) : null}
          {shareLoading ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> 加载中…</p> : null}
          {!shareLoading && shareItems.length === 0 ? <p style={subStyle}>没有待审核的投稿。</p> : null}
          {shareItems.map(item => {
            const files = shareFiles[item.number];
            const expanded = shareExpanded === item.number;
            return (
              <div key={item.number} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                  <span style={subStyle}>{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                <div style={subStyle}>提交账号：{item.author}</div>
                {item.body ? <div style={{ margin: "4px 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 }}>{item.body}</div> : null}

                {expanded && files === "loading" ? <p style={subStyle}><Loader2 size={13} className="animate-spin" style={{ verticalAlign: -2 }} /> 内容加载中…</p> : null}
                {expanded && Array.isArray(files) ? (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                    {files.map(file => (
                      <div key={file.path} style={{ border: "1px solid var(--border-soft, rgba(0,0,0,.08))", borderRadius: 10, padding: "6px 8px" }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, wordBreak: "break-all" }}>{file.path}</div>
                        {file.imageDataUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={file.imageDataUrl} alt="" style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 6, marginTop: 4 }} />
                        ) : null}
                        {file.textPreview ? (
                          <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, maxHeight: 180, overflowY: "auto", fontFamily: "inherit" }}>{file.textPreview}</pre>
                        ) : null}
                        {file.note ? <div style={subStyle}>{file.note}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {shareRejectFor === item.number ? (
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <input
                      value={shareRejectReason}
                      onChange={event => setShareRejectReason(event.target.value)}
                      placeholder="拒绝理由（可选，投稿人可见）"
                      style={{ flex: 1, minWidth: 0, border: "1px solid var(--border-soft, rgba(0,0,0,.1))", borderRadius: 10, padding: "6px 10px", fontSize: 12, background: "var(--surface-inset, rgba(0,0,0,.03))", color: "inherit", outline: "none" }}
                    />
                    <button type="button" style={dangerBtn} disabled={!!shareBusy[item.number]} onClick={() => void runShareAction(item, "reject", shareRejectReason)}>
                      {shareBusy[item.number] === "reject"
                        ? <><Loader2 size={12} className="animate-spin" style={{ verticalAlign: -2 }} /> 拒绝中…</>
                        : "确认拒绝"}
                    </button>
                    <button type="button" style={btnStyle} onClick={() => { setShareRejectFor(null); setShareRejectReason(""); }}>取消</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button type="button" style={btnStyle} disabled={!!shareBusy[item.number]} onClick={() => void toggleShareDetail(item)}>
                      {expanded ? "收起内容" : "查看内容"}
                    </button>
                    <button type="button" style={btnStyle} disabled={!!shareBusy[item.number]} onClick={() => void runShareAction(item, "approve")}>
                      {shareBusy[item.number] === "approve"
                        ? <><Loader2 size={12} className="animate-spin" style={{ verticalAlign: -2 }} /> 处理中…</>
                        : parseShareClaim(item) ? "通过找回" : "通过并上架"}
                    </button>
                    <button type="button" style={dangerBtn} disabled={!!shareBusy[item.number]} onClick={() => setShareRejectFor(item.number)}>拒绝</button>
                  </div>
                )}
              </div>
            );
          })}
          <p style={{ ...subStyle, marginTop: 8 }}>需在资源集市设置（标题栏 ⚙）配置有仓库写权限的 GitHub Token；权限由 GitHub 服务端校验。</p>
        </div>
      ) : null}

      {tab === "users" ? (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input
              value={userQuery}
              onChange={event => setUserQuery(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") void searchUser(); }}
              placeholder="输入用户名精确查找"
              style={{ flex: 1, minWidth: 0, border: "1px solid var(--border-soft, rgba(0,0,0,.1))", borderRadius: 12, padding: "8px 12px", fontSize: 13, background: "var(--surface-inset, rgba(0,0,0,.03))", color: "inherit", outline: "none" }}
            />
            <button type="button" style={{ ...btnStyle, display: "inline-flex", alignItems: "center", gap: 4 }} disabled={userBusy} onClick={() => void searchUser()}>
              <Search size={13} />查找
            </button>
          </div>
          {userSearched && !foundUser ? <p style={subStyle}>没有找到该用户名。</p> : null}
          {foundUser ? (
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <strong>{foundUser.displayName || foundUser.username}</strong>
                  <div style={subStyle}>@{foundUser.username} · {foundUser.status === "disabled" ? "已封禁" : "正常"}</div>
                </div>
                <button type="button" style={foundUser.status === "disabled" ? btnStyle : dangerBtn} disabled={userBusy} onClick={() => void toggleBan(foundUser)}>
                  {foundUser.status === "disabled" ? "解封" : "封禁"}
                </button>
              </div>
            </div>
          ) : null}
          <p style={{ ...subStyle, marginTop: 8 }}>封禁后该账号无法登录，发布与联机随之失效；解封即恢复。管理员账号不可被封禁。</p>
        </div>
      ) : null}

      {confirmAction ? (
        <ConfirmDialog
          title={confirmAction.kind === "takedown" ? "下架内容" : "封禁作者"}
          message={confirmAction.kind === "takedown"
            ? `确认下架该${TYPE_LABELS[confirmAction.report.contentType] ?? "内容"}？此操作会对所有用户生效。`
            : `确认封禁作者「${confirmAction.report.contentOwnerName || confirmAction.report.contentOwnerId}」？该账号将无法登录。`}
          variant="danger"
          onConfirm={() => {
            const target = confirmAction;
            setConfirmAction(null);
            if (target.kind === "takedown") {
              void runReportAction(target.report, { action: "takedown", reportId: target.report.id }, "已下架并结案");
            } else {
              void runReportAction(target.report, { action: "banUser", userId: target.report.contentOwnerId }, `已封禁 ${target.report.contentOwnerName || "该作者"}`);
            }
          }}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
    </div>
  );
}
