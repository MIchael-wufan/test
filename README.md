# vertical-calc-mcp

[![npm version](https://badge.fury.io/js/vertical-calc-mcp.svg)](https://www.npmjs.com/package/vertical-calc-mcp)

MCP Server，用于渲染小学竖式计算题目 —— 使用 LaTeX xlop / longdivision 宏包生成竖式图片，返回图片 URL 和 HTML `<img>` 标签。

## 安装与运行

```bash
# 直接用 npx 运行（无需安装）
GITHUB_TOKEN=your_token npx vertical-calc-mcp

# 或全局安装
npm install -g vertical-calc-mcp
GITHUB_TOKEN=your_token vertical-calc-mcp
```

## 系统依赖（必须预装）

| 依赖 | 用途 | 安装 |
|------|------|------|
| `pdflatex` | 编译 LaTeX | `apt-get install texlive-full` |
| `imagemagick` 或 `poppler-utils` | PDF → PNG | `apt-get install imagemagick` |

> 也可用 Docker 打包所有依赖，见下方 Docker 章节。

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | ✅ | GitHub PAT（`repo` 权限），用于上传图片到 GitHub CDN |
| `GITHUB_IMAGE_REPO_OWNER` | 可选 | 图片仓库 owner（默认 `MIchael-wufan`） |
| `GITHUB_IMAGE_REPO` | 可选 | 图片仓库名（默认 `test`） |

## MCP 工具

| 工具 | 说明 |
|------|------|
| `render_expression` | 自动识别算式类型（推荐）|
| `render_addition` | 加法竖式 |
| `render_subtraction` | 减法竖式 |
| `render_multiplication` | 乘法竖式 |
| `render_division` | 除法竖式（长除法）|

## 配置到 MCP 客户端

### OpenClaw (`~/.openclaw/mcp-servers.json`)

```json
{
  "servers": {
    "vertical-calc": {
      "enabled": true,
      "mode": "stdio",
      "description": "竖式计算渲染服务",
      "command": "npx",
      "args": ["-y", "vertical-calc-mcp"],
      "env": {
        "GITHUB_TOKEN": "your_token"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "vertical-calc": {
      "command": "npx",
      "args": ["-y", "vertical-calc-mcp"],
      "env": {
        "GITHUB_TOKEN": "your_token"
      }
    }
  }
}
```

## OpenAI SDK 接入

见 [`example/openai_client.py`](example/openai_client.py)，或直接复制工具定义：

```python
TOOLS = [{
    "type": "function",
    "function": {
        "name": "render_expression",
        "description": "渲染竖式计算图片，返回图片 URL 和 HTML img 标签。遇到加减乘除计算题时调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "算式，例如: '123+456', '12×34', '144÷12'"
                }
            },
            "required": ["expression"]
        }
    }
}]
```

## Docker 方式（含所有依赖）

```bash
docker build -t vertical-calc-mcp .
docker run -i --rm -e GITHUB_TOKEN=your_token vertical-calc-mcp
```
