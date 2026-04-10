"""
竖式计算 MCP — OpenAI SDK 接入示例
用法: python example/openai_client.py
"""
import os
import json
import subprocess
from openai import OpenAI

# ─── MCP 工具调用封装 ─────────────────────────────────────────────────────────

MCP_COMMAND = ["docker", "run", "-i", "--rm",
               "-e", f"GITHUB_TOKEN={os.environ.get('GITHUB_TOKEN', '')}",
               "vertical-calc-mcp"]

# 如果本地运行（非 Docker），改为:
# MCP_COMMAND = ["node", "dist/index.js"]


def call_mcp_tool(tool_name: str, arguments: dict) -> str:
    """调用 MCP Server，返回工具结果文本"""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments}
    })
    result = subprocess.run(
        MCP_COMMAND,
        input=payload,
        capture_output=True,
        text=True,
        timeout=60
    )
    data = json.loads(result.stdout)
    if "result" in data:
        contents = data["result"]["content"]
        return "\n".join(c["text"] for c in contents if c.get("type") == "text")
    else:
        return f"MCP Error: {data.get('error', {}).get('message', 'unknown')}"


# ─── OpenAI Function Definitions ─────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "render_expression",
            "description": (
                "渲染小学竖式计算题目，返回图片链接和 HTML img 标签。"
                "当题目涉及加减乘除竖式计算时调用此工具。"
                "支持运算符: + - × ÷ * /"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "算式，例如: '123+456', '999-234', '12×34', '144÷12'"
                    }
                },
                "required": ["expression"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "render_addition",
            "description": "渲染加法竖式计算图片，返回图片链接。",
            "parameters": {
                "type": "object",
                "properties": {
                    "addend1": {"type": "number", "description": "第一个加数"},
                    "addend2": {"type": "number", "description": "第二个加数"}
                },
                "required": ["addend1", "addend2"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "render_subtraction",
            "description": "渲染减法竖式计算图片，返回图片链接。",
            "parameters": {
                "type": "object",
                "properties": {
                    "minuend": {"type": "number", "description": "被减数"},
                    "subtrahend": {"type": "number", "description": "减数"}
                },
                "required": ["minuend", "subtrahend"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "render_multiplication",
            "description": "渲染乘法竖式计算图片，返回图片链接。",
            "parameters": {
                "type": "object",
                "properties": {
                    "multiplicand": {"type": "number", "description": "被乘数"},
                    "multiplier": {"type": "number", "description": "乘数"}
                },
                "required": ["multiplicand", "multiplier"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "render_division",
            "description": "渲染除法竖式（长除法）图片，返回图片链接。",
            "parameters": {
                "type": "object",
                "properties": {
                    "dividend": {"type": "number", "description": "被除数"},
                    "divisor": {"type": "number", "description": "除数"}
                },
                "required": ["dividend", "divisor"]
            }
        }
    }
]

# ─── Agent Loop ───────────────────────────────────────────────────────────────

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

SYSTEM_PROMPT = """你是一个小学数学辅导老师。当解题过程涉及加减乘除时，
你必须调用竖式计算工具渲染竖式图片，然后将返回的 <img> 标签嵌入 HTML 格式的回答中，
让学生能直观看到完整的竖式计算过程。

回答格式要求：
- 使用 HTML 格式
- 竖式部分用工具返回的 <img> 标签展示
- 结果用 <strong> 标注
"""


def solve_math(question: str, verbose: bool = True) -> str:
    """主 Agent 循环：接受数学题，自动调用竖式渲染工具，返回 HTML 答案"""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question}
    ]

    if verbose:
        print(f"\n📚 题目: {question}")
        print("─" * 50)

    while True:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
        )
        msg = response.choices[0].message

        # No tool calls → done
        if not msg.tool_calls:
            if verbose:
                print(f"\n✅ 答案:\n{msg.content}")
            return msg.content

        # Process tool calls
        messages.append(msg)
        for tool_call in msg.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            if verbose:
                print(f"\n🔧 调用工具: {fn_name}({fn_args})")

            result = call_mcp_tool(fn_name, fn_args)

            if verbose:
                # 只显示图片链接部分
                for line in result.split("\n"):
                    if "图片链接" in line or "URL" in line:
                        print(f"   {line.strip()}")

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": result
            })


# ─── 示例 ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    examples = [
        "请用竖式计算 357 + 468",
        "用竖式计算 1000 - 357",
        "用竖式计算 23 × 14",
        "用竖式计算 156 ÷ 12",
    ]

    for q in examples:
        html_answer = solve_math(q)
        # 可将 html_answer 写入文件或返回给前端
        print("\n" + "=" * 60)
