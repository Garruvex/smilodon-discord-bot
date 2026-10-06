import { createServer } from "node:http";
import { activityOpenApi } from "../infrastructure/activity/activity-openapi.js";

// This is a separate development server. The Activity origin may be exposed
// through a tunnel, so the reference never binds to that interface.
const host = "127.0.0.1";
const port = Number(process.env.ACTIVITY_DOCS_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("ACTIVITY_DOCS_PORT must be a TCP port");

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>D&D Activity API</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #111722; color: #e9edf5 }
  body { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 5rem }
  h1 { margin-bottom: .3rem } p { color: #b9c6d9; line-height: 1.5 }
  input { box-sizing: border-box; width: 100%; padding: .8rem; margin: 1rem 0; border: 1px solid #596779; border-radius: .5rem; background: #1d2939; color: white }
  details { margin: .6rem 0; padding: .9rem 1rem; border: 1px solid #465265; border-radius: .6rem; background: #1b2533 }
  summary { cursor: pointer; display: flex; align-items: baseline; gap: .8rem; flex-wrap: wrap }
  code, pre { font-family: ui-monospace, monospace } code { color: #b5e0ff }
  .method { min-width: 4.2rem; font-weight: bold; color: #9be7ba }
  .post { color: #ffe29a } .put { color: #a8cbff } .delete { color: #ffa9a9 }
  .group { color: #aebbd0; margin-left: auto }
  pre { overflow: auto; padding: 1rem; border-radius: .4rem; background: #101722; font-size: .85rem }
  a { color: #a8cbff } h2 { margin-top: 2rem }
</style>
<h1>D&D Activity API</h1>
<p>Local reference for the Activity HTTP API. Game operations require an Activity session and still check campaign access. This page does not send game actions.</p>
<p><a href="/openapi.json">Download OpenAPI JSON</a></p>
<input id="search" type="search" placeholder="Search endpoints, actions, and fields" aria-label="Search API">
<main id="catalog"></main>
<script>
fetch("/openapi.json").then(r => r.json()).then(spec => {
  const entries = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })));
  const search = document.querySelector("#search");
  const root = document.querySelector("#catalog");
  const render = () => {
    const term = search.value.toLowerCase().trim();
    root.replaceChildren();
    for (const { path, method, operation } of entries) {
      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      const actions = schema?.oneOf ?? [];
      const haystack = [path, method, operation.summary, ...actions.map(a =>
        [a.title, ...Object.keys(a.properties ?? {})].join(" "))].join(" ").toLowerCase();
      if (term && !haystack.includes(term)) continue;
      const card = document.createElement("details");
      const title = document.createElement("summary");
      const verb = document.createElement("span");
      verb.className = "method " + method;
      verb.textContent = method.toUpperCase();
      const address = document.createElement("code");
      address.textContent = path;
      const group = document.createElement("span");
      group.className = "group";
      group.textContent = operation.tags?.[0] ?? "";
      title.append(verb, address, group);
      card.append(title);
      const description = document.createElement("p");
      description.textContent = operation.summary;
      card.append(description);
      const auth = document.createElement("p");
      auth.textContent = operation.security?.length ? "Auth: Activity session bearer token" : "Auth: public";
      card.append(auth);
      if (schema) {
        const label = document.createElement("h3");
        label.textContent = actions.length ? "Actions (" + actions.length + ")" : "Request body";
        card.append(label);
        const preview = document.createElement("pre");
        preview.textContent = actions.length
          ? actions.map(a => a.title + ": " + Object.entries(a.properties)
              .filter(([name]) => name !== "kind")
              .map(([name, value]) => name + (a.required.includes(name) ? "" : "?") + " (" + (value.enum?.join(" | ") ?? value.type) + ")").join(", ")).join("\n")
          : schema.description ?? JSON.stringify(schema, null, 2);
        card.append(preview);
      }
      root.append(card);
    }
  };
  search.addEventListener("input", render);
  render();
});
</script></html>`;

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end();
    return;
  }
  if (pathname === "/openapi.json") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(activityOpenApi()));
    return;
  }
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    response.end(html);
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(port, host, () => process.stdout.write(`Activity API reference: http://${host}:${port}/\n`));
