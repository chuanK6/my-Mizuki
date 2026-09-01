const encoder = new TextEncoder();
const DEFAULT_ADMIN_USERNAME = "s0xu";
const DEFAULT_ADMIN_PASSWORD_HASH = "pbkdf2$100000$C7swkKIj2URzTxVRlCFa+w==$L3mbpyVRwv3qoHBaupAMV7URl9fioA1HhyE+fEGPCRU=";

function json(data, status = 200, headers = {}) {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

function envValue(env, name) {
	const value = env?.[name];
	if (!value) throw new Error(`缺少 Cloudflare Secret: ${name}`);
	return value;
}

function configuredValue(env, name, fallback) {
	return env?.[name] || fallback;
}

function base64(bytes) {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

function fromBase64(value) {
	const text = atob(normalizeBase64(value));
	const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function normalizeBase64(value) {
	const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/").replace(/\s/g, "");
	return normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return result === 0;
}

async function digest(value) {
	return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function verifyPassword(password, encoded) {
	const [kind, iterationsText, saltText, expected] = String(encoded || "").split("$");
	if (kind !== "pbkdf2" || !iterationsText || !saltText || !expected) return false;
	const iterations = Number(iterationsText);
	if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 100000) return false;
	const salt = Uint8Array.from(atob(saltText), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
	return timingSafeEqual(base64(new Uint8Array(bits)), expected);
}

async function signSession(payload, secret) {
	const body = base64(encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + 86_400_000 }))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `${body}.${signature}`;
}

async function verifySignature(body, signature, secret) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const bytes = Uint8Array.from(atob(normalizeBase64(signature)), (char) => char.charCodeAt(0));
	return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(body));
}

async function validSession(request, env) {
	const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)mizuki_admin=([^;]+)/)?.[1];
	if (!token) return false;
	const [body, signature] = token.split(".");
	if (!body || !signature) return false;
	try {
		const decoded = JSON.parse(fromBase64(body));
		return decoded.exp > Date.now() && await verifySignature(body, signature, envValue(env, "SESSION_SECRET"));
	} catch {
		return false;
	}
}

function githubConfig(env) {
	return { token: envValue(env, "GITHUB_TOKEN"), owner: env.GITHUB_OWNER || "chuanK6", repo: env.GITHUB_REPO || "my-Mizuki", branch: env.GITHUB_BRANCH || "master" };
}

async function githubRequest(env, endpoint, options = {}) {
	const config = githubConfig(env);
	const response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repo}${endpoint}`, { ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "mizuki-pages-admin", ...options.headers } });
	if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
	return response.status === 204 ? null : response.json();
}

async function readFile(env, filePath) {
	const config = githubConfig(env);
	const result = await githubRequest(env, `/contents/${filePath}?ref=${encodeURIComponent(config.branch)}`);
	return { sha: result.sha, content: fromBase64(result.content) };
}

async function commitFile(env, filePath, content, message, sha) {
	const config = githubConfig(env);
	const current = sha ? { sha } : await readFile(env, filePath).catch(() => null);
	return githubRequest(env, `/contents/${filePath}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: message || `在线更新 ${filePath}`, content: base64(encoder.encode(content)), branch: config.branch, ...(current?.sha ? { sha: current.sha } : {}) }) });
}

