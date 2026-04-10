#!/usr/bin/env node
/**
 * Vertical Calculation MCP Server
 * 
 * Renders vertical arithmetic (加减乘除竖式) using LaTeX xlop / longdivision packages.
 * Returns a base64-encoded PNG image.
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
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── LaTeX Generation ─────────────────────────────────────────────────────────

/**
 * Generate LaTeX for addition/subtraction/multiplication using xlop package.
 * xlop commands: \opadd, \opsub, \opmul
 */
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
\\op${cmd === "opadd" ? "add" : cmd === "opsub" ? "sub" : "mul"}[style=text]{${operand1}}{${operand2}}
\\end{document}
`;
}

/**
 * Generate LaTeX for long division using longdivision package.
 * \longdivision{dividend}{divisor}
 */
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
  imageBase64?: string;
  mimeType?: string;
  error?: string;
  latex?: string;
}

function renderLatexToImage(latex: string): RenderResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcalc-"));
  const texFile = path.join(tmpDir, "calc.tex");
  const pdfFile = path.join(tmpDir, "calc.pdf");
  const pngFile = path.join(tmpDir, "calc.png");

  try {
    // Write LaTeX source
    fs.writeFileSync(texFile, latex, "utf-8");

    // Check for pdflatex
    const pdflatexPath = findExecutable("pdflatex");
    if (!pdflatexPath) {
      return {
        success: false,
        error: "pdflatex not found. Please install TeX Live: apt-get install texlive-full",
        latex,
      };
    }

    // Compile LaTeX → PDF
    const compileResult = spawnSync(
      pdflatexPath,
      ["-interaction=nonstopmode", "-output-directory", tmpDir, texFile],
      { encoding: "utf-8", timeout: 30000 }
    );

    if (compileResult.status !== 0) {
      const logFile = path.join(tmpDir, "calc.log");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
      const errorLines = log
        .split("\n")
        .filter((l) => l.startsWith("!") || l.includes("Error"))
        .slice(0, 10)
        .join("\n");
      return {
        success: false,
        error: `LaTeX compilation failed:\n${errorLines}`,
        latex,
      };
    }

    if (!fs.existsSync(pdfFile)) {
      return { success: false, error: "PDF not generated", latex };
    }

    // Convert PDF → PNG using available tool
    const converted = convertPdfToPng(pdfFile, pngFile);
    if (!converted.success) {
      return { success: false, error: converted.error, latex };
    }

    // Read PNG and encode as base64
    const imageBuffer = fs.readFileSync(pngFile);
    const base64 = imageBuffer.toString("base64");

    return {
      success: true,
      imageBase64: base64,
      mimeType: "image/png",
      latex,
    };
  } catch (err: any) {
    return { success: false, error: err.message, latex };
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function convertPdfToPng(
  pdfFile: string,
  pngFile: string
): { success: boolean; error?: string } {
  // Try ImageMagick convert
  const convert = findExecutable("convert");
  if (convert) {
    const result = spawnSync(
      convert,
      ["-density", "200", "-quality", "95", pdfFile, pngFile],
      { timeout: 20000 }
    );
    if (result.status === 0 && fs.existsSync(pngFile)) {
      return { success: true };
    }
  }

  // Try ImageMagick magick
  const magick = findExecutable("magick");
  if (magick) {
    const result = spawnSync(
      magick,
      ["convert", "-density", "200", "-quality", "95", pdfFile, pngFile],
      { timeout: 20000 }
    );
    if (result.status === 0 && fs.existsSync(pngFile)) {
      return { success: true };
    }
  }

  // Try pdftoppm (poppler-utils)
  const pdftoppm = findExecutable("pdftoppm");
  if (pdftoppm) {
    const ppmBase = pngFile.replace(".png", "");
    const result = spawnSync(
      pdftoppm,
      ["-r", "200", "-png", "-singlefile", pdfFile, ppmBase],
      { timeout: 20000 }
    );
    // pdftoppm outputs filename-1.png or filename.png
    const candidate1 = ppmBase + ".png";
    const candidate2 = ppmBase + "-1.png";
    const src = fs.existsSync(candidate1)
      ? candidate1
      : fs.existsSync(candidate2)
      ? candidate2
      : null;
    if (result.status === 0 && src) {
      fs.renameSync(src, pngFile);
      return { success: true };
    }
  }

  // Try Ghostscript
  const gs = findExecutable("gs");
  if (gs) {
    const result = spawnSync(
      gs,
      [
        "-dNOPAUSE", "-dBATCH", "-sDEVICE=pngalpha",
        "-r200", `-sOutputFile=${pngFile}`, pdfFile,
      ],
      { timeout: 20000 }
    );
    if (result.status === 0 && fs.existsSync(pngFile)) {
      return { success: true };
    }
  }

  return {
    success: false,
    error:
      "No PDF-to-PNG converter found. Install one of: imagemagick, poppler-utils, ghostscript",
  };
}

function findExecutable(name: string): string | null {
  try {
    const result = spawnSync("which", [name], { encoding: "utf-8" });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {}
  return null;
}

// ─── Expression Parser ────────────────────────────────────────────────────────

interface ParsedExpression {
  operator: "add" | "sub" | "mul" | "div";
  operand1: number;
  operand2: number;
}

function parseExpression(expr: string): ParsedExpression | null {
  // Normalize: remove spaces, support ×÷+-*/ etc.
  const normalized = expr
    .replace(/\s+/g, "")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/，/g, "");

  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([\+\-\*\/])(−?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const a = parseFloat(match[1]);
  const op = match[2];
  const b = parseFloat(match[3]);

  const opMap: Record<string, "add" | "sub" | "mul" | "div"> = {
    "+": "add", "-": "sub", "*": "mul", "/": "div",
  };

  return { operator: opMap[op], operand1: a, operand2: b };
}

// ─── Result Formatting ────────────────────────────────────────────────────────

function formatResult(result: RenderResult, expression: string): any {
  if (!result.success) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 渲染失败\n\n**表达式**: ${expression}\n**错误**: ${result.error}\n\n**LaTeX 源码**:\n\`\`\`latex\n${result.latex ?? ""}\n\`\`\``,
        },
      ],
    };
  }

  const imgTag = `<img src="data:image/png;base64,${result.imageBase64}" alt="竖式计算: ${expression}" style="max-width:400px;" />`;

  return {
    content: [
      {
        type: "text",
        text: `✅ 竖式计算渲染成功\n\n**表达式**: ${expression}\n\n**HTML 图片标签**:\n\`\`\`html\n${imgTag}\n\`\`\`\n\n将上面的 \`<img>\` 标签嵌入 HTML 页面即可显示竖式计算图。`,
      },
      {
        type: "image",
        data: result.imageBase64!,
        mimeType: "image/png",
      },
    ],
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "vertical-calc-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "render_addition",
      description: "渲染加法竖式计算图片。输入两个加数，返回 LaTeX xlop 渲染的竖式 PNG 图片（base64）和 HTML img 标签。",
      inputSchema: {
        type: "object",
        properties: {
          addend1: { type: "number", description: "第一个加数" },
          addend2: { type: "number", description: "第二个加数" },
        },
        required: ["addend1", "addend2"],
      },
    },
    {
      name: "render_subtraction",
      description: "渲染减法竖式计算图片。输入被减数和减数，返回 LaTeX xlop 渲染的竖式 PNG 图片（base64）和 HTML img 标签。",
      inputSchema: {
        type: "object",
        properties: {
          minuend: { type: "number", description: "被减数" },
          subtrahend: { type: "number", description: "减数" },
        },
        required: ["minuend", "subtrahend"],
      },
    },
    {
      name: "render_multiplication",
      description: "渲染乘法竖式计算图片。输入被乘数和乘数，返回 LaTeX xlop 渲染的竖式 PNG 图片（base64）和 HTML img 标签。",
      inputSchema: {
        type: "object",
        properties: {
          multiplicand: { type: "number", description: "被乘数" },
          multiplier: { type: "number", description: "乘数" },
        },
        required: ["multiplicand", "multiplier"],
      },
    },
    {
      name: "render_division",
      description: "渲染除法竖式（长除法）图片。输入被除数和除数，返回 LaTeX longdivision 渲染的竖式 PNG 图片（base64）和 HTML img 标签。",
      inputSchema: {
        type: "object",
        properties: {
          dividend: { type: "number", description: "被除数" },
          divisor: { type: "number", description: "除数" },
        },
        required: ["dividend", "divisor"],
      },
    },
    {
      name: "render_expression",
      description: "自动识别运算类型，渲染竖式计算图片。支持 + - * × / ÷ 运算符。例如: '123+456', '999-234', '12×34', '144÷12'",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "算式字符串，例如: '123+456', '999-234', '12×34', '144÷12'",
          },
        },
        required: ["expression"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "render_addition": {
      const { addend1, addend2 } = args as { addend1: number; addend2: number };
      const latex = generateXlopLatex("add", addend1, addend2);
      const result = renderLatexToImage(latex);
      return formatResult(result, `${addend1} + ${addend2}`);
    }

    case "render_subtraction": {
      const { minuend, subtrahend } = args as { minuend: number; subtrahend: number };
      const latex = generateXlopLatex("sub", minuend, subtrahend);
      const result = renderLatexToImage(latex);
      return formatResult(result, `${minuend} - ${subtrahend}`);
    }

    case "render_multiplication": {
      const { multiplicand, multiplier } = args as { multiplicand: number; multiplier: number };
      const latex = generateXlopLatex("mul", multiplicand, multiplier);
      const result = renderLatexToImage(latex);
      return formatResult(result, `${multiplicand} × ${multiplier}`);
    }

    case "render_division": {
      const { dividend, divisor } = args as { dividend: number; divisor: number };
      if (divisor === 0) {
        return {
          content: [{ type: "text", text: "❌ 除数不能为 0" }],
        };
      }
      const latex = generateLongDivisionLatex(dividend, divisor);
      const result = renderLatexToImage(latex);
      return formatResult(result, `${dividend} ÷ ${divisor}`);
    }

    case "render_expression": {
      const { expression } = args as { expression: string };
      const parsed = parseExpression(expression);
      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: `❌ 无法解析算式: "${expression}"\n支持格式: "123+456", "999-234", "12×34", "144÷12"`,
            },
          ],
        };
      }

      let latex: string;
      let exprDisplay: string;

      if (parsed.operator === "div") {
        latex = generateLongDivisionLatex(parsed.operand1, parsed.operand2);
        exprDisplay = `${parsed.operand1} ÷ ${parsed.operand2}`;
      } else {
        latex = generateXlopLatex(parsed.operator, parsed.operand1, parsed.operand2);
        const opSymbol = { add: "+", sub: "-", mul: "×" }[parsed.operator];
        exprDisplay = `${parsed.operand1} ${opSymbol} ${parsed.operand2}`;
      }

      const result = renderLatexToImage(latex);
      return formatResult(result, exprDisplay);
    }

    default:
      return {
        content: [{ type: "text", text: `❌ 未知工具: ${name}` }],
      };
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Vertical Calc MCP Server started (stdio mode)");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
