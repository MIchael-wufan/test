#!/usr/bin/env node
/**
 * Vertical Calculation MCP Server v5.0
 *
 * Tools:
 *   - render_addition         加法竖式 \opadd
 *   - render_subtraction      减法竖式 \opsub
 *   - render_multiplication   乘法竖式 \opmul
 *   - render_division         小数除法 \longdivision
 *   - render_integer_division 整数除法（带余数）\intlongdivision
 *
 * New in v5.0:
 *   - 所有工具支持 verify 参数（验算）
 *   - 小数除法支持 decimalPlaces 参数（保留小数位数）
 *   - 输出首行展示算式结果
 *   - 多图合并为单张 SVG
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

// ─── Math Helpers ─────────────────────────────────────────────────────────────

/** 精确计算，避免浮点误差，返回字符串 */
function calcAdd(a: number, b: number): string {
  const na = Number(a), nb = Number(b);
  const d = Math.max(decimalLen(na), decimalLen(nb));
  return (na + nb).toFixed(d);
}
function calcSub(a: number, b: number): string {
  const na = Number(a), nb = Number(b);
  const d = Math.max(decimalLen(na), decimalLen(nb));
  return (na - nb).toFixed(d);
}
function calcMul(a: number, b: number): string {
  const na = Number(a), nb = Number(b);
  const d = decimalLen(na) + decimalLen(nb);
  return (na * nb).toFixed(d);
}
function decimalLen(n: number): number {
  const s = String(Number(n));
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}
/** 除法结果，精确到 places 位小数，截断（不四舍五入） */
function calcDivTrunc(dividend: number, divisor: number, places: number): string {
  const factor = Math.pow(10, places);
  return (Math.floor((Number(dividend) / Number(divisor)) * factor) / factor).toFixed(places);
}
/** 除法结果，四舍五入到 places 位小数（用于首行展示约等于） */
function calcDivRound(dividend: number, divisor: number, places: number): string {
  return (Number(dividend) / Number(divisor)).toFixed(places);
}
/** 整数除法：商和余数 */
function calcIntDiv(dividend: number, divisor: number): { quotient: number; remainder: number } {
  const nd = Number(dividend), ns = Number(divisor);
  const q = Math.floor(nd / ns);
  const r = nd - q * ns;
  return { quotient: q, remainder: r };
}

// ─── LaTeX Templates ──────────────────────────────────────────────────────────

