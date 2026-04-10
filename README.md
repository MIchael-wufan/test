# Vertical Calculation MCP Server

一个 MCP (Model Context Protocol) 服务，用于渲染小学竖式计算题目，返回高质量 PNG 图片。

## 功能

使用 LaTeX 的 **xlop** 和 **longdivision** 宏包渲染竖式计算，支持：

| 运算 | 工具 | LaTeX 包 |
|------|------|----------|
| 加法 `123 + 456` | `render_addition` | `xlop` (`\opadd`) |
| 减法 `999 - 234` | `render_subtraction` | `xlop` (`\opsub`) |
| 乘法 `12 × 34` | `render_multiplication` | `xlop` (`\opmul`) |
| 除法 `144 ÷ 12` | `render_division` | `longdivision` |
| 自动识别 | `render_expression` | 自动选择 |

返回内容：
- Base64 编码的 PNG 图片（可直接作为 MCP image content）
- 可嵌入 HTML 的 `<img>` 标签

## 快速开始

### 方式一：Docker（推荐）

```bash
# 构建镜像（包含完整 TeX Live，约 3-4GB，需要一些时间）
docker build -t vertical-calc-mcp .

# 测试运行
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  docker run -i --rm vertical-calc-mcp
```

### 方式二：本地运行（需要预装 TeX Live）

```bash
# 安装依赖
apt-get install texlive-full imagemagick  # Ubuntu/Debian

# 安装 Node 依赖并构建
npm install
npm run build

# 运行
node dist/index.js
```

## 配置到 OpenClaw MCP

在 `~/.openclaw/mcp-servers.json` 中添加：

```json
{
  "servers": {
    "vertical-calc": {
      "enabled": true,
      "mode": "stdio",
      "description": "竖式计算渲染服务",
      "command": "docker",
      "args": ["run", "-i", "--rm", "vertical-calc-mcp"]
    }
  }
}
```

## MCP 工具使用示例

### 渲染加法竖式
```json
{
  "tool": "render_addition",
  "arguments": { "addend1": 123, "addend2": 456 }
}
```

### 渲染除法竖式
```json
{
  "tool": "render_division",
  "arguments": { "dividend": 144, "divisor": 12 }
}
```

### 自动识别算式
```json
{
  "tool": "render_expression",
  "arguments": { "expression": "12×34" }
}
```

## 返回格式

成功时返回：
```
✅ 竖式计算渲染成功

**表达式**: 123 + 456

**HTML 图片标签**:
<img src="data:image/png;base64,..." alt="竖式计算: 123 + 456" style="max-width:400px;" />
```

同时附带 MCP image content（base64 PNG），大模型可直接看到渲染后的竖式图片。

## 给大模型的使用说明

当解题模型遇到竖式计算题目时：

1. 调用 `render_expression` 工具，传入算式（如 `"123+456"`）
2. 获取返回的 `<img>` 标签
3. 将 `<img>` 标签嵌入 HTML 回答中，即可完美展示竖式

```html
<p>计算 123 + 456 的竖式如下：</p>
<img src="data:image/png;base64,iVBORw..." alt="竖式计算: 123 + 456" style="max-width:400px;" />
<p>所以 123 + 456 = 579</p>
```

## 依赖

- **Node.js** >= 18
- **pdflatex** (texlive-full 或 texlive-latex-extra)
- **xlop** LaTeX package（texlive-full 已包含）
- **longdivision** LaTeX package（texlive-full 已包含）
- PDF 转 PNG 工具之一：
  - `imagemagick` (convert)
  - `poppler-utils` (pdftoppm)
  - `ghostscript` (gs)
