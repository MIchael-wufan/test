# Vertical Calculation MCP Server

一个 MCP (Model Context Protocol) 服务，用于渲染小学竖式计算题目，返回图片 URL 和 HTML img 标签。

## 功能

使用 LaTeX 的 **xlop** 和 **longdivision** 宏包渲染竖式，返回 **GitHub CDN 图片链接**。

| 运算 | 工具 | LaTeX 包 |
|------|------|----------|
| 加法 `123 + 456` | `render_addition` | `xlop` (`\opadd`) |
| 减法 `999 - 234` | `render_subtraction` | `xlop` (`\opsub`) |
| 乘法 `12 × 34` | `render_multiplication` | `xlop` (`\opmul`) |
| 除法 `144 ÷ 12` | `render_division` | `longdivision` |
| 自动识别 | `render_expression` | 自动选择 |

**返回格式：**
```
✅ 竖式计算渲染成功

表达式: 123 + 456
图片链接: https://user-images.githubusercontent.com/...

HTML 标签:
<img src="https://user-images.githubusercontent.com/..." alt="竖式计算: 123 + 456" style="max-width:400px;" />
```

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | ✅ | GitHub PAT，用于上传图片（需要 `repo` 权限） |
| `GITHUB_IMAGE_REPO_OWNER` | 可选 | 图片存储仓库 owner（默认 `MIchael-wufan`） |
| `GITHUB_IMAGE_REPO` | 可选 | 图片存储仓库名（默认 `test`） |

## 快速开始

### 方式一：Docker（推荐）

```bash
# 构建（含 texlive-full，约 3-4GB，耐心等待）
docker build -t vertical-calc-mcp .

# 测试
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  docker run -i --rm -e GITHUB_TOKEN=your_token vertical-calc-mcp
```

### 方式二：本地运行

```bash
# 安装系统依赖
apt-get install texlive-full imagemagick  # Ubuntu/Debian

# 安装 Node 依赖并构建
npm install && npm run build

# 运行
GITHUB_TOKEN=your_token node dist/index.js
```

## 接入 OpenAI SDK

```bash
# 安装 Python 依赖
pip install openai

# 运行示例
OPENAI_API_KEY=sk-xxx GITHUB_TOKEN=ghp_xxx python example/openai_client.py
```

`example/openai_client.py` 实现了完整的 Agent 循环：
1. 模型识别题目中的计算式
2. 自动调用 `render_expression` 工具
3. 获取图片 URL，嵌入 `<img>` 标签
4. 返回带竖式图片的 HTML 答案

## 注册到 MCP 客户端

在 `~/.openclaw/mcp-servers.json` 中添加：

```json
{
  "servers": {
    "vertical-calc": {
      "enabled": true,
      "mode": "stdio",
      "description": "竖式计算渲染服务",
      "command": "docker",
      "args": ["run", "-i", "--rm",
               "-e", "GITHUB_TOKEN=your_token",
               "vertical-calc-mcp"]
    }
  }
}
```

## 依赖

- **Node.js** >= 18
- **pdflatex** (texlive-full 或 texlive-latex-extra + xlop + longdivision)
- PDF 转 PNG 工具之一：`imagemagick` / `poppler-utils` / `ghostscript`
- **GITHUB_TOKEN** 用于图片上传
