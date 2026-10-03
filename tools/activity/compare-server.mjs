// Serves the Activity's static assets so two builds of its bundle can be compared in a browser.
// Usage: node tools/activity/compare-server.mjs [old-bundle.js|-] [old-styles.css]
// then open http://localhost:4789/compare (page HTML, old vs new bundle) or /compare?styles (computed styles of every element, old vs new CSS).
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const oldBundle = process.argv[2] === undefined || process.argv[2] === "-" ? null : resolve(process.argv[2]);
const oldStyles = process.argv[3] === undefined ? null : resolve(process.argv[3]);
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const comparePage = `<!doctype html><meta charset=utf-8><pre id=out>running</pre><script type="module" src="/compare-page.js"></script>`;

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  const send = (body, type) => { response.writeHead(200, { "Content-Type": type }); response.end(body); };
  if (path === "/compare") return send(comparePage, "text/html");
  if (path === "/compare-page.js") return send(readFileSync(resolve(root, "tools/activity/compare-page.js")), "text/javascript");
  if (path === "/old/" || path === "/new/") {
    const html = readFileSync(resolve(root, "assets/activity/index.html"), "utf8");
    const old = path === "/old/";
    return send(html.replace('src="/activity.js"', `src="/${old && oldBundle !== null ? "old-activity.js" : "activity.js"}"`).replace('href="/styles.css"', `href="/${old && oldStyles !== null ? "old-styles.css" : "styles.css"}"`), "text/html");
  }
  if (path === "/old-styles.css" && oldStyles !== null) return send(readFileSync(oldStyles), "text/css");
  if (path === "/old-activity.js" && oldBundle !== null) return send(readFileSync(oldBundle), "text/javascript");
  const file = path.startsWith("/art-icons/") ? resolve(root, "assets/campaign/icons/svg", path.slice(11))
    : path.startsWith("/icons/") ? resolve(root, "assets/emojis/dnd", path.slice(7))
      : resolve(root, "assets/activity", path.slice(1));
  if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
  let body = readFileSync(file);
  if (path.startsWith("/art-icons/")) body = Buffer.from(body.toString().replace('<path d="M0 0h512v512H0z"/>', ""));
  send(body, types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
}).listen(4789, () => console.log("http://localhost:4789/compare"));
