import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src/content/posts");
const dateField = /^(published|updated):\s*["'](\d{4}-\d{2}-\d{2})["']\s*$/gmu;

function walk(directory) {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		return entry.isDirectory() ? walk(full) : /\.(?:md|mdx)$/iu.test(entry.name) ? [full] : [];
	});
}

for (const file of walk(root)) {
	const source = fs.readFileSync(file, "utf8");
	const normalized = source.replace(dateField, "$1: $2");
	if (normalized !== source) {
		fs.writeFileSync(file, normalized, "utf8");
		console.log(`Normalized date frontmatter: ${path.relative(process.cwd(), file)}`);
	}
}