function latexXlop(cmd: "opadd" | "opsub" | "opmul", a: string, b: string, extraOpset = ""): string {
  const opsetBase = `decimalsepsymbol={.}${extraOpset ? "," + extraOpset : ""}`;
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{xlop}
\\opset{${opsetBase}}
\\begin{document}
\\${cmd}{${a}}{${b}}
\\end{document}
`;
}

function latexDivision(dividend: string, divisor: string, stages?: number): string {
  const keys = stages !== undefined
    ? `separators in work=false,stage=${stages}`
    : `separators in work=false`;
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\longdivisionkeys{${keys}}
\\begin{document}
\\longdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

function latexIntDivision(dividend: string, divisor: string): string {
  return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\longdivisionkeys{separators in work=false}
\\begin{document}
\\intlongdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

/** 渲染一行文字为 SVG（用 standalone + text） */
function latexText(text: string): string {
  // 转义特殊字符
  const escaped = text
    .replace(/≈/g, "$\\approx$")
    .replace(/÷/g, "$\\div$")
    .replace(/×/g, "$\\times$")
    .replace(/……/g, "\\ldots\\ldots");
  return `\\documentclass[border=4pt]{standalone}
\\usepackage{amsmath}
\\begin{document}
\\large ${escaped}
\\end{document}
`;
}

// ─── Render Pipeline ──────────────────────────────────────────────────────────

function renderToSvg(latex: string): { svgPath: string; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
  const texFile = path.join(tmpDir, "calc.tex");
  const pdfFile = path.join(tmpDir, "calc.pdf");
  const svgFile = path.join(tmpDir, "calc.svg");

  fs.writeFileSync(texFile, latex, "utf-8");

  const compile = spawnSync("pdflatex",
    ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile],
    { encoding: "utf-8", timeout: 30000 });

  if (compile.status !== 0 || !fs.existsSync(pdfFile)) {
    const log = fs.existsSync(path.join(tmpDir, "calc.log"))
      ? fs.readFileSync(path.join(tmpDir, "calc.log"), "utf-8") : "";
    const errs = log.split("\n").filter(l => l.startsWith("!")).slice(0, 5).join("\n");
    throw new Error(`pdflatex failed:\n${errs}`);
  }

  // PDF → SVG via pdf2svg
  const r = spawnSync("pdf2svg", [pdfFile, svgFile], { timeout: 15000 });
  if (r.status === 0 && fs.existsSync(svgFile)) {
    return { svgPath: svgFile, tmpDir };
  }

  // Fallback: inkscape
  const ink = spawnSync("inkscape", ["--pdf-poppler", pdfFile, `--export-filename=${svgFile}`], { timeout: 15000 });
  if (ink.status === 0 && fs.existsSync(svgFile)) {
    return { svgPath: svgFile, tmpDir };
  }

  throw new Error("PDF to SVG conversion failed");
}

// ─── SVG Merge ────────────────────────────────────────────────────────────────

interface SvgInfo {
  content: string;
  width: number;
  height: number;
}

function parseSvg(svgPath: string): SvgInfo {
  const content = fs.readFileSync(svgPath, "utf-8");
  const wMatch = content.match(/width="([0-9.]+)pt"/);
  const hMatch = content.match(/height="([0-9.]+)pt"/);
  const w = wMatch ? parseFloat(wMatch[1]) : 100;
  const h = hMatch ? parseFloat(hMatch[1]) : 50;
  return { content, width: w, height: h };
}

/**
 * 把多个 SVG 纵向合并成一张，中间可插入文字标签
 * items: { svgPath?: string; label?: string }[]
 *   svgPath → 插入该 SVG
 *   label   → 插入一行文字（先渲染成 SVG）
 */
function mergeSvgs(items: Array<{ svgPath?: string; label?: string }>, tmpDir: string): string {
  const GAP = 8; // pt，各块间距
  const LABEL_FONT_SIZE = 14;
  const LABEL_HEIGHT = LABEL_FONT_SIZE + 6;

  // 解析所有块的尺寸
  const blocks: Array<{ type: "svg"; info: SvgInfo } | { type: "label"; text: string }> = [];
  for (const item of items) {
    if (item.svgPath) {
      blocks.push({ type: "svg", info: parseSvg(item.svgPath) });
    } else if (item.label) {
      blocks.push({ type: "label", text: item.label });
    }
  }

  // 计算总尺寸：取竖式宽度和首行文字估算宽度的最大值
  const svgWidths = blocks.filter(b => b.type === "svg").map(b => (b as any).info.width as number);
  const labelWidths = blocks.filter(b => b.type === "label").map(b => {
    // 每个字符约 8pt 估算
    return (b as any).text.length * 8;
  });
  const allWidths = [...svgWidths, ...labelWidths];
  const maxWidth = allWidths.length > 0 ? Math.max(...allWidths) : 200;

  let totalHeight = 0;
  for (const b of blocks) {
    totalHeight += b.type === "svg" ? (b as any).info.height : LABEL_HEIGHT;
    totalHeight += GAP;
  }
  totalHeight -= GAP;

  // 生成合并 SVG
  const PT_TO_PX = 1.333;
  const wPx = maxWidth * PT_TO_PX;
  const hPx = totalHeight * PT_TO_PX;

  let innerSvg = "";
  let yOffset = 0;

  for (const b of blocks) {
    if (b.type === "label") {
      const yText = (yOffset + LABEL_HEIGHT * 0.75) * PT_TO_PX;
      innerSvg += `<text x="0" y="${yText.toFixed(2)}" font-family="serif" font-size="${LABEL_FONT_SIZE}" fill="black">${escapeXml(b.text)}</text>\n`;
      yOffset += LABEL_HEIGHT + GAP;
    } else {
      const info = (b as any).info as SvgInfo;
      // 提取 SVG 内部内容（去掉外层 svg 标签，保留 defs + 内容）
      const inner = extractSvgInner(info.content);
      const xOffset = (maxWidth - info.width) / 2; // 居中
      const xPx = xOffset * PT_TO_PX;
      const yPx = yOffset * PT_TO_PX;
      innerSvg += `<g transform="translate(${xPx.toFixed(2)},${yPx.toFixed(2)})">\n${inner}\n</g>\n`;
      yOffset += info.height + GAP;
    }
  }

  const merged = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${wPx.toFixed(2)}" height="${hPx.toFixed(2)}"
     viewBox="0 0 ${wPx.toFixed(2)} ${hPx.toFixed(2)}">
<rect width="100%" height="100%" fill="white"/>
${innerSvg}
</svg>`;

  const outPath = path.join(tmpDir, "merged.svg");
  fs.writeFileSync(outPath, merged, "utf-8");
  return outPath;
}

