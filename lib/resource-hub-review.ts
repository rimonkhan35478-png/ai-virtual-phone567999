// lib/resource-hub-review.ts
// 资源集市审核（管理中心用）：把 share 仓库的待审投稿（open PR）拉下来，
// 在应用内预览与通过/拒绝。前端直连 GitHub API，权限由 GitHub 服务端裁决——
// token 没有仓库写权限时合并/关闭会被 403，界面伪造无意义。

import { loadResourceHubSource, purgeShareIndexCache } from "./resource-hub-client";
import { loadUploadConfig } from "./resource-hub-upload";

const GH_API = "https://api.github.com";
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;
const TEXT_PREVIEW_MAX = 1500;

export type ShareSubmission = {
    number: number;
    title: string;
    body: string;
    author: string;
    createdAt: string;
};

export type ShareSubmissionFile = {
    path: string;
    size: number;
    /** 图片：data URL 直接预览 */
    imageDataUrl?: string;
    /** 文本：截断预览 */
    textPreview?: string;
    /** 太大或无法解码时的占位说明 */
    note?: string;
};

function getReviewAuth(): { token: string; owner: string; repo: string } {
    const token = loadUploadConfig().githubToken.trim();
    if (!token) throw new Error("请先在资源集市设置（标题栏 ⚙）里填入你的 GitHub Token");
    const source = loadResourceHubSource();
    return { token, owner: source.owner, repo: source.repo };
}

async function gh<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url.startsWith("http") ? url : `${GH_API}${url}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = (data as { message?: string })?.message || `GitHub API ${res.status}`;
        throw new Error(res.status === 403 || res.status === 404 ? `没有权限或投稿不存在（${message}）` : message);
    }
    return data as T;
}

function decodeBase64Utf8(b64: string): string {
    const clean = b64.replace(/\s/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
}

export async function listShareSubmissions(): Promise<ShareSubmission[]> {
    const { token, owner, repo } = getReviewAuth();
    const pulls = await gh<Array<{
        number: number; title: string; body?: string | null;
        user?: { login?: string } | null; created_at: string;
    }>>(token, "GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
    return pulls.map(pr => ({
        number: pr.number,
        title: (pr.title || "").replace(/^投稿[:：]\s*/, ""),
        body: pr.body || "",
        author: pr.user?.login || "unknown",
        createdAt: pr.created_at,
    }));
}

export async function fetchShareSubmissionFiles(prNumber: number): Promise<ShareSubmissionFile[]> {
    const { token, owner, repo } = getReviewAuth();
    const files = await gh<Array<{ filename: string; contents_url: string; status: string }>>(
        token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);

    const result: ShareSubmissionFile[] = [];
    for (const file of files.filter(f => f.status !== "removed")) {
        const entry: ShareSubmissionFile = { path: file.filename, size: 0 };
        try {
            const blob = await gh<{ content?: string; encoding?: string; size?: number }>(token, "GET", file.contents_url);
            entry.size = blob.size ?? 0;
            if (blob.encoding === "base64" && blob.content) {
                if (IMAGE_EXT_RE.test(file.filename)) {
                    const ext = file.filename.split(".").pop()!.toLowerCase().replace("jpg", "jpeg");
                    entry.imageDataUrl = `data:image/${ext};base64,${blob.content.replace(/\s/g, "")}`;
                } else {
                    const text = decodeBase64Utf8(blob.content);
                    entry.textPreview = text.slice(0, TEXT_PREVIEW_MAX) + (text.length > TEXT_PREVIEW_MAX ? "\n…（已截断）" : "");
                }
            } else {
                entry.note = `文件较大（${Math.round(entry.size / 1024)}KB），请到 GitHub 查看`;
            }
        } catch {
            entry.note = "内容预览失败";
        }
        result.push(entry);
    }
    return result;
}

// ── 自动审核开关 ──
// 开关存在资源仓库的 _config.json 里：写它需要仓库写权限，所以"只有仓库
// 所有者能开"是 GitHub 服务端在裁决，前端伪造管理员身份没有任何用。

const CONFIG_FILE = "_config.json";

/** 当前 token 对资源仓库有没有写权限（决定要不要显示自动审核开关） */
export async function canManageShareRepo(): Promise<boolean> {
    try {
        const { token, owner, repo } = getReviewAuth();
        const info = await gh<{ permissions?: { push?: boolean } }>(token, "GET", `/repos/${owner}/${repo}`);
        return info.permissions?.push === true;
    } catch {
        return false;
    }
}

export async function fetchAutoApprove(): Promise<boolean> {
    const { token, owner, repo } = getReviewAuth();
    try {
        const file = await gh<{ content?: string }>(token, "GET", `/repos/${owner}/${repo}/contents/${CONFIG_FILE}`);
        const cfg = JSON.parse(decodeBase64Utf8(file.content || "")) as { autoApprove?: boolean };
        return cfg?.autoApprove === true;
    } catch {
        // 没配置过/读不到，一律按关闭处理
        return false;
    }
}

/** 写开关。没有仓库写权限的人会被 GitHub 挡在 403。 */
export async function setAutoApprove(enabled: boolean): Promise<void> {
    const { token, owner, repo } = getReviewAuth();
    let sha: string | undefined;
    let current: Record<string, unknown> = {};
    try {
        const file = await gh<{ sha?: string; content?: string }>(token, "GET", `/repos/${owner}/${repo}/contents/${CONFIG_FILE}`);
        sha = file.sha;
        current = JSON.parse(decodeBase64Utf8(file.content || "")) as Record<string, unknown>;
    } catch { /* 首次写入 */ }
    const body = JSON.stringify({ ...current, autoApprove: enabled }, null, 2);
    const content = btoa(unescape(encodeURIComponent(body)));
    await gh(token, "PUT", `/repos/${owner}/${repo}/contents/${CONFIG_FILE}`, {
        // 带 [skip-index] 免得为一个开关白跑一次索引重建
        message: `${enabled ? "开启" : "关闭"}自动审核 [skip-index]`,
        content,
        ...(sha ? { sha } : {}),
    });
}

/** 通过并上架（合并 PR），并强刷索引的 CDN 缓存让新资源尽快可见。 */
/**
 * 审完顺手删掉 PR 的头分支（submit/claim 这类机器人开的临时分支）。
 * GitHub 的"自动删分支"只覆盖合并的 PR，关闭的不管；这里统一兜底。
 * 尽力而为：分支已删/权限不够都不影响审核结果本身。
 */
async function deletePrHeadBranch(prNumber: number): Promise<void> {
    try {
        const { token, owner, repo } = getReviewAuth();
        const pr = await gh<{ head?: { ref?: string; repo?: { full_name?: string } } }>(
            token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
        const ref = pr.head?.ref || "";
        // 只删本仓库内、机器人临时分支形态的头分支；跨仓 PR / main 一律不碰
        if (pr.head?.repo?.full_name !== `${owner}/${repo}`) return;
        if (!/^(submit|claim)\//.test(ref)) return;
        await gh(token, "DELETE", `/repos/${owner}/${repo}/git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`);
    } catch { /* 尽力而为 */ }
}

export async function approveShareSubmission(prNumber: number): Promise<void> {
    const { token, owner, repo } = getReviewAuth();
    await gh(token, "PUT", `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, { merge_method: "merge" });
    await deletePrHeadBranch(prNumber);
    // 索引由资源仓库的 Actions 在合并后重建（约 1 分钟），这里先把 CDN 缓存清掉
    setTimeout(() => purgeShareIndexCache(loadResourceHubSource()), 90_000);
    purgeShareIndexCache(loadResourceHubSource());
}

