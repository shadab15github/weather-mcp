#!/Users/test/LocalOllamaLLM/weather-mcp/venv/bin/python3
"""
Ollama ↔ Weather MCP Bridge

Spawns the weather-mcp server as a stdio subprocess, discovers its tools,
and runs an interactive chat loop where a local Ollama model can call them.

Usage:
    python ollama_mcp_bridge.py [model]

    model  — Ollama model tag (default: OLLAMA_MODEL env var or "qwen2.5:7b")

Requirements (already in venv):
    mcp, ollama, python-dotenv
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import ollama
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER_DIR = Path(__file__).parent
MODEL = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")

SYSTEM_PROMPT = (
    "You are a weather assistant with access to real-time weather tools. "
    "IMPORTANT: You must ALWAYS call the appropriate tool to get weather data. "
    "NEVER write code, explain APIs, or describe how to fetch data. "
    "NEVER answer from memory or training data. "
    "When asked about weather, forecasts, or air quality — call the tool immediately."
)

def _schema_to_ollama(input_schema: dict) -> dict:
    """Convert an MCP tool's inputSchema to the Ollama parameters format."""
    props = input_schema.get("properties", {})
    required = input_schema.get("required", [])

    ollama_props: dict = {}
    for name, defn in props.items():
        entry: dict = {
            "type": defn.get("type", "string"),
            "description": defn.get("description", ""),
        }
        if "enum" in defn:
            entry["enum"] = defn["enum"]
        if "default" in defn:
            entry["default"] = defn["default"]
        ollama_props[name] = entry

    return {
        "type": "object",
        "properties": ollama_props,
        "required": required,
    }


def _mcp_tools_to_ollama(mcp_tools) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": _schema_to_ollama(tool.inputSchema or {}),
            },
        }
        for tool in mcp_tools
    ]


async def call_tool(session: ClientSession, name: str, args: dict) -> str:
    """Call an MCP tool and return its text content."""
    result = await session.call_tool(name, args)
    parts = [c.text for c in result.content if hasattr(c, "text")]
    return "\n".join(parts) if parts else "(no output)"


async def run_bridge() -> None:
    server_params = StdioServerParameters(
        command="npx",
        args=["tsx", "server.ts"],
        env={**os.environ, "MCP_TRANSPORT": "stdio"},
        cwd=str(SERVER_DIR),
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools_result = await session.list_tools()
            mcp_tools = tools_result.tools
            ollama_tools = _mcp_tools_to_ollama(mcp_tools)

            tool_names = [t.name for t in mcp_tools]
            print(f"Model  : {MODEL}")
            print(f"Tools  : {', '.join(tool_names)}")
            print("Type 'quit' or 'exit' to stop.\n")

            messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

            while True:
                try:
                    user_input = input("You: ").strip()
                except (EOFError, KeyboardInterrupt):
                    print("\nGoodbye!")
                    break

                if not user_input:
                    continue
                if user_input.lower() in ("quit", "exit"):
                    print("Goodbye!")
                    break

                messages.append({"role": "user", "content": user_input})

                # Agentic loop: keep going until the model stops requesting tool calls
                while True:
                    response = ollama.chat(
                        model=MODEL,
                        messages=messages,
                        tools=ollama_tools,
                    )

                    msg = response.message
                    tool_calls = msg.tool_calls or []

                    # Record the assistant turn (content may be empty when tools are called)
                    messages.append(
                        {
                            "role": "assistant",
                            "content": msg.content or "",
                            **({"tool_calls": tool_calls} if tool_calls else {}),
                        }
                    )

                    if not tool_calls:
                        print(f"\nAssistant: {msg.content}\n")
                        break

                    # Execute each tool call sequentially
                    for tc in tool_calls:
                        fn = tc.function
                        args = (
                            fn.arguments
                            if isinstance(fn.arguments, dict)
                            else json.loads(fn.arguments or "{}")
                        )
                        print(f"  [tool] {fn.name}({json.dumps(args)})")

                        try:
                            tool_output = await call_tool(session, fn.name, args)
                        except Exception as exc:
                            tool_output = f"Error calling {fn.name}: {exc}"

                        messages.append({"role": "tool", "content": tool_output})


def main() -> None:
    asyncio.run(run_bridge())


if __name__ == "__main__":
    main()
