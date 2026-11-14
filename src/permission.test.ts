import { isCallToServer } from './permission.js';

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
});