function extractSvgInner(svgContent: string): string {
  // 提取 <svg ...> 和 </svg> 之间的内容
  const match = svgContent.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return match ? match[1] : svgContent;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── GitHub Upload ────────────────────────────────────────────────────────────

async function uploadToGitHub(svgPath: string): Promise<string> {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
  const filename = `vcalc_${Date.now()}.svg`;
  const content  = fs.readFileSync(svgPath).toString("base64");
  const payload  = JSON.stringify({
    message: `upload ${filename}`,
    content,
    branch: "main",
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/images/${filename}`,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "vertical-calc-mcp/5.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const url = JSON.parse(data)?.content?.download_url;
          url ? resolve(url) : reject(new Error(`Upload failed (${res.statusCode}): ${data.slice(0, 200)}`));
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Core Render & Merge ──────────────────────────────────────────────────────

interface RenderItem {
  latex: string;
  label?: string; // 在这张图前插入的文字标签（如"验算："）
}

interface RenderOptions {
  headerText: string;       // 首行算式文字
  items: RenderItem[];      // 竖式列表（第一个是主竖式，后续是验算）
}

async function renderAndMerge(opts: RenderOptions, display: string): Promise<any> {
  const tmpDirs: string[] = [];
  try {
    const mergeItems: Array<{ svgPath?: string; label?: string }> = [];

    // 1. 首行文字
    mergeItems.push({ label: opts.headerText });

    // 2. 渲染各竖式
    for (const item of opts.items) {
      if (item.label) {
        mergeItems.push({ label: item.label });
      }
      const { svgPath, tmpDir } = renderToSvg(item.latex);
      tmpDirs.push(tmpDir);
      mergeItems.push({ svgPath });
    }

    // 3. 合并 SVG
    const mergeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-merge-"));
    tmpDirs.push(mergeTmpDir);
    const mergedPath = mergeSvgs(mergeItems, mergeTmpDir);

    // 4. 上传
    const url = await uploadToGitHub(mergedPath);
    return { content: [{ type: "text", text: `<br><img src=${url} width=120px><br>` }] };

  } catch (err: any) {
    return { content: [{ type: "text", text: `❌ 渲染失败 [${display}]: ${err.message}` }] };
  } finally {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
}

// ─── MCP Handlers ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "render_addition",
    description: "渲染加法竖式，返回SVG图片HTML。支持验算。",
    inputSchema: {
      type: "object",
      properties: {
        addend1: { type: "number", description: "加数1，如 15.2" },
        addend2: { type: "number", description: "加数2，如 3.84" },
        verify:  { type: "boolean", description: "可选，true 则附加验算过程" },
      },
      required: ["addend1", "addend2"],
    },
  },
  {
    name: "render_subtraction",
    description: "渲染减法竖式，返回SVG图片HTML。支持验算。",
    inputSchema: {
      type: "object",
      properties: {
        minuend:    { type: "number", description: "被减数，如 100.00" },
        subtrahend: { type: "number", description: "减数，如 23.45" },
        verify:     { type: "boolean", description: "可选，true 则附加验算过程" },
      },
      required: ["minuend", "subtrahend"],
    },
  },
  {
    name: "render_multiplication",
    description: "渲染乘法竖式，返回SVG图片HTML。支持验算。",
    inputSchema: {
      type: "object",
      properties: {
        multiplicand: { type: "number", description: "被乘数，如 3.14" },
        multiplier:   { type: "number", description: "乘数，如 2.5" },
        verify:       { type: "boolean", description: "可选，true 则附加验算过程" },
      },
      required: ["multiplicand", "multiplier"],
    },
  },
  {
    name: "render_division",
    description: "渲染小数除法竖式，返回SVG图片HTML。支持验算和保留小数位数。",
    inputSchema: {
      type: "object",
      properties: {
        dividend:      { type: "number", description: "被除数" },
        divisor:       { type: "number", description: "除数（不能为0）" },
        decimalPlaces: { type: "integer", description: "可选，保留小数位数，计算到该位数+1位后截断" },
        verify:        { type: "boolean", description: "可选，true 则附加验算过程" },
      },
      required: ["dividend", "divisor"],
    },
  },
  {
    name: "render_integer_division",
    description: "渲染整数除法竖式（带余数），返回SVG图片HTML。支持验算。",
    inputSchema: {
      type: "object",
      properties: {
        dividend: { type: "integer", description: "被除数（整数）" },
        divisor:  { type: "integer", description: "除数（整数，不能为0）" },
        verify:   { type: "boolean", description: "可选，true 则附加验算过程" },
      },
      required: ["dividend", "divisor"],
    },
  },
];

function setupHandlers(srv: Server) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    const args = a as any;
    const verify = args.verify === true;

    switch (name) {

      case "render_addition": {
        const a1 = args.addend1 as number;
        const a2 = args.addend2 as number;
        const result = calcAdd(a1, a2);
        const header = `${a1} + ${a2} = ${result}`;
        const items: RenderItem[] = [
          { latex: latexXlop("opadd", String(a1), String(a2), "voperator=bottom") },
        ];
        if (verify) {
          // 验算：result - a1 = a2
          items.push({
            label: "验算：",
            latex: latexXlop("opsub", result, String(a1), "voperator=bottom"),
          });
        }
        return renderAndMerge({ headerText: header, items }, `${a1}+${a2}`);
      }

      case "render_subtraction": {
        const m = args.minuend as number;
        const s = args.subtrahend as number;
        const result = calcSub(m, s);
        const header = `${m} - ${s} = ${result}`;
        const items: RenderItem[] = [
          { latex: latexXlop("opsub", String(m), String(s), "voperator=bottom") },
        ];
        if (verify) {
          // 验算：result + s = m
          items.push({
            label: "验算：",
            latex: latexXlop("opadd", result, String(s), "voperator=bottom"),
          });
        }
        return renderAndMerge({ headerText: header, items }, `${m}-${s}`);
      }

      case "render_multiplication": {
        const mc = args.multiplicand as number;
        const mr = args.multiplier as number;
        const result = calcMul(mc, mr);
        const header = `${mc} × ${mr} = ${result}`;
        const items: RenderItem[] = [
          { latex: latexXlop("opmul", String(mc), String(mr), "voperator=bottom") },
        ];
        if (verify) {
          // 验算：result ÷ mr = mc
          items.push({
            label: "验算：",
            latex: latexDivision(result, String(mr)),
          });
        }
        return renderAndMerge({ headerText: header, items }, `${mc}×${mr}`);
      }

      case "render_division": {
        if (args.divisor === 0) return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
        const dend = args.dividend as number;
        const dsor = args.divisor as number;
        const places = args.decimalPlaces as number | undefined;

        let header: string;
        let stages: number | undefined;

        if (places !== undefined) {
          // 保留 places 位，计算到 places+1 位截断
          const truncResult = calcDivTrunc(dend, dsor, places);
          const roundResult = calcDivRound(dend, dsor, places);
          header = `${dend} ÷ ${dsor} ≈ ${roundResult}`;
          // stage = 商的整数位数 + places + 1（多算1位用于截断）
          const quotientIntDigits = String(Math.floor(Number(dend) / Number(dsor))).length;
          stages = quotientIntDigits + places + 1;
        } else {
          const result = (dend / dsor);
          const d = decimalLen(dend / dsor) || 2;
          header = `${dend} ÷ ${dsor} = ${result.toFixed(d)}`;
        }

        const items: RenderItem[] = [
          { latex: latexDivision(String(dend), String(dsor), stages) },
        ];
        if (verify) {
          // 验算：商 × 除数 = 被除数
          const quotient = places !== undefined
            ? calcDivTrunc(dend, dsor, places)
            : (dend / dsor).toFixed(2);
          items.push({
            label: "验算：",
            latex: latexXlop("opmul", quotient, String(dsor), "voperator=bottom"),
          });
        }
        return renderAndMerge({ headerText: header, items }, `${dend}÷${dsor}`);
      }

      case "render_integer_division": {
        if (args.divisor === 0) return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
        const dend = args.dividend as number;
        const dsor = args.divisor as number;
        const { quotient, remainder } = calcIntDiv(dend, dsor);
        const header = remainder === 0
          ? `${dend} ÷ ${dsor} = ${quotient}`
          : `${dend} ÷ ${dsor} = ${quotient}……${remainder}`;
        const items: RenderItem[] = [
          { latex: latexIntDivision(String(dend), String(dsor)) },
        ];
        if (verify) {
          if (remainder === 0) {
            // 验算：商 × 除数 = 被除数
            items.push({
              label: "验算：",
              latex: latexXlop("opmul", String(quotient), String(dsor), "voperator=bottom"),
            });
          } else {
            // 验算：商 × 除数 + 余数 = 被除数，分两步
            // 第一步：商 × 除数
            const step1 = quotient * dsor;
            items.push({
              label: "验算：",
              latex: latexXlop("opmul", String(quotient), String(dsor), "voperator=bottom"),
            });
            // 第二步：step1 + 余数
            items.push({
              latex: latexXlop("opadd", String(step1), String(remainder), "voperator=bottom"),
            });
          }
        }
        return renderAndMerge({ headerText: header, items }, `${dend}÷${dsor}(整除)`);
      }

      default:
        return { content: [{ type: "text", text: `❌ 未知工具: ${name}` }] };
    }
  });
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────

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
      res.end(JSON.stringify({ status: "ok", version: "5.0.0" }));

    } else if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/message", res);
      sseTransports.set(transport.sessionId, transport);
      res.on("close", () => sseTransports.delete(transport.sessionId));
      const srv = new Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
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
          const srv = new Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
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
    console.error(`Vertical Calc MCP Server v5.0 started on port ${port}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.env.TRANSPORT || "stdio";
  const port = parseInt(process.env.PORT || "3000", 10);
  if (mode === "sse") {
    await startHttpServer(port);
  } else {
    const srv = new Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
    setupHandlers(srv);
    await srv.connect(new StdioServerTransport());
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