/**
 * 管理员删除已上架资源（下架）：递归删除该路径下的所有文件并直接提交默认分支。
 * 需要有仓库写权限的 token；普通用户 token 会被 GitHub 403。
 */
export async function deleteShareEntry(entryPath: string): Promise<void> {
    const { token, owner, repo } = getReviewAuth();
    const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");

    const removeFile = async (path: string, sha: string) => {
        await gh(token, "DELETE", `/repos/${owner}/${repo}/contents/${encode(path)}`, {
            message: `下架：${path}`,
            sha,
        });
    };

    const removePath = async (path: string): Promise<void> => {
        const info = await gh<Array<{ path: string; sha: string; type: string }> | { path: string; sha: string; type: string }>(
            token, "GET", `/repos/${owner}/${repo}/contents/${encode(path)}`);
        if (Array.isArray(info)) {
            for (const item of info) {
                if (item.type === "dir") await removePath(item.path);
                else await removeFile(item.path, item.sha);
            }
        } else {
            await removeFile(info.path, info.sha);
        }
    };

    await removePath(entryPath);
}

/** 拒绝（关闭 PR，可选留言让投稿人看到理由）。 */
export async function rejectShareSubmission(prNumber: number, reason?: string): Promise<void> {
    const { token, owner, repo } = getReviewAuth();
    const trimmed = reason?.trim();
    if (trimmed) {
        await gh(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body: `审核未通过：${trimmed}` });
    }
    await gh(token, "PATCH", `/repos/${owner}/${repo}/pulls/${prNumber}`, { state: "closed" });
    await deletePrHeadBranch(prNumber);
}

// ── 找回作品申请（特殊 PR：分支上只有证明材料，审核=改写 .owner，绝不合并）──

export const SHARE_CLAIM_TITLE_PREFIX = "【找回申请】";

export type ShareClaimInfo = {
    entryPath: string;
    ownerHash: string;
    nickname: string;
    /** 证明材料在私有保管库里的编号与仓库（早期申请可能没有） */
    claimId?: string;
    vaultRepo?: string;
};

