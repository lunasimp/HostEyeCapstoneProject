const zlib = require("zlib");

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const encoding = String(req.headers["content-encoding"] || "").toLowerCase();
      if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
      resolve(body.toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBodyBytes) {
  const text = await readBody(req, maxBodyBytes);
  return JSON.parse(text);
}

module.exports = {
  readBody,
  readJson,
  sendJson
};
