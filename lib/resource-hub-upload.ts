// lib/resource-hub-upload.ts
// 资源集市上传：
//  A) GitHub Token 直传 —— 有仓库写权限的 token 直接提交 main（立即上架）；
//     普通用户 token 自动 fork + 开 PR（待管理员审核）。浏览器直连 api.github.com（支持 CORS）。
//  B) 免账号代传 —— POST 到独立部署的上传服务（share 仓库里的 Netlify Function），
//     由机器人 token 代开 PR。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { ensureIdentityKey } from "./resource-hub-identity";
import { RESOURCE_ROOT } from "./resource-hub-client";
import { markAssetImageName, type ResourceHubSource } from "./resource-hub-types";

const UPLOAD_CFG_KEY = "ai_phone_resource_hub_upload_cfg_v1";
const MY_UPLOADS_KEY = "ai_phone_resource_hub_my_uploads_v1";
registerKvMigration(UPLOAD_CFG_KEY);
registerKvMigration(MY_UPLOADS_KEY);

export const DEFAULT_UPLOAD_ENDPOINT = "https://floatshare.netlify.app/.netlify/functions/upload";

export type ResourceHubUploadConfig = {
    /** 方案 A：用户自己的 GitHub token（可选） */
    githubToken: string;
    /** 方案 B：上传服务地址 */
    endpoint: string;
};

export function loadUploadConfig(): ResourceHubUploadConfig {
    try {
        const raw = kvGet(UPLOAD_CFG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ResourceHubUploadConfig>;
            return {
                githubToken: typeof parsed.githubToken === "string" ? parsed.githubToken : "",
                endpoint: typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint : DEFAULT_UPLOAD_ENDPOINT,
            };
        }
    } catch { /* fall through */ }
    return { githubToken: "", endpoint: DEFAULT_UPLOAD_ENDPOINT };
}

export function saveUploadConfig(config: ResourceHubUploadConfig): void {
    kvSet(UPLOAD_CFG_KEY, JSON.stringify({
        githubToken: config.githubToken.trim(),
        endpoint: config.endpoint.trim() || DEFAULT_UPLOAD_ENDPOINT,
    }));
}

export type UploadPayloadFile = { name: string; contentBase64: string };

export type UploadPayload = {
    folder: string;
    name: string;
    author: string;
    description: string;
    /** 资源本体 + 图片，函数侧不区分（图片靠扩展名被索引识别） */
    files: UploadPayloadFile[];
    /** 作者头像（64×64 PNG 的纯 base64），可选 */
    avatarBase64?: string;
};

/** 作者编辑已上架资源的载荷（路径不变，只改内容） */
export type EditPayload = {
    /** 标题（可带贴纸/排版标记） */
    title: string;
    author: string;
    description: string;
    avatarBase64?: string;
    /** 新增或覆盖的文件（同名即覆盖） */
    addFiles: UploadPayloadFile[];
    /** 要删掉的文件（传仓库路径或文件名都行） */
    removeFiles: string[];
};

export type UploadResult = {
    /** merged=true 表示已直接进 main（立即上架）；否则为待审核 PR */
    merged: boolean;
    prUrl?: string;
};

// ── 我的上传记录（含自助删除凭证，只存在本机）──

export type MyUploadRecord = {
    /** 仓库内路径：资源/<分类>/<资源名> */
    path: string;
    name: string;
    /** 自助删除凭证（哈希已随投稿写进仓库 .owner，凭证本体只在本机） */
    ownerKey: string;
    uploadedAt: string;
};

export function loadMyUploads(): MyUploadRecord[] {
    try {
        const raw = kvGet(MY_UPLOADS_KEY);
        const parsed = raw ? JSON.parse(raw) as MyUploadRecord[] : [];
        return Array.isArray(parsed) ? parsed.filter(r => r && typeof r.path === "string" && typeof r.ownerKey === "string") : [];
    } catch { return []; }
}

