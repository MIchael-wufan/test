#!/usr/bin/env node
/**
 * Vertical Calculation MCP Server
 * 
 * Renders vertical arithmetic (加减乘除竖式) using LaTeX xlop / longdivision packages.
 * Returns a GitHub CDN image URL (uploaded via GitHub Issues image API).
 * 
 * Tools:
 *   - render_addition       加法竖式
 *   - render_subtraction    减法竖式
 *   - render_multiplication 乘法竖式
 *   - render_division       除法竖式（长除法）
 *   - render_expression     自动判断运算类型
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
// Repo used for image hosting via GitHub Issues upload API
const GITHUB_IMAGE_REPO_OWNER = process.env.GITHUB_IMAGE_REPO_OWNER || "MIchael-wufan";
const GITHUB_IMAGE_REPO = process.env.GITHUB_IMAGE_REPO || "test";

// ─── LaTeX Generation ─────────────────────────────────────────────────────────

function generateXlopLatex(
  operator: "add" | "sub" | "mul",
  operand1: number,
  operand2: number
): string {
  const cmdMap = { add: "opadd", sub: "opsub", mul: "opmul" };
  const cmd = cmdMap[operator];
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{xlop}
\\begin{document}
\\${cmd}[style=text]{${operand1}}{${operand2}}
\\end{document}
`;
}

function generateLongDivisionLatex(dividend: number, divisor: number): string {
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\begin{document}
\\longdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

// ─── Rendering Pipeline ───────────────────────────────────────────────────────

interface RenderResult {
  success: boolean;
  pngPath?: string;
  error?: string;
  latex?: string;
}

function renderLatexToPng(latex: string): RenderResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
  const texFile = path.join(tmpDir, "calc.tex");
  const pdfFile = path.join(tmpDir, "calc.pdf");
  const pngFile = path.join(tmpDir, "calc.png");

  try {
    fs.writeFileSync(texFile, latex, "utf-8");

    const pdflatexPath = findExecutable("pdflatex");
    if (!pdflatexPath) {
      return {
        success: false,
        error: "pdflatex not found. Install: apt-get install texlive-full",
        latex,
      };
    }

    const compileResult = spawnSync(
      pdflatexPath,
      ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile],
      { encoding: "utf-8", timeout: 30000 }
    );

    if (compileResult.status !== 0 || !fs.existsSync(pdfFile)) {
      const logFile = path.join(tmpDir, "calc.log");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
      const errorLines = log
        .split("\n")
        .filter((l) => l.startsWith("!") || l.includes("Error"))
        .slice(0, 10)
        .join("\n");
      return { success: false, error: `LaTeX compilation failed:\n${errorLines}`, latex };
    }

    const converted = convertPdfToPng(pdfFile, pngFile);
    if (!converted.success) {
      return { success: false, error: converted.error, latex };
    }

    return { success: true, pngPath: pngFile, latex };
  } catch (err: any) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { success: false, error: err.message, latex };
  }
  // Note: tmpDir is NOT cleaned up here — caller must delete after reading pngPath
}

function convertPdfToPng(
  pdfFile: string,
  pngFile: string
): { success: boolean; error?: string } {
  const convert = findExecutable("convert");
  if (convert) {
    const r = spawnSync(convert, ["-density", "200", "-quality", "95", pdfFile, pngFile], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(pngFile)) return { success: true };
  }

  const magick = findExecutable("magick");
  if (magick) {
    const r = spawnSync(magick, ["convert", "-density", "200", "-quality", "95", pdfFile, pngFile], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(pngFile)) return { success: true };
  }

  const pdftoppm = findExecutable("pdftoppm");
  if (pdftoppm) {
    const ppmBase = pngFile.replace(".png", "");
    const r = spawnSync(pdftoppm, ["-r", "200", "-png", "-singlefile", pdfFile, ppmBase], { timeout: 20000 });
    const src = [ppmBase + ".png", ppmBase + "-1.png"].find(p => fs.existsSync(p));
    if (r.status === 0 && src) { fs.renameSync(src, pngFile); return { success: true }; }
  }

  const gs = findExecutable("gs");
  if (gs) {
    const r = spawnSync(gs, ["-dNOPAUSE", "-dBATCH", "-sDEVICE=pngalpha", "-r200", `-sOutputFile=${pngFile}`, pdfFile], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(pngFile)) return { success: true };
  }

  return { success: false, error: "No PDF-to-PNG converter found. Install: imagemagick, poppler-utils, or ghostscript" };
}

function findExecutable(name: string): string | null {
  try {
    const r = spawnSync("which", [name], { encoding: "utf-8" });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

// ─── GitHub Image Upload ──────────────────────────────────────────────────────

/**
 * Upload a PNG file to GitHub using the Issue image upload API.
 * Returns a public CDN URL (user-images.githubusercontent.com).
 */