async function deleteFile(env, filePath, message) {
	const config = githubConfig(env);
	const current = await readFile(env, filePath);
	return githubRequest(env, `/contents/${filePath}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: message || `在线删除 ${filePath}`, sha: current.sha, branch: config.branch }) });
}

function parseDataArray(source, marker) {
	const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = source.match(new RegExp(`${escaped}\\s*=\\s*(\\[[\\s\\S]*?\\]);`, "u"));
	if (!match) throw new Error(`无法读取 ${marker}`);
	return { items: JSON.parse(match[1]), start: match.index + match[0].indexOf(match[1]), length: match[1].length };
}

function replaceDataArray(source, parsed, items) {
	return `${source.slice(0, parsed.start)}${JSON.stringify(items, null, 2)}${source.slice(parsed.start + parsed.length)}`;
}

function parsePost(source) {
	if (!source.startsWith("---")) return { data: {}, content: source };
	const end = source.indexOf("\n---", 3);
	if (end < 0) return { data: {}, content: source };
	const data = {};
	for (const line of source.slice(3, end).split(/\r?\n/u)) {
		const match = line.match(/^([\w-]+):\s*(.*)$/u);
		if (!match) continue;
		let value = match[2].trim();
		try { value = JSON.parse(value); } catch { value = value.replace(/^['"]|['"]$/gu, ""); }
		data[match[1]] = value;
	}
	return { data, content: source.slice(end + 4).replace(/^\r?\n/u, "") };
}

function stringifyPost(data, content) {
	const lines = ["---"];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === "") continue;
		lines.push(`${key}: ${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`);
	}
	lines.push("---", "", content || "");
	return lines.join("\n");
}

async function readDataFile(env, filePath, marker) {
	const file = await readFile(env, filePath);
	return { ...file, ...parseDataArray(file.content, marker) };
}

async function writeDataFile(env, filePath, marker, items, message) {
	const file = await readDataFile(env, filePath, marker);
	return commitFile(env, filePath, replaceDataArray(file.content, file, items), message, file.sha);
}

function safePath(value) {
	const path = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
	if (!path || path.includes("..") || !/^[\w./-]+$/u.test(path)) throw new Error("文件路径无效");
	return path;
}

function contentPath(value) {
	const path = safePath(value);
	const allowed = path.startsWith("src/content/posts/") || path === "src/data/diary.ts" || path === "src/data/projects.ts" || /^public\/images\/albums\/[^/]+\/info\.json$/u.test(path);
	if (!allowed) throw new Error("后台只允许修改文章、日记、项目和相册数据");
	return path;
}

async function listPosts(env) {
	const config = githubConfig(env);
	const tree = await githubRequest(env, `/git/trees/${encodeURIComponent(config.branch)}?recursive=1`);
	return (tree.tree || []).filter((entry) => entry.type === "blob" && /^src\/content\/posts\/.*\.(?:md|mdx)$/u.test(entry.path)).map((entry) => ({ id: entry.path.slice("src/content/posts/".length), sha: entry.sha }));
}

export async function onRequest(context) {
	const { request, env, params } = context;
	const action = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");
	try {
		if (request.method === "POST" && action === "login") {
			const body = await request.json();
			if (String(body.username || "") !== configuredValue(env, "ADMIN_USERNAME", DEFAULT_ADMIN_USERNAME) || !(await verifyPassword(String(body.password || ""), configuredValue(env, "ADMIN_PASSWORD_HASH", DEFAULT_ADMIN_PASSWORD_HASH)))) return json({ error: "账号或密码错误" }, 401);
			const token = await signSession({ sub: body.username }, envValue(env, "SESSION_SECRET"));
			return json({ ok: true }, 200, { "cache-control": "no-store", "set-cookie": `mizuki_admin=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict` });
		}
		if (action === "logout") return json({ ok: true }, 200, { "set-cookie": "mizuki_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
		if (action === "session") return json({ authenticated: await validSession(request, env) }, 200, { "cache-control": "no-store" });
		if (!(await validSession(request, env))) return json({ error: "未登录" }, 401);
		if (request.method === "GET" && action === "posts") return json({ posts: (await listPosts(env)).map((post) => ({ ...post, title: post.id, published: "", draft: false, pinned: false, encrypted: false })) });
		if (action === "post") {
			if (request.method === "GET") { const id = safePath(new URL(request.url).searchParams.get("id")); const file = await readFile(env, `src/content/posts/${id}`); const parsed = parsePost(file.content); return json({ id, data: parsed.data, content: parsed.content }); }
			if (request.method === "POST") { const body = await request.json(); const id = safePath(body.id || body.originalId); const path = `src/content/posts/${id.endsWith(".md") || id.endsWith(".mdx") ? id : `${id}.md`}`; const result = await commitFile(env, path, stringifyPost(body.data || {}, String(body.content || "")), `在线更新 ${path}`); return json({ ok: true, id: path.slice("src/content/posts/".length), result }); }
			if (request.method === "DELETE") { const body = await request.json(); return json({ ok: true, result: await deleteFile(env, `src/content/posts/${safePath(body.id)}`, "在线删除文章") }); }
		}
		if (action === "diary") {
			const filePath = "src/data/diary.ts";
			if (request.method === "GET") return json({ items: (await readDataFile(env, filePath, "const diaryData: DiaryItem[]")).items });
			const data = await readDataFile(env, filePath, "const diaryData: DiaryItem[]");
			if (request.method === "POST") { const body = await request.json(); const item = body.item || {}; const normalized = { ...item, id: Number(item.id) || Date.now(), content: String(item.content || ""), date: String(item.date || new Date().toISOString()), tags: Array.isArray(item.tags) ? item.tags : [], images: Array.isArray(item.images) ? item.images : [] }; const items = [...data.items]; const index = items.findIndex((entry) => String(entry.id) === String(normalized.id)); if (index >= 0) items[index] = normalized; else items.push(normalized); return json({ ok: true, item: normalized, result: await writeDataFile(env, filePath, "const diaryData: DiaryItem[]", items, "在线更新日记") }); }
			if (request.method === "DELETE") { const body = await request.json(); const items = data.items.filter((entry) => String(entry.id) !== String(body.id)); return json({ ok: true, result: await writeDataFile(env, filePath, "const diaryData: DiaryItem[]", items, "在线删除日记") }); }
		}
		if (action === "projects") {
			const filePath = "src/data/projects.ts";
			if (request.method === "GET") return json({ items: (await readDataFile(env, filePath, "export const projectsData: Project[]")).items });
			const data = await readDataFile(env, filePath, "export const projectsData: Project[]");
			if (request.method === "POST") { const body = await request.json(); const item = body.item || {}; if (!item.id) throw new Error("项目 ID 不能为空"); const items = [...data.items]; const normalized = { ...item, id: String(item.id) }; const index = items.findIndex((entry) => entry.id === normalized.id); if (index >= 0) items[index] = normalized; else items.push(normalized); return json({ ok: true, item: normalized, result: await writeDataFile(env, filePath, "export const projectsData: Project[]", items, "在线更新项目") }); }
			if (request.method === "DELETE") { const body = await request.json(); const items = data.items.filter((entry) => entry.id !== body.id); return json({ ok: true, result: await writeDataFile(env, filePath, "export const projectsData: Project[]", items, "在线删除项目") }); }
		}
		if (request.method === "GET" && action === "albums") {
			const config = githubConfig(env);
			const result = await githubRequest(env, `/contents/public/images/albums?ref=${encodeURIComponent(config.branch)}`);
			const albums = [];
			for (const entry of (result || []).filter((item) => item.type === "dir")) {
				const path = `public/images/albums/${entry.name}/info.json`;
				try { const file = await readFile(env, path); albums.push({ id: entry.name, ...JSON.parse(file.content), sha: file.sha, path }); } catch { albums.push({ id: entry.name, path }); }
			}
			return json({ items: albums });
		}
		if (action === "albums" && request.method === "POST") {
			const body = await request.json(); const item = body.item || {}; const id = safePath(item.id); if (!/^[\w-]+$/u.test(id)) throw new Error("相册目录 ID 无效");
			const path = `public/images/albums/${id}/info.json`; let existing = {};
			try { existing = JSON.parse((await readFile(env, path)).content); } catch {}
			const info = { ...existing, mode: item.mode === "external" ? "external" : "local", title: String(item.title || id), description: String(item.description || ""), date: String(item.date || new Date().toISOString().slice(0, 10)), location: String(item.location || ""), tags: Array.isArray(item.tags) ? item.tags : [], hidden: item.hidden === true, password: String(item.password || ""), passwordHint: String(item.passwordHint || ""), ...(item.mode === "external" ? { cover: String(item.cover || ""), photos: Array.isArray(item.photos) ? item.photos : [] } : { ...(existing.cover ? { cover: existing.cover } : {}), ...(Array.isArray(existing.images) ? { images: existing.images } : {}) }) };
			const current = await readFile(env, path).catch(() => null); const result = await commitFile(env, path, JSON.stringify(info, null, 2), `在线更新相册 ${id}`, current?.sha); return json({ ok: true, item: { id, ...info }, result });
		}
		if (action === "albums" && request.method === "DELETE") {
			const body = await request.json(); const id = safePath(body.id); const path = `public/images/albums/${id}/info.json`; return json({ ok: true, result: await deleteFile(env, path, `在线删除相册 ${id}`) });
		}
		if (action === "album-image" && request.method === "POST") {
			const body = await request.json(); const id = safePath(body.albumId); const path = `public/images/albums/${id}/info.json`; const file = await readFile(env, path); const info = JSON.parse(file.content); const images = Array.isArray(info.images) ? info.images : []; const image = { id: String(body.id || body.publicId || body.url), name: String(body.name || body.publicId || "image"), publicId: body.publicId || "", deleteToken: body.deleteToken || "", url: String(body.url || ""), cover: body.cover === true }; if (!image.url) throw new Error("图片地址不能为空"); if (image.cover) { for (const old of images) old.cover = false; info.cover = image.url; } const index = images.findIndex((old) => old.id === image.id || old.publicId === image.publicId || old.url === image.url); if (index >= 0) images[index] = { ...images[index], ...image }; else images.push(image); info.images = images; const result = await commitFile(env, path, JSON.stringify(info, null, 2), `在线更新相册图片 ${id}`, file.sha); return json({ ok: true, url: image.url, result });
		}
		if (action === "album-image" && request.method === "DELETE") {
			const body = await request.json(); const id = safePath(body.albumId); const path = `public/images/albums/${id}/info.json`; const file = await readFile(env, path); const info = JSON.parse(file.content); const images = Array.isArray(info.images) ? info.images : []; const next = images.filter((image) => image.name !== body.name && image.id !== body.name && image.publicId !== body.name && image.url !== body.name); if (next.length === images.length) throw new Error("图片不存在"); if (images.length !== next.length && images.find((image) => image.name === body.name && image.cover)) delete info.cover; info.images = next; const result = await commitFile(env, path, JSON.stringify(info, null, 2), `在线删除相册图片 ${id}`, file.sha); return json({ ok: true, result });
		}
		if (request.method === "GET" && action === "file") {
			const path = contentPath(new URL(request.url).searchParams.get("path"));
			return json({ path, ...(await readFile(env, path)) });
		}
		if (request.method === "POST" && action === "file") {
			const body = await request.json();
			const path = contentPath(body.path);
			if (typeof body.content !== "string" || body.content.length > 2_000_000) return json({ error: "内容无效或过大" }, 400);
			return json({ ok: true, result: await commitFile(env, path, body.content, body.message, body.sha) });
		}
		if (request.method === "DELETE" && action === "file") {
			const body = await request.json();
			return json({ ok: true, result: await deleteFile(env, contentPath(body.path), body.message) });
		}
		return json({ error: "接口不存在" }, 404);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "操作失败" }, 400);
	}
}
