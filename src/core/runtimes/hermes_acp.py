"""Hermes-only policy shim for Obi-I's standard ACP client. No user files patched."""
import os
import sys

os.environ.update(HERMES_DISABLE_PLUGINS="1", HERMES_IGNORE_RULES="1", HERMES_ACP_SKIP_CONFIGURED_MCP="1", HERMES_YOLO_MODE="0")
import hermes_bootstrap  # activates the installed PM dependency environment
hermes_bootstrap.harden_import_path()
import copy
import inspect
import json
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli import config as config_module
original_config = config_module.load_config
original_readonly = getattr(config_module, "load_config_readonly", None)
WEB_ACCESS = os.environ.get("AGENTHQ_WEB_ACCESS", "true") == "true"
# Commands exist only for a session started for an agent set to Allow freely; every other session keeps the
# terminal and code-execution toolsets disabled.
# "true" = Allow freely; "ask" = every command tool call needs the owner's approval first; anything else = off.
RUN_MODE = os.environ.get("AGENTHQ_RUN_COMMANDS", "false")
ASK_COMMANDS = RUN_MODE == "ask"
RUN_COMMANDS = RUN_MODE in ("true", "ask")
COMMAND_TOOLSETS = ["terminal", "code_execution"] if RUN_COMMANDS else []
COMMAND_TOOLS = ["terminal", "process_manage", "execute_code"] if RUN_COMMANDS else []
TOOLSETS = ["file"] + (["web"] if WEB_ACCESS else []) + COMMAND_TOOLSETS

def policy_config(*args, _load=None, **kwargs):
    cfg = copy.deepcopy((_load or original_config)(*args, **kwargs))
    cfg["mcp_servers"] = {}
    cfg["hooks"] = {}
    cfg["platform_toolsets"] = {"acp": TOOLSETS + ["no_mcp"]}
    # Keep the browser tools directly visible: Hermes would otherwise hide them behind its tool_search bridge,
    # which this policy refuses.
    if not isinstance(cfg.get("tools"), dict):
        cfg["tools"] = {}
    cfg["tools"]["tool_search"] = {"enabled": "off"}
    cfg.setdefault("auxiliary", {}).setdefault("title_generation", {})["enabled"] = False
    return cfg

config_module.load_config = policy_config
if original_readonly is not None:
    config_module.load_config_readonly = lambda *a, **k: policy_config(*a, _load=original_readonly, **k)
# Titles use the separate read-only config loader; disable them at that boundary too.
from agent import title_generator
title_generator._title_config = lambda: {"enabled": False, "model_upgrade_enabled": False}
from acp_adapter.session import SessionManager
from acp_adapter.server import HermesACPAgent
from acp_adapter import entry
from acp_adapter.edit_approval import build_acp_edit_tool_call, maybe_require_edit_approval, _EDIT_APPROVAL_REQUESTER
import model_tools

ALLOWED = frozenset(["read_file", "search_files", "write_file", "patch"] + (["web_search", "web_extract"] if WEB_ACCESS else []) + COMMAND_TOOLS)
original_make = SessionManager._make_agent
if "enabled_toolsets" not in inspect.signature(original_make).parameters:
    raise RuntimeError("Unsupported Hermes ACP tool policy API")
original_dispatch = model_tools.handle_function_call
# A browser run may register exactly one session MCP server, Obi-I's own, named "playwright"; its tools are
# mcp__playwright__<tool> (the helper already limits which tools exist and what they accept).
BROWSER_SERVER = "playwright"
# Microsoft 365: Obi-I's own helper, a second allowed session server (its write tools only queue requests).
M365_SERVER = "m365"
SESSION_SERVERS = (BROWSER_SERVER, M365_SERVER)
SERVER_PREFIXES = tuple("mcp__" + name + "__" for name in SESSION_SERVERS)

def tool_allowed(name):
    return name in ALLOWED or str(name).startswith(SERVER_PREFIXES)

def read_path_allowed(name, arguments):
    """One ACP process/turn: roots arrive only from the trusted parent environment."""
    try:
        roots = json.loads(os.environ.get("AGENTHQ_READ_ROOTS", "[]"))
        if not isinstance(roots, list) or not roots or not isinstance(arguments, dict):
            return False
        path = arguments.get("path", "." if name == "search_files" else None)
        def safe(value):
            if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
                return False
            normalized = value.replace("\\", "/")
            parts = normalized.split("/")
            if normalized.startswith(("//", "/??/")) or any(c in value for c in "~$%*?{}[]") or ".." in parts:
                return False
            if os.name == "nt":
                if ":" in parts[0] and not (len(parts[0]) == 2 and parts[0][0].isalpha() and parts[0][1] == ":" and len(parts) > 1):
                    return False
                for part in parts[1:] if ":" in parts[0] else parts:
                    if part != "." and (part.endswith((".", " ")) or ":" in part or part.upper().split(".")[0] in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}):
                        return False
            return True
        if not safe(path):
            return False
        target = os.path.normcase(os.path.realpath(os.path.abspath(path)))
        for root in roots:
            if not safe(root) or not os.path.isabs(root):
                return False
            resolved = os.path.normcase(os.path.realpath(root))
            if os.path.commonpath([target, resolved]) == resolved:
                return True
        return False
    except (ValueError, TypeError, OSError):
        return False

