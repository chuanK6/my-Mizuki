import fs from "node:fs";
import path from "node:path";

const source = path.resolve("local-admin");
const target = path.resolve("dist/admin");

if (fs.existsSync(source)) {
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(source, target, { recursive: true });
	console.log("Copied local-admin to dist/admin");
}
