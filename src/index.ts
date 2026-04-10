#!/usr/bin/env node
/**
 * Vertical Calculation MCP Server v3.0
 *
 * Tools:
 *   - render_expression  自动识别 +/-/×/÷ 渲染竖式，返回图片 URL
 *
 * LaTeX packages:
 *   - xlop  (加减乘: \opadd \opsub \opmul)
 *   - longdivision (除: \longdivision)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO_OWNER   = process.env.GITHUB_IMAGE_REPO_OWNER || "MIchael-wufan";
const REPO_NAME    = process.env.GITHUB_IMAGE_REPO || "test";

// ─── LaTeX Templates ──────────────────────────────────────────────────────────

function latexXlop(cmd: "opadd" | "opsub" | "opmul", a: string, b: string): string {
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{xlop}
\\opset{decimalsepsymbol={.}}
\\begin{document}
\\${cmd}{${a}}{${b}}
\\end{document}
`;
}

function latexDivision(dividend: string, divisor: string): string {
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\begin{document}
\\longdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

function latexIntDivision(dividend: string, divisor: string): string {
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\begin{document}
\\intlongdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

// ─── Expression Parser ────────────────────────────────────────────────────────

type Op = "add" | "sub" | "mul" | "div";

function parseExpr(expr: string): { op: Op; a: string; b: string } | null {
  const s = expr.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  const m = s.match(/^(-?\d+(?:\.\d+)?)([\+\-\*\/])(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const opMap: Record<string, Op> = { "+": "add", "-": "sub", "*": "mul", "/": "div" };
  return { op: opMap[m[2]], a: m[1], b: m[3] };
}

// ─── Render Pipeline ──────────────────────────────────────────────────────────

function renderToPng(latex: string): { pngPath: string; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
  const texFile = path.join(tmpDir, "calc.tex");
  const pdfFile = path.join(tmpDir, "calc.pdf");
  const pngFile = path.join(tmpDir, "calc.png");

  fs.writeFileSync(texFile, latex, "utf-8");

  const pdflatex = spawnSync("pdflatex", ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile],
    { encoding: "utf-8", timeout: 30000 });

  if (pdflatex.status !== 0 || !fs.existsSync(pdfFile)) {
    const log = fs.existsSync(path.join(tmpDir, "calc.log"))
      ? fs.readFileSync(path.join(tmpDir, "calc.log"), "utf-8") : "";
    const errs = log.split("\n").filter(l => l.startsWith("!")).slice(0, 5).join("\n");
    throw new Error(`pdflatex failed:\n${errs}`);
  }

  // PDF → PNG via pdftoppm (poppler)
  const base = pngFile.replace(".png", "");
  const r = spawnSync("pdftoppm", ["-r", "200", "-png", "-singlefile", pdfFile, base], { timeout: 15000 });
  const src = [base + ".png", base + "-1.png"].find(p => fs.existsSync(p));
  if (r.status === 0 && src) {
    fs.renameSync(src, pngFile);
    return { pngPath: pngFile, tmpDir };
  }

  // Fallback: ghostscript
  const gs = spawnSync("gs", ["-dNOPAUSE", "-dBATCH", "-sDEVICE=pngalpha", "-r200",
    `-sOutputFile=${pngFile}`, pdfFile], { timeout: 15000 });
  if (gs.status === 0 && fs.existsSync(pngFile)) return { pngPath: pngFile, tmpDir };

  throw new Error("PDF to PNG conversion failed (no pdftoppm or gs)");
}

// ─── GitHub Upload ────────────────────────────────────────────────────────────

async function uploadToGitHub(pngPath: string): Promise<string> {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");

  const filename = `vcalc_${Date.now()}.png`;
  const filepath = `images/${filename}`;
  const content  = fs.readFileSync(pngPath).toString("base64");
  const payload  = JSON.stringify({ message: `upload ${filename}`, content, branch: "main" });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filepath}`,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "vertical-calc-mcp/3.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        const json = JSON.parse(data);
        const url = json?.content?.download_url;
        url ? resolve(url) : reject(new Error(`Upload failed (${res.statusCode}): ${data.slice(0, 200)}`));
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Tool Handler ─────────────────────────────────────────────────────────────

async function handleExpression(expression: string): Promise<any> {
  const parsed = parseExpr(expression);
  if (!parsed) {
    return { content: [{ type: "text", text: `❌ 无法解析算式: "${expression}"\n支持格式: 123+456, 100-23, 12×3, 144÷12` }] };
  }

  const { op, a, b } = parsed;
  const symMap = { add: "+", sub: "-", mul: "×", div: "÷" };
  const display = `${a} ${symMap[op]} ${b}`;

  let latex: string;
  if (op === "div") {
    latex = latexDivision(a, b);
  } else {
    const cmdMap = { add: "opadd", sub: "opsub", mul: "opmul" } as const;
    latex = latexXlop(cmdMap[op], a, b);
  }

  return renderAndUpload(latex, display);
}

async function handleIntDivision(dividend: string, divisor: string): Promise<any> {
  const display = `${dividend} ÷ ${divisor} (整除)`;
  return renderAndUpload(latexIntDivision(dividend, divisor), display);
}

async function renderAndUpload(latex: string, display: string): Promise<any> {
  let tmpDir: string | undefined;
  try {
    const result = renderToPng(latex);
    tmpDir = result.tmpDir;
    const imageUrl = await uploadToGitHub(result.pngPath);
    return {
      content: [{
        type: "text",
        text: `✅ 竖式渲染成功\n\n表达式: ${display}\n图片链接: ${imageUrl}\n\nHTML:\n<img src="${imageUrl}" alt="${display}" />`,
      }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `❌ 渲染失败\n\n表达式: ${display}\n错误: ${err.message}` }],
    };
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── MCP Server Setup ─────────────────────────────────────────────────────────

function setupHandlers(srv: Server) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_expression",
        description: "渲染竖式计算图片，支持加(+)减(-)乘(×/*)小数除(÷/)，返回图片URL。示例: '15.2+3.84', '100-23.45', '3.14×2.5', '144÷12'",
        inputSchema: {
          type: "object",
          properties: {
            expression: { type: "string", description: "算式字符串，如 '123+456'、'3.14×2.5'、'144÷12'" },
          },
          required: ["expression"],
        },
      },
      {
        name: "render_integer_division",
        description: "渲染整数除法竖式（带余数），使用 \\intlongdivision，适合整除场景。示例: 107÷12=8余11",
        inputSchema: {
          type: "object",
          properties: {
            dividend: { type: "integer", description: "被除数（整数）" },
            divisor:  { type: "integer", description: "除数（整数，不能为0）" },
          },
          required: ["dividend", "divisor"],
        },
      },
    ],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "render_expression") {
      return handleExpression((args as any).expression);
    }
    if (name === "render_integer_division") {
      const { dividend, divisor } = args as { dividend: number; divisor: number };
      if (divisor === 0) return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
      return handleIntDivision(String(dividend), String(divisor));
    }
    return { content: [{ type: "text", text: `❌ 未知工具: ${name}` }] };
  });
}

// ─── HTTP Server (SSE + StreamableHTTP) ───────────────────────────────────────

async function startHttpServer(port: number) {
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { default: http } = await import("http");

  const sseTransports = new Map<string, any>();

  http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "3.0.0" }));

    } else if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/message", res);
      sseTransports.set(transport.sessionId, transport);
      res.on("close", () => sseTransports.delete(transport.sessionId));
      const srv = new Server({ name: "vertical-calc-mcp", version: "3.0.0" }, { capabilities: { tools: {} } });
      setupHandlers(srv);
      await srv.connect(transport);

    } else if (url.pathname === "/message" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const transport = sseTransports.get(sessionId);
      if (!transport) { res.writeHead(404); res.end(JSON.stringify({ error: "Session not found" })); return; }
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => transport.handlePostMessage(req, res, JSON.parse(body)));

    } else if (url.pathname === "/mcp") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", async () => {
        try {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const srv = new Server({ name: "vertical-calc-mcp", version: "3.0.0" }, { capabilities: { tools: {} } });
          setupHandlers(srv);
          await srv.connect(transport);
          await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
        } catch (e: any) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });

    } else {
      res.writeHead(404); res.end("Not found");
    }
  }).listen(port, () => {
    console.error(`Vertical Calc MCP Server v3.0 started (SSE+Streamable) on port ${port}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.env.TRANSPORT || "stdio";
  const port = parseInt(process.env.PORT || "3000", 10);

  if (mode === "sse") {
    await startHttpServer(port);
  } else {
    const srv = new Server({ name: "vertical-calc-mcp", version: "3.0.0" }, { capabilities: { tools: {} } });
    setupHandlers(srv);
    await srv.connect(new StdioServerTransport());
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
