import { isCallToServer, permissionAnswer } from './permission.js';

/**
 * Plan 47 Phase 4: during a turn an agent may ask before it uses a tool. The
 * connector allows a request only when the call is to CoRoid's MCP server of
 * this turn, which it named itself, and refuses everything else: the agent's
 * own tools, and the tools of any other server the person has.
 *
 * Failure modes, written before the code:
 * R1 a call to CoRoid's server is refused, so the agent can do no work: in
 *    the form Claude reports it (a title, mcp__<server>__<tool>) or the form
 *    Codex reports it (the server and the tool beside the call);
 * R2 a tool of the agent's own is allowed because what it runs mentions
 *    CoRoid's server or one of its tools;
 * R3 a tool of another server is allowed because that server's name begins
 *    or ends like CoRoid's;
 * R4 a call that says in its fields that it goes to another server is
 *    allowed because its title names CoRoid's.
 *
 * Plan 48 (Cursor), written before the code:
 * R5 a call to CoRoid's server is refused in the form Cursor reports it (the
 *    server and the tool beside the call as providerIdentifier and toolName;
 *    titles `<server>: <tool>` and `<server>-<tool>: <tool>`), or one of
 *    those forms lets through another server or a command;
 * R6 a request is answered "allow always" (or "reject always"), so the agent
 *    keeps the answer in its own settings and outside the turn.
 */
const SERVER = 'coroid_4f9a12bc';

describe('which tool calls a turn allows', () => {
  it('R1: allows a call to this turn’s server, however the agent reports it', () => {
    expect(isCallToServer(SERVER, { title: `mcp__${SERVER}__report_qa_verdict`, rawInput: { verdict: 'PASS' } })).toBe(true);
    expect(isCallToServer(SERVER, { title: `mcp.${SERVER}.read_file`, rawInput: { server: SERVER, tool: 'read_file', arguments: {} } })).toBe(true);
    expect(isCallToServer(SERVER, { title: null, rawInput: { server: SERVER, tool: 'exec_command', arguments: { command: 'npm test' } } })).toBe(true);
  });

  it('R2: refuses a tool of the agent’s own that only mentions CoRoid’s', () => {
    for (const title of [
      `Bash: echo mcp__${SERVER}__read_file`,
      `Bash: cat ${SERVER} read_file`,
      `mcp__${SERVER}__read_file; rm -rf ~`,
      `execute tools.${SERVER}.read_file()`,
      'Write proof.txt',
      '',
    ]) {
      expect([title, isCallToServer(SERVER, { title, rawInput: { command: title } })]).toEqual([title, false]);
    }
    expect(isCallToServer(SERVER, { title: null, rawInput: { code: `return tools.${SERVER}.read_file()` } })).toBe(false);
    expect(isCallToServer(SERVER, { title: null, rawInput: undefined })).toBe(false);
  });

  it('R3: refuses another server whose name begins or ends like this turn’s', () => {
    for (const other of [`${SERVER}_notes`, `my_${SERVER}`, 'coroid', 'coroid_4f9a12bd']) {
      expect([other, isCallToServer(SERVER, { title: `mcp__${other}__send`, rawInput: {} })]).toEqual([other, false]);
      expect([other, isCallToServer(SERVER, { title: null, rawInput: { server: other, tool: 'send' } })]).toEqual([other, false]);
    }
    // A tool name may hold the separator; the server is what stands before the first one.
    expect(isCallToServer(SERVER, { title: `mcp__${SERVER}_notes__${SERVER}__send`, rawInput: {} })).toBe(false);
  });

  it('R4: believes the call’s own fields over its title', () => {
    expect(isCallToServer(SERVER, { title: `mcp__${SERVER}__send`, rawInput: { server: 'gmail', tool: 'send' } })).toBe(false);
  });

  it('R5: allows CoRoid’s server in the forms Cursor reports, and nothing that only looks like it', () => {
    expect(isCallToServer(SERVER, { title: `${SERVER}: read_file`, rawInput: { providerIdentifier: SERVER, toolName: 'read_file', args: {} } })).toBe(true);
    expect(isCallToServer(SERVER, { title: `${SERVER}-read_file: read_file`, rawInput: undefined })).toBe(true);
    expect(isCallToServer(SERVER, { title: `${SERVER}: read_file`, rawInput: undefined })).toBe(true);
    for (const [title, rawInput] of [
      [`${SERVER}: read_file`, { providerIdentifier: 'gmail', toolName: 'send' }],
      [`${SERVER}: read_file`, { providerIdentifier: `${SERVER}_notes`, toolName: 'read_file' }],
      [`${SERVER}-read_file: write_file`, undefined],
      [`${SERVER}: read_file; rm -rf ~`, undefined],
      [`${SERVER}_notes: send`, undefined],
      [`my_${SERVER}: send`, undefined],
      [`Shell: echo ${SERVER}: read_file`, undefined],
    ] as const) {
      expect([title, isCallToServer(SERVER, { title, rawInput })]).toEqual([title, false]);
    }
  });

  it('R6: answers once, never always, whichever the agent lists first', () => {
    const options = [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    expect(permissionAnswer(options, true)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(permissionAnswer(options, false)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    // An agent that offers only "always" is not answered with it: the request is cancelled.
    expect(permissionAnswer([options[0]], true)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionAnswer([options[2]], false)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionAnswer([], true)).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
