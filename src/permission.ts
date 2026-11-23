const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a tool call an agent reports is a call to the MCP server with this
 * name. During a turn the connector gives the agent one server, CoRoid's,
 * under a name it made for that turn, and allows a permission request only
 * for a call to it. Structured fields (Codex: server/tool; Cursor:
 * providerIdentifier/toolName; Antigravity: toolCall.name `mcp_<server>_<tool>`)
 * are trusted over the display title; otherwise the title must be exactly a
 * tool of that server (Claude: `mcp__<server>__<tool>`; Cursor: `<server>: <tool>`
 * or `<server>-<tool>: <tool>`; Antigravity: `Run mcp_<server>_<tool>`), not
 * something that merely mentions one.
 */
export function isCallToServer(
  server: string,
  call: { name?: string | null; title: string | null; rawInput: unknown }
): boolean {
  if (isRecord(call.rawInput) && typeof call.rawInput.server === 'string') {
    return (
      call.rawInput.server === server &&
      typeof call.rawInput.tool === 'string' &&
      TOOL_NAME.test(call.rawInput.tool)
    );
  }
  if (
    isRecord(call.rawInput) &&
    typeof call.rawInput.providerIdentifier === 'string'
  ) {
    return (
      call.rawInput.providerIdentifier === server &&
      typeof call.rawInput.toolName === 'string' &&
      TOOL_NAME.test(call.rawInput.toolName)
    );
  }
  // Structured tool name (Antigravity: `mcp_<server>_<tool>`). Trusted over title
  // so a built-in tool (e.g. `run_command`) cannot spoof a CoRoid MCP title.
  if (typeof call.name === 'string' && call.name.trim().length > 0) {
    const name = call.name.trim();
    const agyPrefix = `mcp_${server}_`;
    if (name.startsWith(agyPrefix))
      return TOOL_NAME.test(name.slice(agyPrefix.length));
    for (const [prefix, separator] of [
      ['mcp__', '__'],
      ['mcp.', '.'],
    ]) {
      const named = `${prefix}${server}${separator}`;
      if (name.startsWith(named))
        return TOOL_NAME.test(name.slice(named.length));
    }
    return false;
  }
  const title = (call.title ?? '').trim();
  // Cursor: `<server>: <tool>` when it calls, `<server>-<tool>: <tool>` when it asks.
  const said = title.startsWith(server)
    ? /^(?:-([A-Za-z0-9_-]+))?: ([A-Za-z0-9_-]+)$/.exec(
        title.slice(server.length)
      )
    : null;
  if (said) return !said[1] || said[1] === said[2];
  // Antigravity display title fallback: `Run mcp_<server>_<tool>` or `mcp_<server>_<tool>`.
  const agyTitle = title.startsWith('Run ') ? title.slice(4) : title;
  const agyPrefix = `mcp_${server}_`;
  if (agyTitle.startsWith(agyPrefix))
    return TOOL_NAME.test(agyTitle.slice(agyPrefix.length));
  for (const [prefix, separator] of [
    ['mcp__', '__'],
    ['mcp.', '.'],
  ]) {
    const named = `${prefix}${server}${separator}`;
    if (title.startsWith(named))
      return TOOL_NAME.test(title.slice(named.length));
  }
  return false;
}

type Option = { optionId?: unknown; kind?: unknown };

/**
 * The answer to a permission request (Plan 48): "allow once" for a call to
 * CoRoid's server, "reject once" for anything else. Never "always": an agent
 * keeps such an answer in its own settings, where it outlives the turn. An
 * agent that offers no answer for once is told the request is cancelled.
 */
export function permissionAnswer(
  options: readonly unknown[],
  allowed: boolean
): {
  outcome:
    | { outcome: 'selected'; optionId: unknown }
    | { outcome: 'cancelled' };
} {
  const wanted = allowed ? 'allow_once' : 'reject_once';
  const option = options
    .filter(isRecord)
    .find((candidate: Option) => candidate.kind === wanted);
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