function saveMyUploads(records: MyUploadRecord[]): void {
    kvSet(MY_UPLOADS_KEY, JSON.stringify(records.slice(0, 200)));
}

function recordMyUpload(record: MyUploadRecord): void {
    saveMyUploads([record, ...loadMyUploads().filter(r => r.path !== record.path)]);
}

export function removeMyUploadRecord(path: string): void {
    saveMyUploads(loadMyUploads().filter(r => r.path !== path));
}

// ── 找回作品：丢了摊主钥匙的作者提交证明材料，管理员人工审核 ──

export type OwnershipClaimInput = {
    endpoint: string;
    /** 仓库内路径：资源/<分类>/<资源名> */
    path: string;
    name: string;
    /** 申请人当前摊主钥匙的指纹（审核通过后 .owner 会绑到它） */
    ownerHash: string;
    nickname: string;
    note: string;
    files: UploadPayloadFile[];
};

/** 提交找回申请：中转函数把证明材料开成申请 PR，等管理员在管理中心裁决 */
export async function submitOwnershipClaim(input: OwnershipClaimInput): Promise<{ prNumber: number; prUrl: string }> {
    const res = await fetch(input.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            action: "claim",
            path: input.path,
            name: input.name,
            ownerHash: input.ownerHash,
            nickname: input.nickname,
            note: input.note,
            files: input.files,
        }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; prNumber?: number; prUrl?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    return { prNumber: data.prNumber || 0, prUrl: data.prUrl || "" };
}

// 发布用的钥匙 = 本机「摊主钥匙」。以前是一个资源一把随机钥匙，换设备就全丢；
// 现在全部资源共用一把，导出这一行短码就能在新设备上认领回所有发布。
function generateOwnerKey(): Promise<string> {
    return ensureIdentityKey();
}

/** 导入钥匙时把早期的单资源凭证并进本机记录（同路径以已有的为准） */
export function mergeMyUploads(records: MyUploadRecord[]): void {
    const existing = loadMyUploads();
    const known = new Set(existing.map(r => r.path));
    saveMyUploads([...existing, ...records.filter(r => !known.has(r.path))]);
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 选中的文件 → 上传条目。
 * asset=true 表示投稿人是从「选择资源文件」进来的：如果它是图片，加上 .asset 标记，
 * 索引才知道这张图是资源本体（PNG 角色卡、表情包），而不是配图。
 */
export async function fileToUploadEntry(file: File, options?: { asset?: boolean }): Promise<UploadPayloadFile> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const name = options?.asset ? markAssetImageName(file.name) : file.name;
    return { name, contentBase64: btoa(binary) };
}

// ── 方案 B：上传服务 ──

export async function uploadViaService(endpoint: string, payload: UploadPayload): Promise<UploadResult> {
    const ownerKey = await generateOwnerKey();
    const ownerKeyHash = await sha256Hex(ownerKey);
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ownerKeyHash }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; prUrl?: string; path?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `上传服务返回 HTTP ${res.status}`);
    }
    recordMyUpload({
        // 服务端会把标题安全化成文件夹名，以它返回的真实路径为准，
        // 否则本机凭证记录会对不上，日后删不掉也改不了
        path: data.path || `${RESOURCE_ROOT}/${payload.folder}/${payload.name}`,
        name: payload.name,
        ownerKey,
        uploadedAt: new Date().toISOString(),
    });
    return { merged: false, prUrl: data.prUrl };
}

/** 作者自助编辑（免账号路径）：凭本机凭证请求上传服务改内容。 */
export async function editViaService(endpoint: string, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", path: record.path, ownerKey: record.ownerKey, ...payload }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `编辑服务返回 HTTP ${res.status}`);
    }
    // 标题可能改了，本机记录跟着更新
    saveMyUploads(loadMyUploads().map(r => (r.path === record.path ? { ...r, name: payload.title || r.name } : r)));
}