/** 从投稿列表里识别找回申请并解析元数据；不是找回申请返回 null */
export function parseShareClaim(submission: ShareSubmission): ShareClaimInfo | null {
    if (!submission.title.startsWith(SHARE_CLAIM_TITLE_PREFIX)) return null;
    // 资源标题里常有空格，必须取整行（\S+ 会在第一个空格截断，曾写错过路径）
    const entryPath = submission.body.match(/^资源路径[:：]\s*(.+?)\s*$/m)?.[1];
    const ownerHash = submission.body.match(/^新钥匙指纹[:：]\s*([0-9a-f]{64})/m)?.[1];
    const nickname = submission.body.match(/^申请人[:：]\s*(.+)$/m)?.[1]?.trim() || "匿名";
    const claimId = submission.body.match(/^申请编号[:：]\s*(\S+)/m)?.[1];
    const vaultRepo = submission.body.match(/^证明仓库[:：]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/m)?.[1];
    return entryPath && ownerHash ? { entryPath, ownerHash, nickname, claimId, vaultRepo } : null;
}

/**
 * 读取找回申请的证明材料：存在私有保管库里，只有管理员的 token 打得开。
 * 早期申请（证明直接放在 PR 分支上）没有保管库信息，回落到读 PR 文件。
 */
export async function fetchClaimProofFiles(prNumber: number, claim: ShareClaimInfo): Promise<ShareSubmissionFile[]> {
    if (!claim.claimId || !claim.vaultRepo) return fetchShareSubmissionFiles(prNumber);
    const { token } = getReviewAuth();
    const [vaultOwner, vaultRepo] = claim.vaultRepo.split("/");
    const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");
    const dir = `找回申请/${claim.claimId}`;
    const listing = await gh<Array<{ path: string; name: string; size: number; type: string }>>(
        token, "GET", `/repos/${vaultOwner}/${vaultRepo}/contents/${encode(dir)}`);
    const result: ShareSubmissionFile[] = [];
    for (const item of listing.filter(f => f.type === "file")) {
        const entry: ShareSubmissionFile = { path: item.name, size: item.size };
        try {
            const blob = await gh<{ content?: string; encoding?: string }>(
                token, "GET", `/repos/${vaultOwner}/${vaultRepo}/contents/${encode(item.path)}`);
            if (blob.encoding === "base64" && blob.content) {
                if (IMAGE_EXT_RE.test(item.name)) {
                    const ext = item.name.split(".").pop()!.toLowerCase().replace("jpg", "jpeg");
                    entry.imageDataUrl = `data:image/${ext};base64,${blob.content.replace(/\s/g, "")}`;
                } else {
                    const text = decodeBase64Utf8(blob.content);
                    entry.textPreview = text.slice(0, TEXT_PREVIEW_MAX) + (text.length > TEXT_PREVIEW_MAX ? "\n…（已截断）" : "");
                }
            } else {
                entry.note = `文件较大（${Math.round(item.size / 1024)}KB），请到保管库仓库查看`;
            }
        } catch {
            entry.note = "内容预览失败";
        }
        result.push(entry);
    }
    return result;
}

/**
 * 通过找回：用管理员 token 把该资源的 .owner 改写成申请人的钥匙指纹，
 * 然后关闭申请 PR（证明材料永不进入 main）。索引重建后申请人设备自动认领回资源。
 */
export async function approveShareClaim(prNumber: number, claim: ShareClaimInfo): Promise<void> {
    const { token, owner, repo } = getReviewAuth();
    const encode = (p: string) => p.split("/").map(encodeURIComponent).join("/");
    const ownerFile = `${claim.entryPath}/.owner`;
    let sha: string | undefined;
    try {
        const info = await gh<{ sha?: string }>(token, "GET", `/repos/${owner}/${repo}/contents/${encode(ownerFile)}`);
        sha = info.sha;
    } catch { /* 老资源可能没有 .owner，直接新建 */ }
    await gh(token, "PUT", `/repos/${owner}/${repo}/contents/${encode(ownerFile)}`, {
        message: `找回作品：${claim.entryPath} 所有权重绑（申请 #${prNumber}）`,
        content: btoa(claim.ownerHash),
        ...(sha ? { sha } : {}),
    });
    // 留言只是善意通知，token 缺 Issues 权限时不能拖垮整个通过流程
    try {
        await gh(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
            body: "✅ 找回申请已通过，作品所有权已绑定到申请人的摊主钥匙。索引重建后（约 1 分钟）在原设备打开资源集市即可恢复管理权限。",
        });
    } catch { /* 尽力而为 */ }
    await gh(token, "PATCH", `/repos/${owner}/${repo}/pulls/${prNumber}`, { state: "closed" });
    await deletePrHeadBranch(prNumber);
    // 索引由 Actions 在 .owner 提交后重建，先清一次 CDN 缓存，稍后再清一次兜底
    setTimeout(() => purgeShareIndexCache(loadResourceHubSource()), 90_000);
    purgeShareIndexCache(loadResourceHubSource());
}
