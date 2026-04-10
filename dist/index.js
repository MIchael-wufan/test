#!/usr/bin/env node
"use strict";
/**
 * Vertical Calculation MCP Server v4.0
 *
 * Tools:
 *   - render_addition         加法竖式 \opadd
 *   - render_subtraction      减法竖式 \opsub
 *   - render_multiplication   乘法竖式 \opmul
 *   - render_division         小数除法 \longdivision
 *   - render_integer_division 整数除法（带余数）\intlongdivision
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const https = __importStar(require("https"));
// ─── Config ───────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO_OWNER = process.env.GITHUB_IMAGE_REPO_OWNER || "MIchael-wufan";
const REPO_NAME = process.env.GITHUB_IMAGE_REPO || "test";
// ─── LaTeX Templates ──────────────────────────────────────────────────────────
function latexXlop(cmd, a, b) {
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{xlop}
\\opset{decimalsepsymbol={.}}
\\begin{document}
\\${cmd}{${a}}{${b}}
\\end{document}
`;
}
function latexDivision(dividend, divisor) {
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\begin{document}
\\longdivision{${dividend}}{${divisor}}
\\end{document}
`;
}
function latexIntDivision(dividend, divisor) {
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\begin{document}
\\intlongdivision{${dividend}}{${divisor}}
\\end{document}
`;
}
// ─── Render Pipeline ──────────────────────────────────────────────────────────
function renderToPng(latex) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
    const texFile = path.join(tmpDir, "calc.tex");
    const pdfFile = path.join(tmpDir, "calc.pdf");
    const pngFile = path.join(tmpDir, "calc.png");
    fs.writeFileSync(texFile, latex, "utf-8");
    const compile = (0, child_process_1.spawnSync)("pdflatex", ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile], { encoding: "utf-8", timeout: 30000 });
    if (compile.status !== 0 || !fs.existsSync(pdfFile)) {
        const log = fs.existsSync(path.join(tmpDir, "calc.log"))
            ? fs.readFileSync(path.join(tmpDir, "calc.log"), "utf-8") : "";
        const errs = log.split("\n").filter(l => l.startsWith("!")).slice(0, 5).join("\n");
        throw new Error(`pdflatex failed:\n${errs}`);
    }
    // PDF → PNG: transparent background, tight crop via pdftoppm
    const base = pngFile.replace(".png", "");
    const r = (0, child_process_1.spawnSync)("pdftoppm", ["-r", "200", "-png", "-singlefile", "-transparent", pdfFile, base], { timeout: 15000 });
    const src = [base + ".png", base + "-1.png"].find(p => fs.existsSync(p));
    if (r.status === 0 && src) {
        fs.renameSync(src, pngFile);
        return { pngPath: pngFile, tmpDir };
    }
    // Fallback: ghostscript with pngalpha (transparent)
    const gs = (0, child_process_1.spawnSync)("gs", ["-dNOPAUSE", "-dBATCH", "-sDEVICE=pngalpha", "-r200",
        `-sOutputFile=${pngFile}`, pdfFile], { timeout: 15000 });
    if (gs.status === 0 && fs.existsSync(pngFile))
        return { pngPath: pngFile, tmpDir };
    throw new Error("PDF to PNG conversion failed");
}
// ─── GitHub Upload ────────────────────────────────────────────────────────────
async function uploadToGitHub(pngPath) {
    if (!GITHUB_TOKEN)
        throw new Error("GITHUB_TOKEN not set");
    const filename = `vcalc_${Date.now()}.png`;
    const content = fs.readFileSync(pngPath).toString("base64");
    const payload = JSON.stringify({
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
                "User-Agent": "vertical-calc-mcp/4.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const url = JSON.parse(data)?.content?.download_url;
                    url ? resolve(url) : reject(new Error(`Upload failed (${res.statusCode}): ${data.slice(0, 200)}`));
                }
                catch (e) {
                    reject(new Error(`Parse error: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}
// ─── Core Handler ─────────────────────────────────────────────────────────────
async function render(latex, display, returnBase64 = false) {
    let tmpDir;
    try {
        const { pngPath, tmpDir: td } = renderToPng(latex);
        tmpDir = td;
        if (returnBase64) {
            const b64 = fs.readFileSync(pngPath).toString("base64");
            return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
        }
        const url = await uploadToGitHub(pngPath);
        return { content: [{ type: "text", text: url }] };
    }
    catch (err) {
        return { content: [{ type: "text", text: `❌ 渲染失败 [${display}]: ${err.message}` }] };
    }
    finally {
        if (tmpDir)
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch { }
    }
}
// ─── MCP Handlers ─────────────────────────────────────────────────────────────
const TOOLS = [
    {
        name: "render_addition",
        description: "渲染加法竖式，返回图片URL。使用 xlop \\opadd，支持小数。",
        inputSchema: {
            type: "object",
            properties: {
                addend1: { type: "number", description: "加数1，如 15.2" },
                addend2: { type: "number", description: "加数2，如 3.84" },
                base64: { type: "boolean", description: "可选，true 则返回 base64 图片而非URL" },
            },
            required: ["addend1", "addend2"],
        },
    },
    {
        name: "render_subtraction",
        description: "渲染减法竖式，返回图片URL。使用 xlop \\opsub，支持小数。",
        inputSchema: {
            type: "object",
            properties: {
                minuend: { type: "number", description: "被减数，如 100.00" },
                subtrahend: { type: "number", description: "减数，如 23.45" },
                base64: { type: "boolean", description: "可选，true 则返回 base64 图片而非URL" },
            },
            required: ["minuend", "subtrahend"],
        },
    },
    {
        name: "render_multiplication",
        description: "渲染乘法竖式，返回图片URL。使用 xlop \\opmul，支持小数。",
        inputSchema: {
            type: "object",
            properties: {
                multiplicand: { type: "number", description: "被乘数，如 3.14" },
                multiplier: { type: "number", description: "乘数，如 2.5" },
                base64: { type: "boolean", description: "可选，true 则返回 base64 图片而非URL" },
            },
            required: ["multiplicand", "multiplier"],
        },
    },
    {
        name: "render_division",
        description: "渲染小数除法竖式，返回图片URL。使用 longdivision \\longdivision。",
        inputSchema: {
            type: "object",
            properties: {
                dividend: { type: "number", description: "被除数" },
                divisor: { type: "number", description: "除数（不能为0）" },
                base64: { type: "boolean", description: "可选，true 则返回 base64 图片而非URL" },
            },
            required: ["dividend", "divisor"],
        },
    },
    {
        name: "render_integer_division",
        description: "渲染整数除法竖式（带余数），返回图片URL。使用 longdivision \\intlongdivision。示例: 107÷12=8余11",
        inputSchema: {
            type: "object",
            properties: {
                dividend: { type: "integer", description: "被除数（整数）" },
                divisor: { type: "integer", description: "除数（整数，不能为0）" },
                base64: { type: "boolean", description: "可选，true 则返回 base64 图片而非URL" },
            },
            required: ["dividend", "divisor"],
        },
    },
];
function setupHandlers(srv) {
    srv.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    srv.setRequestHandler(types_js_1.CallToolRequestSchema, async (req) => {
        const { name, arguments: a } = req.params;
        const args = a;
        const b64 = args.base64 === true;
        switch (name) {
            case "render_addition":
                return render(latexXlop("opadd", String(args.addend1), String(args.addend2)), `${args.addend1}+${args.addend2}`, b64);
            case "render_subtraction":
                return render(latexXlop("opsub", String(args.minuend), String(args.subtrahend)), `${args.minuend}-${args.subtrahend}`, b64);
            case "render_multiplication":
                return render(latexXlop("opmul", String(args.multiplicand), String(args.multiplier)), `${args.multiplicand}×${args.multiplier}`, b64);
            case "render_division":
                if (args.divisor === 0)
                    return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
                return render(latexDivision(String(args.dividend), String(args.divisor)), `${args.dividend}÷${args.divisor}`, b64);
            case "render_integer_division":
                if (args.divisor === 0)
                    return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
                return render(latexIntDivision(String(args.dividend), String(args.divisor)), `${args.dividend}÷${args.divisor}(整除)`, b64);
            default:
                return { content: [{ type: "text", text: `❌ 未知工具: ${name}` }] };
        }
    });
}
// ─── HTTP Server ───────────────────────────────────────────────────────────────
async function startHttpServer(port) {
    const { SSEServerTransport } = await Promise.resolve().then(() => __importStar(require("@modelcontextprotocol/sdk/server/sse.js")));
    const { StreamableHTTPServerTransport } = await Promise.resolve().then(() => __importStar(require("@modelcontextprotocol/sdk/server/streamableHttp.js")));
    const { default: http } = await Promise.resolve().then(() => __importStar(require("http")));
    const sseTransports = new Map();
    http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url || "/", `http://localhost:${port}`);
        if (url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", version: "4.0.0" }));
        }
        else if (url.pathname === "/sse" && req.method === "GET") {
            const transport = new SSEServerTransport("/message", res);
            sseTransports.set(transport.sessionId, transport);
            res.on("close", () => sseTransports.delete(transport.sessionId));
            const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "4.0.0" }, { capabilities: { tools: {} } });
            setupHandlers(srv);
            await srv.connect(transport);
        }
        else if (url.pathname === "/message" && req.method === "POST") {
            const sessionId = url.searchParams.get("sessionId") || "";
            const transport = sseTransports.get(sessionId);
            if (!transport) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Session not found" }));
                return;
            }
            let body = "";
            req.on("data", c => body += c);
            req.on("end", () => transport.handlePostMessage(req, res, JSON.parse(body)));
        }
        else if (url.pathname === "/mcp") {
            let body = "";
            req.on("data", c => body += c);
            req.on("end", async () => {
                try {
                    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                    const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "4.0.0" }, { capabilities: { tools: {} } });
                    setupHandlers(srv);
                    await srv.connect(transport);
                    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
                }
                catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
        }
        else {
            res.writeHead(404);
            res.end("Not found");
        }
    }).listen(port, () => {
        console.error(`Vertical Calc MCP Server v4.0 started on port ${port}`);
    });
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const mode = process.env.TRANSPORT || "stdio";
    const port = parseInt(process.env.PORT || "3000", 10);
    if (mode === "sse") {
        await startHttpServer(port);
    }
    else {
        const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "4.0.0" }, { capabilities: { tools: {} } });
        setupHandlers(srv);
        await srv.connect(new stdio_js_1.StdioServerTransport());
    }
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