/** 投稿者自助下架：把本机保存的删除凭证发给上传服务比对后删除。 */
export async function ownerDeleteViaService(endpoint: string, record: MyUploadRecord): Promise<void> {
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: record.path, ownerKey: record.ownerKey }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `删除服务返回 HTTP ${res.status}`);
    }
    removeMyUploadRecord(record.path);
}

// ── 方案 A：GitHub Token 直传 ──

const GH_API = "https://api.github.com";

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GH_API}${path}`, {
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
        throw new Error(message);
    }
    return data as T;
}

function encodeContentPath(dir: string, file: string): string {
    return `${dir.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(file)}`;
}

/** 标题 → 安全的文件夹名（与上传服务的规则保持一致） */
export function safeSegment(value: string): string {
    return value.trim()
        .replace(/[\\/:*?"<>|#%\x00-\x1f]/g, "")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 60);
}

export async function uploadViaToken(token: string, source: ResourceHubSource, payload: UploadPayload): Promise<UploadResult> {
    const { owner, repo, branch } = source;
    const dirName = safeSegment(payload.name);
    const dir = `${RESOURCE_ROOT}/${payload.folder}/${dirName}`;
    const ownerKey = await generateOwnerKey();
    const toWrite: UploadPayloadFile[] = [...payload.files];
    if (payload.description.trim()) {
        toWrite.push({
            name: "说明.txt",
            contentBase64: btoa(unescape(encodeURIComponent(payload.description.trim()))),
        });
    }
    // 删除凭证哈希写进资源文件夹，凭证本体只留在本机
    toWrite.push({ name: ".owner", contentBase64: btoa(await sha256Hex(ownerKey)) });
    // 投稿人写进 .author，索引带上后详情页展示
    if (payload.author.trim()) {
        toWrite.push({ name: ".author", contentBase64: btoa(unescape(encodeURIComponent(payload.author.trim()))) });
    }
    // 原始标题（可能带贴纸标记，与安全化后的文件夹名不同）
    if (payload.name.trim() && payload.name.trim() !== dirName) {
        toWrite.push({ name: ".title", contentBase64: btoa(unescape(encodeURIComponent(payload.name.trim()))) });
    }
    if (payload.avatarBase64) {
        toWrite.push({ name: ".avatar.png", contentBase64: payload.avatarBase64 });
    }

    // 有写权限（仓库主/协作者）→ 直接提交默认分支，立即上架
    const repoInfo = await gh<{ permissions?: { push?: boolean } }>(token, "GET", `/repos/${owner}/${repo}`);
    if (repoInfo.permissions?.push) {
        for (const file of toWrite) {
            await gh(token, "PUT", `/repos/${owner}/${repo}/contents/${encodeContentPath(dir, file.name)}`, {
                message: `上架：${dir}/${file.name}`,
                content: file.contentBase64,
                branch,
            });
        }
        recordMyUpload({ path: dir, name: payload.name, ownerKey, uploadedAt: new Date().toISOString() });
        return { merged: true };
    }

    // 普通用户 → fork + 分支提交 + 跨仓库 PR
    const me = await gh<{ login: string }>(token, "GET", "/user");
    const fork = await gh<{ full_name: string; default_branch: string }>(token, "POST", `/repos/${owner}/${repo}/forks`, {});
    const [forkOwner, forkRepo] = fork.full_name.split("/");

    // fork 是异步创建的，轮询等它就绪
    let forkReady = false;
    for (let i = 0; i < 10; i++) {
        try {
            await gh(token, "GET", `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${fork.default_branch || branch}`);
            forkReady = true;
            break;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
    if (!forkReady) throw new Error("fork 创建超时，请稍后重试");

    const baseRef = await gh<{ object: { sha: string } }>(token, "GET", `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${fork.default_branch || branch}`);
    const submitBranch = `submit-${Date.now().toString(36)}`;
    await gh(token, "POST", `/repos/${forkOwner}/${forkRepo}/git/refs`, {
        ref: `refs/heads/${submitBranch}`,
        sha: baseRef.object.sha,
    });
    for (const file of toWrite) {
        await gh(token, "PUT", `/repos/${forkOwner}/${forkRepo}/contents/${encodeContentPath(dir, file.name)}`, {
            message: `投稿：${dir}/${file.name}`,
            content: file.contentBase64,
            branch: submitBranch,
        });
    }
    const pr = await gh<{ html_url: string }>(token, "POST", `/repos/${owner}/${repo}/pulls`, {
        title: `投稿：${dir}`,
        head: `${me.login}:${submitBranch}`,
        base: branch,
        body: `来自资源集市 App 的投稿。\n\n- 分类：${payload.folder}\n- 名称：${payload.name}\n- 投稿人：${payload.author || me.login}${payload.description.trim() ? `\n\n${payload.description.trim()}` : ""}`,
    });
    recordMyUpload({ path: dir, name: payload.name, ownerKey, uploadedAt: new Date().toISOString() });
    return { merged: false, prUrl: pr.html_url };
}

/** 作者编辑（Token 直传路径）：直接改仓库里的文件。 */
export async function editViaToken(token: string, source: ResourceHubSource, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const { owner, repo, branch } = source;
    const dirName = record.path.split("/")[2] || "";

    const shaOf = async (path: string): Promise<string> => {
        try {
            const info = await gh<{ sha?: string }>(token, "GET", `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
            return info.sha || "";
        } catch { return ""; }
    };
    const put = async (name: string, contentBase64: string) => {
        const target = `${record.path}/${name}`;
        const sha = await shaOf(target);
        await gh(token, "PUT", `/repos/${owner}/${repo}/contents/${encodeContentPath(record.path, name)}`, {
            message: `编辑：${target}`, content: contentBase64, branch, ...(sha ? { sha } : {}),
        });
    };
    const remove = async (name: string) => {
        const target = `${record.path}/${name}`;
        const sha = await shaOf(target);
        if (!sha) return;
        await gh(token, "DELETE", `/repos/${owner}/${repo}/contents/${encodeContentPath(record.path, name)}`, {
            message: `编辑：删除 ${target}`, sha, branch,
        });
    };

    for (const raw of payload.removeFiles) {
        const name = raw.split("/").pop() || "";
        if (name && !name.startsWith(".")) await remove(name);
    }
    for (const file of payload.addFiles) await put(file.name, file.contentBase64);

    const title = payload.title.trim();
    const fields: Array<{ name: string; value: string }> = [
        { name: ".title", value: title && title !== dirName ? title : "" },
        { name: "说明.txt", value: payload.description.trim() },
        { name: ".author", value: payload.author.trim() },
    ];
    for (const field of fields) {
        if (field.value) await put(field.name, btoa(unescape(encodeURIComponent(field.value))));
        else await remove(field.name);
    }
    if (payload.avatarBase64) await put(".avatar.png", payload.avatarBase64);

    saveMyUploads(loadMyUploads().map(r => (r.path === record.path ? { ...r, name: title || r.name } : r)));
}

/** 统一入口：配了 token 走直传，否则走上传服务。 */
export async function uploadResource(source: ResourceHubSource, payload: UploadPayload): Promise<UploadResult> {
    const config = loadUploadConfig();
    if (config.githubToken.trim()) {
        return uploadViaToken(config.githubToken.trim(), source, payload);
    }
    return uploadViaService(config.endpoint, payload);
}

/** 统一编辑入口：同上，token 优先。 */
export async function editResource(source: ResourceHubSource, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const config = loadUploadConfig();
    if (config.githubToken.trim()) {
        return editViaToken(config.githubToken.trim(), source, record, payload);
    }
    return editViaService(config.endpoint, record, payload);
}
