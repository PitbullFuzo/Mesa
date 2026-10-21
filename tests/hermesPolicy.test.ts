import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { findHermesPython } from '../src/core/runtimes/hermes';
const installed = await findHermesPython();
it.skipIf(!installed).each([false, true])(
  'Hermes web policy %s removes disabled tools and confines canonical reads',
  async (webAccess) => {
    const result = await promisify(execFile)(
      installed!.file,
      [
        resolve('tests/fixtures/hermes-read-policy.py'),
        resolve('src/core/runtimes/hermes_acp.py'),
      ],
      {
        shell: false,
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, AGENTHQ_WEB_ACCESS: String(webAccess) },
      },
    );
    expect(result.stdout).toContain('READ_POLICY_PASS_NO_INFERENCE');
  },
  35000,
);
it.skipIf(!installed)(
  'Hermes bootstrap denies unsafe tools/unbound edits and preserves per-edit approval (no inference or writes)',
  async () => {
    const code =
      `import hermes_bootstrap\nimport runpy,sys,json\nsys.argv=['policy-test','--check']\nn=runpy.run_path(${JSON.stringify(resolve('src/core/runtimes/hermes_acp.py'))})\n` +
      `from acp_adapter.edit_approval import set_edit_approval_requester,reset_edit_approval_requester\nd=n['dispatch']\nd.__globals__['original_dispatch']=lambda *a,**k:'approved-without-execution'\nfor tool in ['terminal','execute_code','delegate_task','browser_navigate','skill_manage']:\n assert 'disabled' in d(tool,{})\nargs={'path':'agenthq-never-written.txt','content':'hi'}\nassert 'not bound' in d('write_file',args)\nt=set_edit_approval_requester(lambda p:False)\nassert 'not modified' in d('write_file',args)\nreset_edit_approval_requester(t)\nt=set_edit_approval_requester(lambda p:True)\nassert d('write_file',args)=='approved-without-execution'\nreset_edit_approval_requester(t)\nassert n['policy_config']()['mcp_servers']=={}\nfrom agent.title_generator import _auto_title_enabled\nassert not _auto_title_enabled(), 'Auxiliary titles must be disabled in the actual title reader'\nprint('POLICY_PASS_NO_INFERENCE')\n`;
    const result = await promisify(execFile)(installed!.file, ['-c', code], {
      shell: false,
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.stdout).toContain('POLICY_PASS_NO_INFERENCE');
  },
  35000,
);
it.skipIf(!installed)(
  'Hermes bootstrap allows only the Mesa browser server and keeps its tools visible (no inference)',
  async () => {
    const code = [
      'import hermes_bootstrap',
      'import runpy,sys,asyncio,types',
      "sys.argv=['policy-test','--check']",
      `n=runpy.run_path(${JSON.stringify(resolve('src/core/runtimes/hermes_acp.py'))})`,
      "d=n['dispatch']",
      "d.__globals__['original_dispatch']=lambda *a,**k:'ran'",
      "assert d('mcp__playwright__browser_navigate',{})=='ran'",
      "for tool in ['mcp__github__create_issue','tool_search','tool_call','terminal']:\n assert 'disabled' in d(tool,{}), tool",
      "assert n['policy_config']()['tools']['tool_search']['enabled']=='off'",
      "server=lambda name:types.SimpleNamespace(name=name,command='node',args=[],env=[])",
      "async def register(servers):\n try:\n  await n['register_session_mcp_servers'](None,None,servers)\n except RuntimeError as error:\n  return str(error)\n return 'accepted'",
      "for servers in ([server('github')],[server('playwright'),server('github')]):\n assert 'only its own browser server' in asyncio.run(register(servers))",
      "assert asyncio.run(register([]))=='accepted'",
      "print('BROWSER_POLICY_PASS_NO_INFERENCE')",
    ].join('\n');
    const result = await promisify(execFile)(installed!.file, ['-c', code], {
      shell: false,
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.stdout).toContain('BROWSER_POLICY_PASS_NO_INFERENCE');
  },
  35000,
);
it.skipIf(!installed).each([false, true])(
  'Hermes command toolsets exist only for Allow freely (%s), and the start-up check proves they are off by default (no inference)',
  async (allow) => {
    const result = await promisify(execFile)(
      installed!.file,
      [resolve('src/core/runtimes/hermes_acp.py'), '--check'],
      {
        shell: false,
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, AGENTHQ_RUN_COMMANDS: String(allow) },
      },
    );
    const check = JSON.parse(result.stdout.trim()) as {
      commands: boolean;
      tools: string[];
    };
    expect(check.commands).toBe(allow);
    for (const tool of ['terminal', 'process_manage', 'execute_code'])
      expect(check.tools.includes(tool)).toBe(allow);
  },
  35000,
);