def owner_approves(name, arguments):
    """Ask the owner (an ACP permission request, allow-once or deny only) before one command tool call."""
    try:
        from tools import terminal_tool
        callback = terminal_tool._get_approval_callback()
        if callback is None or not isinstance(arguments, dict):
            return False
        text = arguments.get("command") if name == "terminal" else arguments.get("code") if name == "execute_code" else json.dumps(arguments)
        if not isinstance(text, str) or not text:
            return False
        return callback(text, "Obi-I: " + name, allow_permanent=False, allow_session=False) == "once"
    except Exception:
        return False

def dispatch(name, *args, **kwargs):
    if not tool_allowed(name):
        return json.dumps({"error": "Tool disabled by Obi-I policy"})
    if ASK_COMMANDS and name in COMMAND_TOOLS and (not args or not owner_approves(name, args[0])):
        return json.dumps({"error": "Command not approved by the owner; it was not run"})
    if name in ("read_file", "search_files") and (not args or not read_path_allowed(name, args[0])):
        return json.dumps({"error": "Read denied by Obi-I: path is outside this agent's allowed folders or is unsafe"})
    if name in ("write_file", "patch"):
        if _EDIT_APPROVAL_REQUESTER.get() is None or not args or not isinstance(args[0], dict):
            return json.dumps({"error": "Obi-I edit approval is not bound; edit refused"})
        denial = maybe_require_edit_approval(name, args[0])
        if denial is not None:
            return denial
    return original_dispatch(name, *args, **kwargs)

model_tools.handle_function_call = dispatch

def make_agent(self, **kwargs):
    # A model switch rebuilds the agent; keep the browser toolset only if this session registered it.
    requested = kwargs.get("enabled_toolsets") or []
    kwargs["enabled_toolsets"] = TOOLSETS + ["mcp-" + name for name in SESSION_SERVERS if "mcp-" + name in requested]
    kwargs["disabled_toolsets"] = [t for t in ["terminal", "code_execution"] if t not in COMMAND_TOOLSETS] + ["delegation", "browser", "skills", "memory", "todo", "session_search"]
    agent = original_make(self, **kwargs)
    agent.tools = [tool for tool in agent.tools if tool_allowed(tool.get("function", {}).get("name"))]
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    if not {"read_file", "write_file", "patch"} <= agent.valid_tool_names:
        raise RuntimeError("Hermes required file tools unavailable under Obi-I policy")
    return agent

SessionManager._make_agent = make_agent
# Never allow native workspace/session auto-approval, including after a mode change.
HermesACPAgent._edit_approval_policy_for_state = lambda self, state: ("ask", state.cwd)
HermesACPAgent._schedule_mcp_late_refresh = lambda *args, **kwargs: None
native_register = HermesACPAgent._register_session_mcp_servers

async def register_session_mcp_servers(self, state, mcp_servers):
    if not mcp_servers:
        return
    # Fail closed: anything but Obi-I's one stdio browser server is refused.
    names = [getattr(s, "name", None) for s in mcp_servers]
    if not names or len(set(names)) != len(names) or any(n not in SESSION_SERVERS for n in names) or not all(hasattr(s, "command") for s in mcp_servers):
        raise RuntimeError("Obi-I allows only its own browser server")
    await native_register(self, state, mcp_servers)
    agent = state.agent
    # Native registration rebuilt the tool list; apply the policy filter again.
    agent.tools = [tool for tool in agent.tools if tool_allowed(tool.get("function", {}).get("name"))]
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}

HermesACPAgent._register_session_mcp_servers = register_session_mcp_servers
native_initialize = HermesACPAgent.initialize
native_prompt = HermesACPAgent.prompt

async def initialize(self, *args, **kwargs):
    response = await native_initialize(self, *args, **kwargs)
    response.field_meta = {**(response.field_meta or {}), "agenthqPolicy": "files-v1", "agenthqBrowser": "playwright-v1", "agenthqM365": "m365-v1"}
    return response

async def prompt(self, prompt, session_id, **kwargs):
    state = self.session_manager.get_session(session_id)
    before = float(getattr(state.agent, "session_estimated_cost_usd", 0) or 0) if state else 0
    response = await native_prompt(self, prompt, session_id, **kwargs)
    if state:
        after = float(getattr(state.agent, "session_estimated_cost_usd", 0) or 0)
        status = str(getattr(state.agent, "session_cost_status", "unknown"))
        meta = {**(response.field_meta or {}), "agenthqCostStatus": status}
        if status not in ("unknown", "unavailable", "none") or after > before:
            meta["agenthqCostUsd"] = max(0, after - before)
        response.field_meta = meta
    return response

HermesACPAgent.initialize = initialize
HermesACPAgent.prompt = prompt

if "--check" in sys.argv:
    from hermes_cli.version_info import get_version_info
    print(json.dumps({"policy": "files-v1", "version": get_version_info().base_version, "tools": sorted(ALLOWED), "editApproval": "ask", "browser": "playwright-v1", "m365": "m365-v1", "commands": RUN_COMMANDS}))
else:
    entry.main([])