async function uploadImageToGitHub(pngPath: string, filename: string): Promise<string> {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN not set. Cannot upload image.");
  }

  const imageBuffer = fs.readFileSync(pngPath);

  return new Promise((resolve, reject) => {
    // Multipart form upload to GitHub
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const CRLF = "\r\n";

    const headerPart = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="asset"; filename="${filename}"${CRLF}` +
      `Content-Type: image/png${CRLF}${CRLF}`
    );
    const footerPart = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const body = Buffer.concat([headerPart, imageBuffer, footerPart]);

    const options = {
      hostname: "github.com",
      path: `/${GITHUB_IMAGE_REPO_OWNER}/${GITHUB_IMAGE_REPO}/upload/policy`,
      method: "POST",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept": "application/json",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "User-Agent": "vertical-calc-mcp/1.0",
        "X-Requested-With": "XMLHttpRequest",
      },
    };

    // Use GitHub's asset upload endpoint (used by Issues editor)
    uploadViaGitHubAssets(imageBuffer, filename).then(resolve).catch(reject);
  });
}

/**
 * Upload image by committing it to the GitHub repo.
 * Returns a raw.githubusercontent.com URL.
 */
async function uploadViaGitHubAssets(imageBuffer: Buffer, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const filepath = `images/${filename}`;
    const contentB64 = imageBuffer.toString("base64");
    const payload = JSON.stringify({
      message: `upload ${filename}`,
      content: contentB64,
      branch: "main",
    });

    const options: https.RequestOptions = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_IMAGE_REPO_OWNER}/${GITHUB_IMAGE_REPO}/contents/${filepath}`,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "vertical-calc-mcp/2.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const url = json?.content?.download_url;
          if (url) resolve(url);
          else reject(new Error(`Upload failed (${res.statusCode}): ${data.slice(0, 200)}`));
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Expression Parser ────────────────────────────────────────────────────────

interface ParsedExpression {
  operator: "add" | "sub" | "mul" | "div";
  operand1: number;
  operand2: number;
}

function parseExpression(expr: string): ParsedExpression | null {
  const normalized = expr
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/");

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([\+\-\*\/])(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const a = parseFloat(match[1]);
  const op = match[2];
  const b = parseFloat(match[3]);

  const opMap: Record<string, "add" | "sub" | "mul" | "div"> = {
    "+": "add", "-": "sub", "*": "mul", "/": "div",
  };
  return { operator: opMap[op], operand1: a, operand2: b };
}

// ─── Tool Handler ─────────────────────────────────────────────────────────────

async function handleRender(
  latex: string,
  expression: string
): Promise<any> {
  const rendered = renderLatexToPng(latex);

  if (!rendered.success || !rendered.pngPath) {
    return {
      content: [{
        type: "text",
        text: `❌ 渲染失败\n\n**表达式**: ${expression}\n**错误**: ${rendered.error}\n\n**LaTeX**:\n\`\`\`latex\n${rendered.latex ?? ""}\n\`\`\``,
      }],
    };
  }

  try {
    const filename = `vcalc_${Date.now()}.png`;
    const imageUrl = await uploadImageToGitHub(rendered.pngPath, filename);

    const imgTag = `<img src="${imageUrl}" alt="竖式计算: ${expression}" style="max-width:400px;" />`;

    return {
      content: [{
        type: "text",
        text: [
          `✅ 竖式计算渲染成功`,
          ``,
          `**表达式**: ${expression}`,
          `**图片链接**: ${imageUrl}`,
          ``,
          `**HTML 标签**:`,
          `\`\`\`html`,
          imgTag,
          `\`\`\``,
        ].join("\n"),
      }],
    };
  } catch (uploadErr: any) {
    // Fallback: return base64 if upload fails
    const imageBuffer = fs.readFileSync(rendered.pngPath);
    const base64 = imageBuffer.toString("base64");
    return {
      content: [
        {
          type: "text",
          text: `⚠️ 图片上传失败（${uploadErr.message}），返回 base64 备用。\n\n**表达式**: ${expression}`,
        },
        {
          type: "image",
          data: base64,
          mimeType: "image/png",
        },
      ],
    };
  } finally {
    // Cleanup temp dir
    try {
      const dir = path.dirname(rendered.pngPath!);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// ─── MCP Server (stdio instance) ─────────────────────────────────────────────

const server = new Server(
  { name: "vertical-calc-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── SSE HTTP Server ──────────────────────────────────────────────────────────

async function startSseServer(port: number) {
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const httpModule = await import("http");

  const transports = new Map<string, any>();

  const httpServer = httpModule.default.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/sse" && req.method === "GET") {
      // SSE connection
      const transport = new SSEServerTransport("/message", res);
      transports.set(transport.sessionId, transport);

      res.on("close", () => {
        transports.delete(transport.sessionId);
      });

      const sseServer = new Server(
        { name: "vertical-calc-mcp", version: "2.0.0" },
        { capabilities: { tools: {} } }
      );
      setupHandlers(sseServer);
      await sseServer.connect(transport);

    } else if (url.pathname === "/message" && req.method === "POST") {
      // Message endpoint
      const sessionId = url.searchParams.get("sessionId") || "";
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      });

    } else if (url.pathname === "/mcp" && req.method === "POST") {
      // StreamableHTTP endpoint — stateless, one request = one MCP session
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const mcpServer = new Server(
            { name: "vertical-calc-mcp", version: "2.0.0" },
            { capabilities: { tools: {} } }
          );
          setupHandlers(mcpServer);
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, JSON.parse(body));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });

    } else if (url.pathname === "/mcp" && req.method === "GET") {
      // StreamableHTTP SSE stream (for servers that support it)
      try {
        const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = new Server(
          { name: "vertical-calc-mcp", version: "2.0.0" },
          { capabilities: { tools: {} } }
        );
        setupHandlers(mcpServer);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }

    } else if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "2.0.0" }));

    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(port, () => {
    console.error(`Vertical Calc MCP Server v2.0 started (SSE) on port ${port}`);
    console.error(`SSE endpoint: http://localhost:${port}/sse`);
  });
}

