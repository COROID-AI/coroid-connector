const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a tool call an agent reports is a call to the MCP server with this
 * name. During a turn the connector gives the agent one server, CoRoid's,
 * under a name it made for that turn, and allows a permission request only
 * for a call to it. A call that says where it goes (Codex: the server and the
 * tool beside the call) is believed over its title; otherwise the title must
 * be exactly a tool of that server (Claude: `mcp__<server>__<tool>`), not
 * something that mentions one.
 */
export function isCallToServer(
  server: string,
  call: { title: string | null; rawInput: unknown }
): boolean {
  if (isRecord(call.rawInput) && typeof call.rawInput.server === 'string') {
    return (
      call.rawInput.server === server &&
      typeof call.rawInput.tool === 'string' &&
      TOOL_NAME.test(call.rawInput.tool)
    );
  }
  const title = (call.title ?? '').trim();
  for (const [prefix, separator] of [
    ['mcp__', '__'],
    ['mcp.', '.'],
  ]) {
    const named = `${prefix}${server}${separator}`;
    if (title.startsWith(named)) return TOOL_NAME.test(title.slice(named.length));
  }
  return false;
}
