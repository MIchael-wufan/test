#!/usr/bin/env node
"use strict";
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
// ─── Math Helpers ─────────────────────────────────────────────────────────────
/** 精确计算，避免浮点误差，返回字符串 */
function calcAdd(a, b) {
    const na = Number(a), nb = Number(b);
    const d = Math.max(decimalLen(na), decimalLen(nb));
    return (na + nb).toFixed(d);
}
function calcSub(a, b) {
    const na = Number(a), nb = Number(b);
    const d = Math.max(decimalLen(na), decimalLen(nb));
    return (na - nb).toFixed(d);
}
function calcMul(a, b) {
    const na = Number(a), nb = Number(b);
    const d = decimalLen(na) + decimalLen(nb);
    return (na * nb).toFixed(d);
}
function decimalLen(n) {
    const s = String(Number(n));
    const i = s.indexOf(".");
    return i === -1 ? 0 : s.length - i - 1;
}
/** 除法结果，精确到 places 位小数，截断（不四舍五入） */
function calcDivTrunc(dividend, divisor, places) {
    const factor = Math.pow(10, places);
    return (Math.floor((Number(dividend) / Number(divisor)) * factor) / factor).toFixed(places);
}
/** 除法结果，四舍五入到 places 位小数（用于首行展示约等于） */
function calcDivRound(dividend, divisor, places) {
    return (Number(dividend) / Number(divisor)).toFixed(places);
}
/** 整数除法：商和余数 */
function calcIntDiv(dividend, divisor) {
    const nd = Number(dividend), ns = Number(divisor);
    const q = Math.floor(nd / ns);
    const r = nd - q * ns;
    return { quotient: q, remainder: r };
}
/**
 * 小数除数转整数：移位法（字符串精确实现，避免浮点误差）
 * 例：6.3 ÷ 0.7 → 63 ÷ 7（两者同乘10）
 * 例：1.44 ÷ 1.2 → 14.4 ÷ 12（×10）
 * 例：3.6 ÷ 0.12 → 360 ÷ 12（×100）
 */