// ─── Handler Setup (shared between stdio and SSE) ─────────────────────────────

function setupHandlers(srv: Server) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "render_addition",
        description: "渲染加法竖式计算，返回图片 URL 和 HTML img 标签。",
        inputSchema: { type: "object", properties: { addend1: { type: "number", description: "第一个加数" }, addend2: { type: "number", description: "第二个加数" } }, required: ["addend1", "addend2"] },
      },
      {
        name: "render_subtraction",
        description: "渲染减法竖式计算，返回图片 URL 和 HTML img 标签。",
        inputSchema: { type: "object", properties: { minuend: { type: "number", description: "被减数" }, subtrahend: { type: "number", description: "减数" } }, required: ["minuend", "subtrahend"] },
      },
      {
        name: "render_multiplication",
        description: "渲染乘法竖式计算，返回图片 URL 和 HTML img 标签。",
        inputSchema: { type: "object", properties: { multiplicand: { type: "number", description: "被乘数" }, multiplier: { type: "number", description: "乘数" } }, required: ["multiplicand", "multiplier"] },
      },
      {
        name: "render_division",
        description: "渲染除法竖式（长除法），返回图片 URL 和 HTML img 标签。",
        inputSchema: { type: "object", properties: { dividend: { type: "number", description: "被除数" }, divisor: { type: "number", description: "除数（不能为 0）" } }, required: ["dividend", "divisor"] },
      },
      {
        name: "render_expression",
        description: "自动识别算式类型并渲染竖式，返回图片 URL 和 HTML img 标签。支持 + - * × / ÷。例如: '123+456', '12×34', '144÷12'",
        inputSchema: { type: "object", properties: { expression: { type: "string", description: "算式字符串，例如: '123+456', '999-234', '12×34', '144÷12'" } }, required: ["expression"] },
      },
    ],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case "render_addition": {
        const { addend1, addend2 } = args as { addend1: number; addend2: number };
        return handleRender(generateXlopLatex("add", addend1, addend2), `${addend1} + ${addend2}`);
      }
      case "render_subtraction": {
        const { minuend, subtrahend } = args as { minuend: number; subtrahend: number };
        return handleRender(generateXlopLatex("sub", minuend, subtrahend), `${minuend} - ${subtrahend}`);
      }
      case "render_multiplication": {
        const { multiplicand, multiplier } = args as { multiplicand: number; multiplier: number };
        return handleRender(generateXlopLatex("mul", multiplicand, multiplier), `${multiplicand} × ${multiplier}`);
      }
      case "render_division": {
        const { dividend, divisor } = args as { dividend: number; divisor: number };
        if (divisor === 0) return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
        return handleRender(generateLongDivisionLatex(dividend, divisor), `${dividend} ÷ ${divisor}`);
      }
      case "render_expression": {
        const { expression } = args as { expression: string };
        const parsed = parseExpression(expression);
        if (!parsed) return { content: [{ type: "text", text: `❌ 无法解析算式: "${expression}"` }] };
        let latex: string;
        let exprDisplay: string;
        if (parsed.operator === "div") {
          latex = generateLongDivisionLatex(parsed.operand1, parsed.operand2);
          exprDisplay = `${parsed.operand1} ÷ ${parsed.operand2}`;
        } else {
          latex = generateXlopLatex(parsed.operator, parsed.operand1, parsed.operand2);
          const sym = { add: "+", sub: "-", mul: "×" }[parsed.operator];
          exprDisplay = `${parsed.operand1} ${sym} ${parsed.operand2}`;
        }
        return handleRender(latex, exprDisplay);
      }
      default:
        return { content: [{ type: "text", text: `❌ 未知工具: ${name}` }] };
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport_mode = process.env.TRANSPORT || "stdio";
  const port = parseInt(process.env.PORT || "3000", 10);

  if (transport_mode === "sse") {
    await startSseServer(port);
  } else {
    setupHandlers(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Vertical Calc MCP Server v2.0 started (stdio)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
