import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { uploadImage } from "../lib/admin-r2.mjs";

const root = path.resolve(import.meta.dirname, "..");
const browserPath = process.env.ADMIN_TEST_BROWSER || [
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"/usr/bin/chromium", "/usr/bin/google-chrome",
].find((file) => fs.existsSync(file));
const pluginPath = path.join(root, "scripts/admin-vite-plugin.mjs");

test("editor previews and all four R2 upload flows work in the browser", {
	skip: !browserPath || !fs.existsSync(pluginPath), timeout: 60000,
}, async () => {
	const cache = path.join(root, "cache");
	fs.mkdirSync(cache, { recursive: true });
	const fixture = fs.mkdtempSync(path.join(cache, "admin-browser-fixture-"));
	const originalCwd = process.cwd();
	const write = (file, content) => {
		const target = path.join(fixture, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	const imageContent = '# 图片测试\n\n图片前的文字\n\n![Markdown image](/images/pixel.svg)\n\n<br>\n<br />\n\n<img src="/images/pixel.svg" alt="HTML image">\n\n图片后的文字\n';
	const resumeContent = '# 个人简历\n\n' + '## 工作与学习\n\n这是一段用于验证长文章布局的内容。\n\n'.repeat(35) + '<div align="center">\n\n### Keep Learning\n\n</div>\n';
	fs.cpSync(path.join(root, "local-admin"), path.join(fixture, "local-admin"), { recursive: true });
	for (const [name, content] of [["image", imageContent], ["resume", resumeContent]]) {
		write(`src/content/posts/${name}.md`, `---\ntitle: ${name}\npublished: 2026-10-05\n---\n${content}`);
	}
	write("src/data/diary.ts", "const diaryData: DiaryItem[] = [];\n\n// 获取日记列表\n");
	write("src/data/projects.ts", "export const projectsData: Project[] = [];\n\n// Get project statistics\n");
	const uploads = [];
	const r2Env = { R2_PUBLIC_URL: "https://images.example.test", R2_BUCKET: { async put(key, bytes) { uploads.push({ key, size: bytes.length }); } } };
	let server, browser, socket, stopTimer;
	try {
		process.chdir(fixture);
		const { default: createPlugin } = await import(pathToFileURL(pluginPath));
		let middleware;
		createPlugin().configureServer({ middlewares: { use(handler) { middleware = handler; } } });
		server = http.createServer((req, res) => {
			if (req.url === "/api/admin/upload/") {
				const request = new Request(`http://${req.headers.host}${req.url}`, { method: "POST", headers: req.headers, body: Readable.toWeb(req), duplex: "half" });
				void uploadImage(request, r2Env).then((image) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, ...image })); }).catch((error) => { res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message })); });
				return;
			}
			return middleware(req, res, () => {
			if (req.url === "/images/pixel.svg") {
				res.setHeader("Content-Type", "image/svg+xml");
				res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#5264db"/></svg>');
			} else { res.writeHead(404); res.end(); }
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${server.address().port}`;
		browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${path.join(fixture, "browser-profile")}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		stopTimer = setTimeout(() => { socket?.close(); browser.kill(); }, 55000);
		const debuggerUrl = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Browser launch timed out")), 15000);
			browser.once("error", (error) => { clearTimeout(timer); reject(error); });
			browser.stderr.on("data", (chunk) => {
				const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/u);
				if (match) { clearTimeout(timer); resolve(match[1]); }
			});
		});
		const pages = await (await fetch(`http://127.0.0.1:${new URL(debuggerUrl).port}/json/list`)).json();
		socket = new WebSocket(pages.find((entry) => entry.type === "page").webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		let id = 0, acceptDialog = false, dialogs = 0;
		const pending = new Map(), errors = [];
		const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
			const key = ++id;
			const timer = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 8000);
			pending.set(key, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
			socket.send(JSON.stringify({ id: key, method, params, sessionId }));
		});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (pending.has(message.id)) {
				const task = pending.get(message.id); pending.delete(message.id);
				message.error ? task.reject(message.error) : task.resolve(message.result);
			}
			if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
			if (message.method === "Page.javascriptDialogOpening") {
				dialogs++;
				void send("Page.handleJavaScriptDialog", { accept: acceptDialog }).catch((error) => errors.push(error));
			}
		});
		const evaluate = async (expression, sessionId) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
			assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
			return result.result.value;
		};
		const waitFor = async (callback) => {
			for (let attempt = 0; attempt < 80; attempt++) {
				if (await callback()) return;
				await new Promise((resolve) => setTimeout(resolve, 75));
			}
			assert.fail("Browser state did not become ready");
		};
		const inspectPreview = async () => {
			let sessionId;
			await waitFor(async () => {
				const { targetInfos } = await send("Target.getTargets");
				const target = targetInfos.find((info) => info.type === "iframe");
				if (!target) return false;
				({ sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
				return true;
			});
			await waitFor(() => evaluate('document.readyState === "complete" && document.body.getBoundingClientRect().width > 0', sessionId));
			return evaluate('({text:document.body.innerText,height:document.body.getBoundingClientRect().height,scroll:document.scrollingElement.scrollTop,images:[...document.images].map(img=>({loaded:img.complete && img.naturalWidth>0,src:img.getAttribute("src")}))})', sessionId);
		};
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
		await send("Page.navigate", { url: origin + "/admin/" });
		await waitFor(() => evaluate('!document.body.classList.contains("auth-locked") && document.querySelectorAll(".post-item").length === 2'));
		await evaluate('loadPost("image.md")');
		assert.equal(await evaluate("editorMode"), "rich");
		assert.equal(await evaluate('$("mode-rich").disabled'), false);
		await evaluate("editor.moveCursorToEnd(true); editor.focus();");
		await send("Input.insertText", { text: " 浏览器输入的修改" });
		await waitFor(() => evaluate("richDirty"));
		assert.match(await evaluate("getArticleContent()"), /浏览器输入的修改/u);
		await evaluate("savePost()");
		assert.match(await evaluate("getArticleContent()"), /浏览器输入的修改/u);
		assert.equal(dialogs, 0, "ordinary images and line breaks must not require conversion");
		await evaluate('$("mode-preview").click(); $("preview-panel").scrollIntoView({block:"center"});');
		let preview = await inspectPreview();
		assert.match(preview.text, /浏览器输入的修改/u);
		assert.equal(preview.images.length, 2);
		assert.ok(preview.images.every((image) => image.loaded), "both Markdown and HTML images must load");
		for (let attempt = 0; attempt < 3; attempt++) {
			await evaluate('loadPost("resume.md")');
			await evaluate('$("mode-preview").click(); $("preview-panel").scrollIntoView({block:"center"});');
			preview = await inspectPreview();
			assert.match(preview.text, /个人简历/u);
			assert.ok(preview.height > 1000, "long article must have a rendered layout, not an empty frame");
			assert.equal(preview.scroll, 0);
			await evaluate('$("mode-source").click(); $("mode-preview").click();');
			preview = await inspectPreview();
			assert.ok(preview.height > 1000);
			await evaluate('loadPost("image.md");');
			await evaluate('$("mode-preview").click();');
			assert.equal((await inspectPreview()).images.length, 2);
		}
		await evaluate('loadPost("resume.md")');
		await evaluate('$("mode-rich").click()');
		assert.equal(await evaluate("editorMode"), "source", "declining conversion keeps the source");
		acceptDialog = true;
		await evaluate('$("mode-rich").click()');
		assert.equal(await evaluate("editorMode"), "rich");
		assert.equal(await evaluate("getArticleContent()"), resumeContent, "viewing rich text must not alter original HTML");
		await evaluate("editor.moveCursorToEnd(true); editor.focus();");
		await send("Input.insertText", { text: " 简历补充内容" });
		await waitFor(() => evaluate("richDirty"));
		await evaluate("savePost()");
		assert.match(await evaluate("getArticleContent()"), /简历补充内容/u);
		await evaluate(`window.testUpload = new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="), c => c.charCodeAt(0))], "same-name.png", {type:"image/png"}); window.chooseUpload = (id, count=1) => { const transfer = new DataTransfer(); for (let i=0;i<count;i++) transfer.items.add(window.testUpload); $(id).files = transfer.files; };`);
		await evaluate('resetForm(); editor.options.hooks.addImageBlobHook(window.testUpload, (url, alt) => { window.articleUploadUrl=url; editor.exec("addImage", {imageUrl:url, altText:alt}); });');
		await waitFor(() => evaluate('Boolean(window.articleUploadUrl)'));
		assert.match(await evaluate("editor.getMarkdown()"), /https:\/\/images\.example\.test\/boke\/posts\//u);
		await evaluate('switchModule("diary"); loadDiary();');
		await evaluate('chooseUpload("diary-upload"); uploadDiaryImages();');
		await waitFor(() => evaluate('$("diary-images").value.includes("/boke/diary/")'));
		await evaluate('$("diary-content").value="R2 日记测试"; saveDiary();');
		await waitFor(() => evaluate('diaryItems.length === 1'));
		assert.match(await evaluate('diaryItems[0].images[0]'), /\/boke\/diary\//u);
		await evaluate('switchModule("projects"); loadProjects();');
		await evaluate('chooseUpload("project-upload"); uploadProjectImage();');
		await waitFor(() => evaluate('$("project-image").value.includes("/boke/projects/")'));
		await evaluate('$("project-id").value="r2-project"; $("project-title").value="R2 项目"; $("project-description").value="封面测试"; saveProject();');
		await waitFor(() => evaluate('projectItems.length === 1'));
		assert.match(await evaluate('projectItems[0].image'), /\/boke\/projects\//u);
		await evaluate('switchModule("albums"); loadAlbums();');
		await evaluate('$("album-id").value="r2-album"; $("album-title").value="R2 相册"; saveAlbum();');
		await waitFor(() => evaluate('albumCurrent === "r2-album"'));
		await evaluate('chooseUpload("album-upload", 2); uploadAlbumImages();');
		await waitFor(() => evaluate('albumItems[0]?.images.length === 2'));
		assert.equal(await evaluate('albumItems[0].images[0].storage'), "r2");
		assert.notEqual(await evaluate('albumItems[0].images[0].key'), await evaluate('albumItems[0].images[1].key'));
		await evaluate('setAlbumCover(albumItems[0].images[1].id)');
		assert.equal(await evaluate('albumItems[0].cover === albumItems[0].images[1].url'), true);
		await evaluate('deleteAlbumImage(albumItems[0].images[0].id)');
		assert.equal(await evaluate('albumItems[0].images.length'), 1);
		assert.equal(uploads.length, 5);
		assert.ok(uploads.every((image) => image.size > 0));
		assert.deepEqual(errors, []);
	} finally {
		clearTimeout(stopTimer);
		socket?.close();
		if (browser && browser.exitCode === null) {
			const exited = new Promise((resolve) => browser.once("exit", resolve));
			browser.kill();
			await exited;
		}
		server?.closeAllConnections();
		if (server) await new Promise((resolve) => server.close(resolve));
		process.chdir(originalCwd);
		assert.equal(path.dirname(path.resolve(fixture)), path.resolve(cache));
		assert.ok(path.basename(fixture).startsWith("admin-browser-fixture-"));
		fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