function toIntDivisor(dividend, divisor) {
    const dsorStr = String(divisor);
    const dotIdx = dsorStr.indexOf(".");
    if (dotIdx === -1) {
        return { newDividend: dividend, newDivisor: divisor, newDividendStr: String(dividend), newDivisorStr: String(divisor), shift: 0 };
    }
    const shift = dsorStr.length - dotIdx - 1; // 除数小数位数
    // 精确移位：用字符串操作移动小数点，避免浮点乘法误差
    function shiftDecimal(numStr, places) {
        const s = String(numStr);
        const dot = s.indexOf(".");
        if (dot === -1) {
            // 整数，直接补零
            return s + "0".repeat(places);
        }
        const intPart = s.slice(0, dot);
        const fracPart = s.slice(dot + 1);
        // 补足小数部分
        const padded = (fracPart + "0".repeat(places)).slice(0, Math.max(fracPart.length, places));
        if (places >= fracPart.length) {
            // 小数点右移超过小数部分，结果是整数
            const result = intPart + padded;
            // 去掉前导零（保留至少一位）
            return result.replace(/^0+(?=\d)/, "") || "0";
        }
        else {
            // 还有小数部分
            const newInt = intPart + padded.slice(0, places);
            const newFrac = padded.slice(places);
            const cleanInt = newInt.replace(/^0+(?=\d)/, "") || "0";
            return cleanInt + "." + newFrac;
        }
    }
    const newDivisorStr = shiftDecimal(dsorStr, shift);
    const newDividendStr = shiftDecimal(String(dividend), shift);
    const newDivisor = parseFloat(newDivisorStr);
    const newDividend = parseFloat(newDividendStr);
    return { newDividend, newDivisor, newDividendStr, newDivisorStr, shift };
}
// ─── LaTeX Templates ──────────────────────────────────────────────────────────
function latexXlop(cmd, a, b, extraOpset = "") {
    const opsetBase = `decimalsepsymbol={.}${extraOpset ? "," + extraOpset : ""}`;
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{xlop}
\\opset{${opsetBase}}
\\begin{document}
{\\large\\${cmd}{${a}}{${b}}}
\\end{document}
`;
}
function latexDivision(dividend, divisor) {
    const keys = `separators in work=false`;
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\longdivisionkeys{${keys}}
\\begin{document}
{\\large\\longdivision{${dividend}}{${divisor}}}
\\end{document}
`;
}
function latexIntDivision(dividend, divisor) {
    return `\\documentclass[border=10pt]{standalone}
\\usepackage{longdivision}
\\longdivisionkeys{separators in work=false}
\\begin{document}
{\\large\\intlongdivision{${dividend}}{${divisor}}}
\\end{document}
`;
}
/** 渲染一行文字为 SVG（用 standalone + text） */
function latexText(text) {
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
function renderToSvg(latex) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
    const texFile = path.join(tmpDir, "calc.tex");
    const pdfFile = path.join(tmpDir, "calc.pdf");
    const svgFile = path.join(tmpDir, "calc.svg");
    fs.writeFileSync(texFile, latex, "utf-8");
    const compile = (0, child_process_1.spawnSync)("pdflatex", ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile], { encoding: "utf-8", timeout: 30000 });
    if (compile.status !== 0 || !fs.existsSync(pdfFile)) {
        const log = fs.existsSync(path.join(tmpDir, "calc.log"))
            ? fs.readFileSync(path.join(tmpDir, "calc.log"), "utf-8") : "";
        const errs = log.split("\n").filter(l => l.startsWith("!")).slice(0, 5).join("\n");
        throw new Error(`pdflatex failed:\n${errs}`);
    }
    // PDF → SVG via pdf2svg
    const r = (0, child_process_1.spawnSync)("pdf2svg", [pdfFile, svgFile], { timeout: 15000 });
    if (r.status === 0 && fs.existsSync(svgFile)) {
        return { svgPath: svgFile, tmpDir };
    }
    // Fallback: inkscape
    const ink = (0, child_process_1.spawnSync)("inkscape", ["--pdf-poppler", pdfFile, `--export-filename=${svgFile}`], { timeout: 15000 });
    if (ink.status === 0 && fs.existsSync(svgFile)) {
        return { svgPath: svgFile, tmpDir };
    }
    throw new Error("PDF to SVG conversion failed");
}
function parseSvg(svgPath) {
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
function mergeSvgs(items, tmpDir) {
    const GAP = 8; // pt，各块间距
    const LABEL_FONT_SIZE = 14;
    const LABEL_HEIGHT = LABEL_FONT_SIZE + 6;
    // 解析所有块的尺寸
    const blocks = [];
    for (const item of items) {
        if (item.svgPath) {
            blocks.push({ type: "svg", info: parseSvg(item.svgPath) });
        }
        else if (item.label) {
            blocks.push({ type: "label", text: item.label });
        }
    }
    // 计算总尺寸：仅以竖式 SVG 宽度为准，不用 label 文字估算来撑宽
    const svgWidths = blocks.filter(b => b.type === "svg").map(b => b.info.width);
    const maxWidth = svgWidths.length > 0 ? Math.max(...svgWidths) : 200;
    let totalHeight = 0;
    for (const b of blocks) {
        totalHeight += b.type === "svg" ? b.info.height : LABEL_HEIGHT;
        totalHeight += GAP;
    }
    totalHeight -= GAP;
    // 生成合并 SVG
    const PT_TO_PX = 1.333;
    const wPx = maxWidth * PT_TO_PX;
    const hPx = totalHeight * PT_TO_PX;
    let innerSvg = "";
    let yOffset = 0;
    let svgIndex = 0;
    for (const b of blocks) {
        if (b.type === "label") {
            const yText = (yOffset + LABEL_HEIGHT * 0.75) * PT_TO_PX;
            innerSvg += `<text x="0" y="${yText.toFixed(2)}" font-family="serif" font-size="${LABEL_FONT_SIZE}" fill="black">${escapeXml(b.text)}</text>\n`;
            yOffset += LABEL_HEIGHT + GAP;
        }
        else {
            const info = b.info;
            // 提取 SVG 内部内容（去掉外层 svg 标签，保留 defs + 内容），并给 id 加唯一前缀防止冲突
            const inner = extractSvgInner(info.content, svgIndex++);
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
function extractSvgInner(svgContent, index) {
    // 提取 <svg ...> 和 </svg> 之间的内容
    const match = svgContent.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
    let inner = match ? match[1] : svgContent;
    const prefix = `s${index}_`;
    // 收集所有 id 值，按长度降序排列以避免短 id 先替换导致误匹配
    const idMatches = [...inner.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const uniqueIds = [...new Set(idMatches)].sort((a, b) => b.length - a.length);
    for (const id of uniqueIds) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 替换 id="xxx"
        inner = inner.replace(new RegExp(`\\bid="${escaped}"`, "g"), `id="${prefix}${id}"`);
        // 替换 url(#xxx)
        inner = inner.replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`);
        // 替换 href="#xxx"
        inner = inner.replace(new RegExp(`href="#${escaped}"`, "g"), `href="#${prefix}${id}"`);
        // 替换 xlink:href="#xxx"
        inner = inner.replace(new RegExp(`xlink:href="#${escaped}"`, "g"), `xlink:href="#${prefix}${id}"`);
    }
    return inner;
}
function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// ─── GitHub Upload ────────────────────────────────────────────────────────────
async function uploadToGitHub(svgPath) {
    if (!GITHUB_TOKEN)
        throw new Error("GITHUB_TOKEN not set");
    const filename = `vcalc_${Date.now()}.svg`;
    const content = fs.readFileSync(svgPath).toString("base64");
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
async function renderAndMerge(opts, display) {
    const tmpDirs = [];
    try {
        const mergeItems = [];
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
    }
    catch (err) {
        return { content: [{ type: "text", text: `❌ 渲染失败 [${display}]: ${err.message}` }] };
    }
    finally {
        for (const d of tmpDirs) {
            try {
                fs.rmSync(d, { recursive: true, force: true });
            }
            catch { }
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
                verify: { type: "boolean", description: "可选，true 则附加验算过程" },
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
                minuend: { type: "number", description: "被减数，如 100.00" },
                subtrahend: { type: "number", description: "减数，如 23.45" },
                verify: { type: "boolean", description: "可选，true 则附加验算过程" },
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
                multiplier: { type: "number", description: "乘数，如 2.5" },
                verify: { type: "boolean", description: "可选，true 则附加验算过程" },
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
                dividend: { type: "number", description: "被除数" },
                divisor: { type: "number", description: "除数（不能为0，支持小数，小数除数将自动转为整数除法）" },
                decimalPlaces: { type: "integer", description: "可选，保留小数位数，计算到该位数+1位后截断" },
                verify: { type: "boolean", description: "可选，true 则附加验算过程" },
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
                divisor: { type: "integer", description: "除数（整数，不能为0）" },
                verify: { type: "boolean", description: "可选，true 则附加验算过程" },
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
        const verify = args.verify === true;
        switch (name) {
            case "render_addition": {
                const a1 = args.addend1;
                const a2 = args.addend2;
                const result = calcAdd(a1, a2);
                const header = `${a1} + ${a2} = ${result}`;
                const items = [
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
                const m = args.minuend;
                const s = args.subtrahend;
                const result = calcSub(m, s);
                const header = `${m} - ${s} = ${result}`;
                const items = [
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
                const mc = args.multiplicand;
                const mr = args.multiplier;
                const result = calcMul(mc, mr);
                const header = `${mc} × ${mr} = ${result}`;
                const items = [
                    { latex: latexXlop("opmul", String(mc), String(mr), "voperator=bottom") },
                ];
                if (verify) {
                    // 验算：result ÷ mr = mc
                    // 用精确移位法，避免浮点误差（如 63414.4 ÷ 46.4 → 634144 ÷ 464）
                    const { newDividendStr, newDivisorStr } = toIntDivisor(parseFloat(result), mr);
                    items.push({
                        label: "验算：",
                        latex: latexDivision(newDividendStr, newDivisorStr),
                    });
                }
                return renderAndMerge({ headerText: header, items }, `${mc}×${mr}`);
            }
            case "render_division": {
                if (args.divisor === 0)
                    return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
                const dend = args.dividend;
                const dsor = args.divisor;
                const places = args.decimalPlaces;
                // 小数除数转整数：移位法（精确字符串实现）
                const { newDividend, newDivisor, newDividendStr, newDivisorStr } = toIntDivisor(dend, dsor);
                let header;
                if (places !== undefined) {
                    // 保留 places 位，计算到 places+1 位截断
                    const roundResult = calcDivRound(newDividend, newDivisor, places);
                    header = `${dend} ÷ ${dsor} ≈ ${roundResult}`;
                    // 将被除数格式化为 places+1 位小数传给 LaTeX，使 longdivision 自然在该位停止
                    const dendForLatex = parseFloat(newDividendStr).toFixed(places + 1);
                    const items2 = [
                        { latex: latexDivision(dendForLatex, newDivisorStr) },
                    ];
                    if (verify) {
                        const quotient = calcDivTrunc(newDividend, newDivisor, places);
                        items2.push({
                            label: "验算：",
                            latex: latexXlop("opmul", quotient, newDivisorStr, "voperator=bottom"),
                        });
                    }
                    return renderAndMerge({ headerText: header, items: items2 }, `${dend}÷${dsor}`);
                }
                else {
                    const result = (Number(newDividend) / Number(newDivisor));
                    const d = decimalLen(result) || 2;
                    header = `${dend} ÷ ${dsor} = ${result.toFixed(d)}`;
                }
                const items = [
                    { latex: latexDivision(newDividendStr, newDivisorStr) },
                ];
                if (verify) {
                    // 验算：商 × 除数 = 被除数
                    const quotient = (Number(newDividend) / Number(newDivisor)).toFixed(2);
                    items.push({
                        label: "验算：",
                        latex: latexXlop("opmul", quotient, newDivisorStr, "voperator=bottom"),
                    });
                }
                return renderAndMerge({ headerText: header, items }, `${dend}÷${dsor}`);
            }
            case "render_integer_division": {
                if (args.divisor === 0)
                    return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
                const dend = args.dividend;
                const dsor = args.divisor;
                const { quotient, remainder } = calcIntDiv(dend, dsor);
                const header = remainder === 0
                    ? `${dend} ÷ ${dsor} = ${quotient}`
                    : `${dend} ÷ ${dsor} = ${quotient}……${remainder}`;
                const items = [
                    { latex: latexIntDivision(String(dend), String(dsor)) },
                ];
                if (verify) {
                    if (remainder === 0) {
                        // 验算：商 × 除数 = 被除数
                        items.push({
                            label: "验算：",
                            latex: latexXlop("opmul", String(quotient), String(dsor), "voperator=bottom"),
                        });
                    }
                    else {
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
            res.end(JSON.stringify({ status: "ok", version: "5.0.0" }));
        }
        else if (url.pathname === "/sse" && req.method === "GET") {
            const transport = new SSEServerTransport("/message", res);
            sseTransports.set(transport.sessionId, transport);
            res.on("close", () => sseTransports.delete(transport.sessionId));
            const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
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
                    const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
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
        console.error(`Vertical Calc MCP Server v5.0 started on port ${port}`);
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
        const srv = new index_js_1.Server({ name: "vertical-calc-mcp", version: "5.0.0" }, { capabilities: { tools: {} } });
        setupHandlers(srv);
        await srv.connect(new stdio_js_1.StdioServerTransport());
    }
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
