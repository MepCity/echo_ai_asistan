#!/usr/bin/env python3
"""Merges Echo's settings into Hermes' config.yaml, keeping everything else in it.

Usage: python3 -I configure.py /opt/hermes/data/config.yaml
Run by setup-hermes.sh; safe to run again. Needs PyYAML (python3-yaml).
"""
import os
import sys

import yaml

TRYPOST_MCP_URL = "https://sosyal.marmaraai.com/mcp/trypost"
DEFAULT_MODEL = "gpt-5.5"

# TryPost tools Hermes never gets: API keys and webhooks (Echo's own webhook lives there).
# Tool names are TryPost's MCP names (kebab-case class names, see app/Mcp/Tools in TryPost).
EXCLUDED_TOOLS = [
    "create-api-key-tool",
    "delete-api-key-tool",
    "list-api-keys-tool",
    "create-webhook-tool",
    "update-webhook-tool",
    "delete-webhook-tool",
    "rotate-webhook-secret-tool",
    "replay-webhook-log-tool",
    "send-webhook-test-tool",
]

# A WhatsApp assistant for social media needs no shell, files, browser or code
# execution; leaving them out keeps a prompt injected through post content from
# reaching the container (and the WhatsApp token in its environment).
DISABLED_TOOLSETS = [
    "terminal",
    "code_execution",
    "file",
    "browser",
    "computer_use",
    "delegation",
    "cronjob",
    "kanban",
    "connections",
    "catalog",
    "image_gen",
    "video_gen",
]


def main(path):
    config = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        sys.exit(f"{path} is not a YAML mapping")

    model = config.get("model") if isinstance(config.get("model"), dict) else {}
    config["model"] = model
    if model.get("provider") != "openai-codex":
        model["provider"] = "openai-codex"
        model["default"] = DEFAULT_MODEL
    model.setdefault("default", DEFAULT_MODEL)

    servers = config.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = config["mcp_servers"] = {}
    trypost = servers.get("trypost") if isinstance(servers.get("trypost"), dict) else {}
    trypost.update({
        "url": TRYPOST_MCP_URL,
        # TryPost's MCP accepts only OAuth grants with the mcp:use scope; an API key gets 403.
        "auth": "oauth",
        # Every TryPost tool not marked read-only asks for approval on WhatsApp before it runs.
        "trust": "untrusted",
        "timeout": 120,
        "connect_timeout": 30,
    })
    trypost.pop("headers", None)
    tools = trypost.get("tools") if isinstance(trypost.get("tools"), dict) else {}
    tools["exclude"] = sorted(set(tools.get("exclude") or []) | set(EXCLUDED_TOOLS))
    trypost["tools"] = tools
    servers["trypost"] = trypost

    approvals = config.get("approvals") if isinstance(config.get("approvals"), dict) else {}
    if approvals.get("mode") in (None, "off"):
        approvals["mode"] = "manual"
    approvals.setdefault("timeout", 300)
    config["approvals"] = approvals

    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    disabled = agent.get("disabled_toolsets") or []
    if not isinstance(disabled, list):
        disabled = [disabled]
    agent["disabled_toolsets"] = disabled + [name for name in DISABLED_TOOLSETS if name not in disabled]
    config["agent"] = agent

    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        yaml.safe_dump(config, handle, allow_unicode=True, sort_keys=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
