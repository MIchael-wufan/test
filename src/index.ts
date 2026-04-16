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

/**
 * 小数除数转整数：移位法（字符串精确实现，避免浮点误差）
 * 例：6.3 ÷ 0.7 → 63 ÷ 7（两者同乘10）
 * 例：1.44 ÷ 1.2 → 14.4 ÷ 12（×10）
 * 例：3.6 ÷ 0.12 → 360 ÷ 12（×100）
 */
function toIntDivisor(dividend: number, divisor: number): { newDividend: number; newDivisor: number; newDividendStr: string; newDivisorStr: string; shift: number } {
  const dsorStr = String(divisor);
  const dotIdx = dsorStr.indexOf(".");
  if (dotIdx === -1) {
    return { newDividend: dividend, newDivisor: divisor, newDividendStr: String(dividend), newDivisorStr: String(divisor), shift: 0 };
  }
  const shift = dsorStr.length - dotIdx - 1; // 除数小数位数

  // 精确移位：用字符串操作移动小数点，避免浮点乘法误差
  function shiftDecimal(numStr: string, places: number): string {
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
    } else {
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

/**
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      边距配置说明                                 │
 * │                                                                  │
 * │  border=Xpt  ← 单值，四个方向均等边距（最稳定，避免方向顺序歧义）   │
 * │                                                                  │
 * │  当前值：border=10pt（四边均等）                                   │
 * │                                                                  │
 * │  底部视觉留白通过 mergeSvgs() 的 BOTTOM_TRIM 常量裁剪              │
 * │  BOTTOM_TRIM = 8pt：合并时每个 SVG 底部减去 8pt，抵消多余边距       │
 * │                                                                  │
 * │  字号：12pt（通过 documentclass 选项控制，不影响 xlop 内部排版）    │
 * │                                                                  │
 * │  竖式间距：见 mergeSvgs() 函数中的 GAP 常量（当前 2pt）            │
 * └─────────────────────────────────────────────────────────────────┘
 */

function latexXlop(cmd: "opadd" | "opsub" | "opmul", a: string, b: string, extraOpset = ""): string {
  const opsetBase = `decimalsepsymbol={.}${extraOpset ? "," + extraOpset : ""}`;
  return `\\documentclass[border=10pt,12pt]{standalone}
\\usepackage{xlop}
\\opset{${opsetBase}}
\\begin{document}
\\${cmd}{${a}}{${b}}
\\end{document}
`;
}

/**
 * 生成"移小数点留痕"行的 LaTeX：
 * 在除数和被除数的小数点上画删除线，右边显示移位后的整数形式
 * 例：3.14 ÷ 2.5  →  $3\sout{.}14 \div 2\sout{.}5 \longrightarrow 314 \div 25$
 * shift: 移动位数（即 toIntDivisor 返回的 shift）
 */
function latexDecimalShiftHint(
  origDividend: string, origDivisor: string,
  newDividendStr: string, newDivisorStr: string
): string {
  // 把小数点替换成 \sout{.}（划线）
  function strikeoutDot(s: string): string {
    return s.replace(".", "\\sout{.}");
  }
  const dend = strikeoutDot(origDividend);
  const dsor = strikeoutDot(origDivisor);
  return `\\documentclass[border=10pt,12pt]{standalone}
\\usepackage{ulem}
\\normalem
\\begin{document}
$${dend} \\div ${dsor} \\longrightarrow ${newDividendStr} \\div ${newDivisorStr}$
\\end{document}
`;
}

/**
 * 在竖式 SVG 内容中，根据 shift 在除数和被除数的原小数点位置插入删除线标记。
 * longdivision 渲染出的竖式结构：
 *   - 较大 y 行（topY）：包含除数（左侧）、除号、被除数（右侧）
 *   - 较小 y 行：商
 * 方法：
 *   1. 找到最小路径的 glyph（小数点字形）
 *   2. 找竖式第二行（除数+被除数所在行）的所有字符及 x 坐标
 *   3. 按 x 分段：x < 除号x → 除数字符；x > 除号x → 被除数字符
 *   4. 根据 shift 在对应位置后插入小圆点+斜线
 *
 * origDivisor: 原始除数字符串（含小数点，如 "2.5"）
 * origDividend: 原始被除数字符串（含小数点，如 "3.14"）
 * svgContent: 原始竖式 SVG 字符串
 */
function addDecimalStrikethrough(svgContent: string, origDivisor: string, origDividend: string): string {
  // 只有除数含小数点时才处理
  const divisorDotIdx = origDivisor.indexOf(".");
  if (divisorDotIdx === -1) return svgContent;

  const dividendDotIdx = origDividend.indexOf(".");

  // 找最短 path 的 glyph（小数点）
  const glyphPaths: Array<{ id: string; pathLen: number }> = [];
  const symbolMatches = [...svgContent.matchAll(/<symbol[^>]+id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)];
  for (const m of symbolMatches) {
    const gid = m[1];
    const pathMatch = m[2].match(/d="([^"]+)"/);
    if (pathMatch) {
      glyphPaths.push({ id: gid, pathLen: pathMatch[1].length });
    }
  }
  if (glyphPaths.length === 0) return svgContent;
  // 小数点是 path 最短的非空 glyph（通常 ~240 chars）
  glyphPaths.sort((a, b) => a.pathLen - b.pathLen);
  const dotGlyphId = glyphPaths[0].id;

  // 找所有 use 元素，按 y 值分组
  const useMatches = [...svgContent.matchAll(/<use xlink:href="#([^"]+)" x="([0-9.]+)" y="([0-9.]+)"\/>/g)];
  if (useMatches.length === 0) return svgContent;

  // 收集所有 y 值
  const ySet = new Set<number>();
  for (const m of useMatches) {
    ySet.add(parseFloat(m[3]));
  }
  const ySorted = [...ySet].sort((a, b) => a - b);
  // longdivision: 最小 y = 商行，第二小 y = 被除数行（含除数+除号+被除数）
  // 有时候除数在单独一行，需要找包含最多字符的行
  // 简单策略：取字符最多的那一行（通常是被除数行）
  const yCount = new Map<number, number>();
  for (const m of useMatches) {
    const y = parseFloat(m[3]);
    yCount.set(y, (yCount.get(y) || 0) + 1);
  }
  // 取字符最多的行
  let topRowY = ySorted[0];
  let maxCount = 0;
  for (const [y, cnt] of yCount) {
    if (cnt > maxCount) { maxCount = cnt; topRowY = y; }
  }

  // 找该行所有字符的 x 坐标，按 x 排序
  const topRowUses: Array<{ x: number; glyph: string }> = [];
  for (const m of useMatches) {
    if (Math.abs(parseFloat(m[3]) - topRowY) < 1) {
      topRowUses.push({ x: parseFloat(m[2]), glyph: m[1] });
    }
  }
  topRowUses.sort((a, b) => a.x - b.x);

  if (topRowUses.length === 0) return svgContent;

  // 估算字符宽度（相邻字符 x 差的中位数）
  const xDiffs: number[] = [];
  for (let i = 1; i < topRowUses.length; i++) {
    const d = topRowUses[i].x - topRowUses[i - 1].x;
    if (d > 1 && d < 20) xDiffs.push(d);
  }
  xDiffs.sort((a, b) => a - b);
  const charWidth = xDiffs.length > 0 ? xDiffs[Math.floor(xDiffs.length / 2)] : 6;
  const dotRadius = charWidth * 0.15;  // 小数点圆点半径
  const dotCy = topRowY - charWidth * 0.12;  // 小数点垂直位置（基线附近）

  // 找除号位置（最大 x 间距处，即除数和被除数之间的空白）
  let dividerX = topRowUses[0].x;
  let maxGap = 0;
  for (let i = 1; i < topRowUses.length; i++) {
    const gap = topRowUses[i].x - topRowUses[i - 1].x;
    if (gap > maxGap) {
      maxGap = gap;
      dividerX = (topRowUses[i].x + topRowUses[i - 1].x) / 2;
    }
  }

  // 分离除数字符和被除数字符
  const divisorChars = topRowUses.filter(u => u.x < dividerX);
  const dividendChars = topRowUses.filter(u => u.x > dividerX);

  // 要插入的删除线列表
  const strikethroughs: Array<{ cx: number }> = [];

  // 除数：原除数小数点在第 divisorDotIdx 位后
  // divisorChars[divisorDotIdx - 1] 是小数点前最后一个数字
  if (divisorDotIdx > 0 && divisorDotIdx <= divisorChars.length) {
    const prevChar = divisorChars[divisorDotIdx - 1];
    // 小数点位置 = 前一个字符 x + 字符宽度
    const dotX = prevChar.x + charWidth;
    strikethroughs.push({ cx: dotX });
  }

  // 被除数：原被除数小数点在第 dividendDotIdx 位后
  if (dividendDotIdx > 0 && dividendDotIdx <= dividendChars.length) {
    const prevChar = dividendChars[dividendDotIdx - 1];
    const dotX = prevChar.x + charWidth;
    strikethroughs.push({ cx: dotX });
  }

  // 生成 SVG 删除线元素（小圆点 + 斜线）
  let strikeEl = "";
  for (const { cx } of strikethroughs) {
    const r = dotRadius;
    const lineHalf = r * 2.5;
    strikeEl += `<circle cx="${cx.toFixed(2)}" cy="${dotCy.toFixed(2)}" r="${r.toFixed(2)}" fill="black"/>\n`;
    strikeEl += `<line x1="${(cx - lineHalf).toFixed(2)}" y1="${(dotCy + lineHalf).toFixed(2)}" x2="${(cx + lineHalf).toFixed(2)}" y2="${(dotCy - lineHalf).toFixed(2)}" stroke="black" stroke-width="0.8"/>\n`;
  }

  if (!strikeEl) return svgContent;

  // 插入到 </svg> 之前
  return svgContent.replace(/<\/svg>/, strikeEl + "</svg>");
}

function latexDivision(dividend: string, divisor: string): string {
  const keys = `separators in work=false`;
  return `\\documentclass[border=10pt,12pt]{standalone}
\\usepackage{longdivision}
\\longdivisionkeys{${keys}}
\\begin{document}
\\longdivision{${dividend}}{${divisor}}
\\end{document}
`;
}

function latexIntDivision(dividend: string, divisor: string): string {
  return `\\documentclass[border=10pt,12pt]{standalone}
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
  // border 同上，但文字标签不需要指定字号（用 \large 内联控制）
  return `\\documentclass[border=10pt]{standalone}
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
 *   label   → 插入一行文字（渲染成 SVG 以获取真实宽度，避免截断）
 */
function mergeSvgs(items: Array<{ svgPath?: string; label?: string }>, tmpDir: string, tmpDirsRef: string[]): string {
  const GAP = 2;          // pt，竖式块之间的间距（含 label 与竖式之间）；调大可增加各竖式间留白
  const BOTTOM_TRIM = 8;  // pt，每个 SVG 底部裁剪量（border=10pt，裁掉8pt使底部留白≈2pt）

  const LABEL_FONT_SIZE = 14; // px，label 文字大小（SVG text 用）
  const LABEL_HEIGHT_PT = 20;  // pt，label 行高

  // 判断是否含中文（含中文则用 SVG text 估算宽度，否则用 LaTeX 渲染取真实宽度）
  function hasChinese(s: string): boolean {
    return /[\u4e00-\u9fff\uff00-\uffef]/.test(s);
  }

  const blocks: Array<
    { type: "svg"; info: SvgInfo } |
    { type: "label-svg"; info: SvgInfo } |          // 纯 ASCII label，LaTeX 渲染，宽度精确
    { type: "label-text"; text: string; widthPt: number; heightPt: number }  // 含中文，SVG text
  > = [];

  for (const item of items) {
    if (item.svgPath) {
      blocks.push({ type: "svg", info: parseSvg(item.svgPath) });
    } else if (item.label) {
      if (hasChinese(item.label)) {
        // 含中文：SVG text 绘制，宽度按字符数估算（中文字符约16px，数字/字母约10px）
        let widthPx = 0;
        for (const ch of item.label) {
          widthPx += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 18 : 11;
        }
        const widthPt = widthPx * 0.75;
        blocks.push({ type: "label-text", text: item.label, widthPt, heightPt: LABEL_HEIGHT_PT });
      } else {
        // 纯 ASCII（算式）：LaTeX 渲染取真实宽度
        const { svgPath: lsvgPath, tmpDir: lTmpDir } = renderToSvg(latexText(item.label));
        tmpDirsRef.push(lTmpDir);
        blocks.push({ type: "label-svg", info: parseSvg(lsvgPath) });
      }
    }
  }

  // 画布宽 = 所有块宽度的最大值（竖式 + label 全部参与），保证不截断
  const allWidths = blocks.map(b => {
    if (b.type === "svg" || b.type === "label-svg") return b.info.width;
    return b.widthPt;
  });
  const canvasWidth = Math.max(...allWidths, 50);

  // 竖式最大宽（用于竖式居中）
  const svgMaxWidth = Math.max(
    ...blocks.filter(b => b.type === "svg").map(b => (b as any).info.width as number),
    50
  );

  let totalHeight = 0;
  for (const b of blocks) {
    if (b.type === "svg") totalHeight += b.info.height - BOTTOM_TRIM;
    else if (b.type === "label-svg") totalHeight += b.info.height - BOTTOM_TRIM;
    else totalHeight += b.heightPt;
    totalHeight += GAP;
  }
  totalHeight -= GAP;

  // 生成合并 SVG
  const PT_TO_PX = 1.333;
  const wPx = canvasWidth * PT_TO_PX;
  const hPx = totalHeight * PT_TO_PX;

  let innerSvg = "";
  let yOffset = 0;
  let svgIndex = 0;

  for (const b of blocks) {
    if (b.type === "label-text") {
      // 含中文 label：SVG text 左对齐
      const yText = (yOffset + b.heightPt * 0.75) * PT_TO_PX;
      innerSvg += `<text x="0" y="${yText.toFixed(2)}" font-family="serif" font-size="${LABEL_FONT_SIZE * 1.2}" fill="black">${escapeXml(b.text)}</text>\n`;
      yOffset += b.heightPt + GAP;
    } else if (b.type === "label-svg") {
      // 纯 ASCII label：LaTeX SVG，左对齐
      const inner = extractSvgInner(b.info.content, svgIndex++);
      const yPx = yOffset * PT_TO_PX;
      innerSvg += `<g transform="translate(0,${yPx.toFixed(2)})">\n${inner}\n</g>\n`;
      yOffset += (b.info.height - BOTTOM_TRIM) + GAP;
    } else {
      // 竖式：在画布中居中
      const info = b.info;
      const inner = extractSvgInner(info.content, svgIndex++);
      const xOffset = (canvasWidth - info.width) / 2;
      const xPx = xOffset * PT_TO_PX;
      const yPx = yOffset * PT_TO_PX;
      innerSvg += `<g transform="translate(${xPx.toFixed(2)},${yPx.toFixed(2)})">\n${inner}\n</g>\n`;
      yOffset += (info.height - BOTTOM_TRIM) + GAP;
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

function extractSvgInner(svgContent: string, index: number): string {
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

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── GitHub Upload ────────────────────────────────────────────────────────────

async function uploadToGitHub(svgPath: string, retries = 3): Promise<string> {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN not set");
  // 时间戳 + 随机数，确保每次上传文件名唯一，避免 SHA 冲突
  const filename = `vcalc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.svg`;
  const content  = fs.readFileSync(svgPath).toString("base64");
  const payload  = JSON.stringify({
    message: `upload ${filename}`,
    content,
    branch: "main",
  });

  const doUpload = (): Promise<string> => new Promise((resolve, reject) => {
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
          const parsed = JSON.parse(data);
          const url = parsed?.content?.download_url;
          if (url) {
            resolve(url);
          } else if (res.statusCode === 409 || res.statusCode === 422) {
            // 409/422 冲突：重新生成文件名后重试（递归调用）
            reject(new Error(`RETRY:${res.statusCode}:${data.slice(0, 100)}`));
          } else {
            reject(new Error(`Upload failed (${res.statusCode}): ${data.slice(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await doUpload();
    } catch (e: any) {
      if (attempt < retries && e.message?.startsWith("RETRY:")) {
        // 等待随机时长后重试，使用新文件名
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        return uploadToGitHub(svgPath, retries - attempt); // 递归以生成新文件名
      }
      throw e;
    }
  }
  throw new Error("Upload failed after retries");
}

// ─── Core Render & Merge ──────────────────────────────────────────────────────

interface RenderItem {
  latex: string;
  label?: string; // 在这张图前插入的文字标签（如"验算："）
  postProcess?: (svgContent: string) => string; // SVG 后处理钩子（如添加删除线）
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
      // 如果有后处理钩子（如小数点删除线），修改 SVG 文件内容
      if (item.postProcess) {
        const original = fs.readFileSync(svgPath, "utf-8");
        const processed = item.postProcess(original);
        fs.writeFileSync(svgPath, processed, "utf-8");
      }
      mergeItems.push({ svgPath });
    }

    // 3. 合并 SVG
    const mergeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-merge-"));
    tmpDirs.push(mergeTmpDir);
    const mergedPath = mergeSvgs(mergeItems, mergeTmpDir, tmpDirs);

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
        divisor:       { type: "number", description: "除数（不能为0，支持小数，小数除数将自动转为整数除法）" },
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
        if (args.divisor === 0) return { content: [{ type: "text", text: "❌ 除数不能为 0" }] };
        const dend = args.dividend as number;
        const dsor = args.divisor as number;
        const places = args.decimalPlaces as number | undefined;

        // 小数除数转整数：移位法（精确字符串实现）
        const { newDividend, newDivisor, newDividendStr, newDivisorStr, shift } = toIntDivisor(dend, dsor);

        // 是否需要插入移位留痕（仅当除数含小数点时）
        const needShiftHint = shift > 0;

        let header: string;

        if (places !== undefined) {
          // 保留 places 位，计算到 places+1 位截断
          const roundResult = calcDivRound(newDividend, newDivisor, places);
          header = `${dend} ÷ ${dsor} ≈ ${roundResult}`;
          const dendForLatex = parseFloat(newDividendStr).toFixed(places + 1);
          const mainItem: RenderItem = { latex: latexDivision(dendForLatex, newDivisorStr) };
          if (needShiftHint) {
            mainItem.postProcess = (svg) => addDecimalStrikethrough(svg, String(dsor), String(dend));
          }
          const items2: RenderItem[] = [mainItem];
          if (verify) {
            const quotient = calcDivTrunc(newDividend, newDivisor, places);
            items2.push({
              label: "验算：",
              latex: latexXlop("opmul", quotient, newDivisorStr, "voperator=bottom"),
            });
          }
          return renderAndMerge({ headerText: header, items: items2 }, `${dend}÷${dsor}`);
        } else {
          const result = (Number(newDividend) / Number(newDivisor));
          const d = decimalLen(result) || 2;
          header = `${dend} ÷ ${dsor} = ${result.toFixed(d)}`;
        }

        const mainItem: RenderItem = { latex: latexDivision(newDividendStr, newDivisorStr) };
        if (needShiftHint) {
          mainItem.postProcess = (svg) => addDecimalStrikethrough(svg, String(dsor), String(dend));
        }
        const items: RenderItem[] = [mainItem];
        if (verify) {
          const quotient = (Number(newDividend) / Number(newDivisor)).toFixed(2);
          items.push({
            label: "验算：",
            latex: latexXlop("opmul", quotient, newDivisorStr, "voperator=bottom"),
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
