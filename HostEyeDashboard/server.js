import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve("public");
const port = Number.parseInt(process.env.PORT || "5174", 10);
const apiTarget = process.env.HOSTEYE_API_TARGET || "http://127.0.0.1:5055";
const allowedPublicHost = String(process.env.HOSTEYE_PUBLIC_HOST || "").trim().toLowerCase();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (!isAllowedHost(req.headers.host)) {
    res.writeHead(421, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Misdirected request");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    proxyApi(req, res, url);
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Not found");
    return;
  }

  res.writeHead(200, securityHeaders({
    "content-type": types[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "pragma": "no-cache",
    "expires": "0",
  }));
  createReadStream(filePath).pipe(res);
}).listen(port, () => {
  console.log(`HostEye Dashboard running at http://localhost:${port}`);
  console.log(`Proxying /api to ${apiTarget}`);
});

function proxyApi(req, res, url) {
  const target = new URL(`${url.pathname}${url.search}`, apiTarget);
  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, securityHeaders(proxyRes.headers));
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, securityHeaders({ "content-type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({ error: "Dashboard API proxy failed", detail: error.message }));
  });

  req.pipe(proxyReq);
}

function isAllowedHost(value) {
  const hostname = String(value || "").split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "host.docker.internal"
    || Boolean(allowedPublicHost && hostname === allowedPublicHost);
}

function securityHeaders(headers = {}) {
  return {
    ...headers,
    "content-security-policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
