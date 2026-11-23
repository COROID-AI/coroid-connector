import type { ConnectorDescription } from './protocol/local-agents.js';
import { reportTurn, stayConnected } from './connect.js';
import { SignedOut } from './session.js';
import { startFakeCoroid, type FakeCoroid } from './test-utils/fake-coroid.js';

/**
 * Plan 47 Phase 3: the connector stays connected. It asks CoRoid for work at
 * the pace CoRoid names; each request is also the machine's heartbeat.
 *
 * Failure modes, written before the code:
 * L1 the first request does not describe the machine, so CoRoid lists a
 *    machine it knows nothing about, or the connector describes it on every
 *    request;
 * L2 told to describe itself again (CoRoid lost what it said), it does not;
 * L3 an access token CoRoid no longer takes ends the connector, although a
 *    renewal would have continued it; or the connector renews for ever when
 *    the new token is refused too;
 * L4 it asks again at a pace of its own instead of CoRoid's;
 * L5 a failure of the network or of CoRoid ends it, or makes it ask again
 *    without waiting;
 * L6 being switched off or not rolled out to the organization ends it
 *    without a word, or fills the terminal with the same line;
 * L7 it does not stop when asked;
 * L8 a disconnected machine goes on asking;
 * L9 a turn CoRoid hands over is not run, is run twice, or the connector
 *    waits before it asks again when the turn is done (the next role may be
 *    waiting); or something that is not a turn is run;
 * L10 a report about a turn goes out with a token CoRoid no longer takes
 *    and the turn is lost, although a renewal would have carried it; or
 *    what CoRoid answers (say this, end) does not come back.
 *
 * Phase 5e (E6), several turns at once (0.4.0):
 * L11 a turn CoRoid hands over while another runs waits for it, so a
 *    Developer's explorer finds no machine and runs on the model;
 * L12 more than four turns run at once, or the connector stops asking for
 *    work while fewer than four run;
 * L13 stopping the connector drops a turn that is still running, or does
 *    not wait for it;
 * L14 a turn that throws ends the connector, or stops the others.
 */
const laptop: ConnectorDescription = {
  name: 'Ada’s laptop',
  platform: 'darwin',
  connectorVersion: '0.1.0',
  agents: [
    {
      id: 'codex',
      version: '2.6.0',
      tried: true,
      state: 'ready',
      detail: null,
      models: null,
    },
  ],
};

let coroid: FakeCoroid;
beforeEach(async () => {
  coroid = await startFakeCoroid();
});
afterEach(() => coroid.close());

/** Runs the connector until it has asked `requests` times, then asks it to stop. */
async function run(
  requests: number,
  session: { accessToken(): Promise<string>; renew(): Promise<string> }
) {
  const stop = new AbortController();
  const waits: number[] = [];
  const said: string[] = [];
  const ended = await stayConnected({
    api: coroid.api,
    session,
    describe: async () => laptop,
    work: async turn => {
      worked.push(turn.id);
    },
    say: line => said.push(line),
    signal: stop.signal,
    sleep: async seconds => {
      waits.push(seconds);
      if (coroid.polls.length >= requests) stop.abort();
    },
  });
  return { ended, waits, said };
}
const worked: string[] = [];
const aTurn = {
  id: 'turn-7',
  agent: 'codex',
  rolePrompt: 'You are the QA agent.',
  message: 'Verify the change.',
  tools: {
    url: 'https://api.test/connector/v1/turns/turn-7/mcp',
    token: 'turn-token',
  },
  timeLimitSeconds: 600,
};
const fixedToken = (token = 'cmp_at_fixed') => ({
  accessToken: async () => token,
  renew: async () => token,
});
const ok = { status: 200, body: { turn: null, pollAfterSeconds: 15 } };

describe('the connector stays connected', () => {
  it('L1, L4, L7: describes the machine once, then asks at CoRoid’s pace until told to stop', async () => {
    coroid.pollAnswers.push(
      ok,
      { status: 200, body: { turn: null, pollAfterSeconds: 40 } },
      ok
    );
    const { ended, waits } = await run(3, fixedToken());
    expect(ended).toBe('stopped');
    expect(coroid.polls.map(poll => poll.body)).toEqual([
      { description: laptop },
      {},
      {},
    ]);
    expect(coroid.polls.every(poll => poll.token === 'cmp_at_fixed')).toBe(
      true
    );
    expect(waits).toEqual([15, 40, 15]);
  });

  it('L2: describes the machine again when CoRoid asks for it', async () => {
    coroid.pollAnswers.push(
      ok,
      { status: 409, body: { error: 'description_required' } },
      ok,
      ok
    );
    const { waits } = await run(4, fixedToken());
    expect(coroid.polls.map(poll => poll.body)).toEqual([
      { description: laptop },
      {},
      { description: laptop },
      {},
    ]);
    // The request that was told to describe itself is repeated at once.
    expect(waits).toEqual([15, 15, 15]);
  });

  it('L3: renews its access token once when CoRoid no longer takes it, and goes on', async () => {
    const tokens = ['cmp_at_old', 'cmp_at_new'];
    let renewals = 0;
    coroid.pollAnswers.push({ status: 401 }, ok, ok);
    const { ended } = await run(3, {
      accessToken: async () => tokens[renewals],
      renew: async () => {
        renewals += 1;
        return tokens[renewals];
      },
    });
    expect(ended).toBe('stopped');
    expect(renewals).toBe(1);
    expect(coroid.polls.map(poll => poll.token)).toEqual([
      'cmp_at_old',
      'cmp_at_new',
      'cmp_at_new',
    ]);
    expect(coroid.polls.map(poll => poll.body)).toEqual([
      { description: laptop },
      { description: laptop },
      {},
    ]);
  });

  it('L3, L8: ends as signed out when the renewed token is refused too, or the sign-in is over', async () => {
    let renewals = 0;
    coroid.pollAnswers.push({ status: 401 }, { status: 401 });
    const refusedTwice = await run(9, {
      accessToken: async () => 'cmp_at_old',
      renew: async () => {
        renewals += 1;
        return 'cmp_at_new';
      },
    });
    expect(refusedTwice.ended).toBe('signed_out');
    expect(renewals).toBe(1);
    expect(coroid.polls).toHaveLength(2);

    coroid.pollAnswers.push({ status: 401 });
    const over = await run(9, {
      accessToken: async () => 'cmp_at_old',
      renew: async () => {
        throw new SignedOut();
      },
    });
    expect(over.ended).toBe('signed_out');
    expect(coroid.polls).toHaveLength(3);
  });

  it('L5: waits longer after each failure of the network or of CoRoid, and goes on when it is back', async () => {
    coroid.pollAnswers.push(
      'drop',
      { status: 500 },
      { status: 502 },
      ok,
      'drop',
      ok
    );
    const { ended, waits } = await run(6, fixedToken());
    expect(ended).toBe('stopped');
    expect(waits).toEqual([5, 10, 20, 15, 5, 15]);
    // What the machine said about itself is sent until CoRoid has taken it.
    expect(coroid.polls.map(poll => poll.body)).toEqual([
      { description: laptop },
      { description: laptop },
      { description: laptop },
      { description: laptop },
      {},
      {},
    ]);
  });

  it('L5: a failing renewal that is not a sign-out is waited out like any other failure', async () => {
    let attempts = 0;
    coroid.pollAnswers.push({ status: 401 }, ok, ok);
    const { ended, waits } = await run(3, {
      accessToken: async () => 'cmp_at_old',
      renew: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('CoRoid did not answer');
        return 'cmp_at_new';
      },
    });
    expect(ended).toBe('stopped');
    expect(waits[0]).toBe(5);
    expect(attempts).toBe(2);
  });

  it('L9: runs a turn CoRoid hands over, once, and asks again at once when it is done', async () => {
    worked.length = 0;
    coroid.pollAnswers.push(
      ok,
      { status: 200, body: { turn: aTurn, pollAfterSeconds: 15 } },
      ok,
      ok
    );
    const { ended, waits } = await run(4, fixedToken());
    expect(ended).toBe('stopped');
    expect(worked).toEqual(['turn-7']);
    // No pause after the turn: three pauses for four requests.
    expect(waits).toEqual([15, 15, 15]);

    worked.length = 0;
    coroid.pollAnswers.push(
      {
        status: 200,
        body: {
          turn: { ...aTurn, agent: 'some-other-agent' },
          pollAfterSeconds: 15,
        },
      },
      ok
    );
    const unreadable = await run(coroid.polls.length + 2, fixedToken());
    expect(worked).toEqual([]);
    expect(unreadable.said).toContain(
      'CoRoid sent work this connector cannot read. It was left alone.'
    );
  });

  it('L10: a report about a turn renews its token once, and brings back what CoRoid says', async () => {
    const tokens = ['cmp_at_old', 'cmp_at_new'];
    let renewals = 0;
    const session = {
      accessToken: async () => tokens[renewals],
      renew: async () => {
        renewals += 1;
        return tokens[renewals];
      },
    };
    coroid.turnAnswers.push(
      { status: 401 },
      { status: 200, body: { action: 'say', text: 'Report your verdict.' } }
    );
    const directive = await reportTurn(coroid.api, session, 'turn-7', [
      { type: 'stopped', reason: 'end_turn' },
    ]);
    expect(directive).toEqual({ action: 'say', text: 'Report your verdict.' });
    expect(
      coroid.turnReports.map(report => [report.turn, report.token])
    ).toEqual([
      ['turn-7', 'cmp_at_old'],
      ['turn-7', 'cmp_at_new'],
    ]);
    expect(coroid.turnReports[1].events).toEqual([
      { type: 'stopped', reason: 'end_turn' },
    ]);

    // A turn CoRoid has closed, or will not take reports for: the agent's session is to end.
    coroid.turnAnswers.push({ status: 404 });
    expect(await reportTurn(coroid.api, session, 'turn-7', [])).toEqual({
      action: 'end',
    });
    coroid.turnAnswers.push({ status: 401 }, { status: 401 });
    await expect(
      reportTurn(coroid.api, session, 'turn-7', [])
    ).rejects.toBeInstanceOf(SignedOut);
  });

  it('L6: says once why it is not served, and keeps asking slowly', async () => {
    const off = {
      status: 503,
      body: {
        error: 'unavailable',
        error_description: 'Connecting a machine is not enabled',
      },
    };
    const notRolledOut = {
      status: 403,
      body: {
        error: 'forbidden',
        error_description:
          'Connecting a machine is not enabled for this organization',
      },
    };
    coroid.pollAnswers.push(off, off, notRolledOut, ok, ok);
    const { ended, waits, said } = await run(5, fixedToken());
    expect(ended).toBe('stopped');
    expect(waits).toEqual([60, 60, 60, 15, 15]);
    expect(said.filter(line => line.includes('not enabled'))).toEqual([
      'CoRoid is not serving this machine: Connecting a machine is not enabled',
      'CoRoid is not serving this machine: Connecting a machine is not enabled for this organization',
    ]);
    expect(said.at(-1)).toBe('Connected.');
  });

  /** A turn CoRoid hands over, by its id. */
  const turnAnswer = (id: string) => ({
    status: 200,
    body: {
      turn: {
        ...aTurn,
        id,
        tools: {
          ...aTurn.tools,
          url: `https://api.test/connector/v1/turns/${id}/mcp`,
        },
      },
      pollAfterSeconds: 15,
    },
  });

  /** Runs the connector with turns that end only when the test says so. */
  function heldTurns(options: { stopAfterPolls: number; throwing?: string }) {
    const stop = new AbortController();
    const release = new Map<string, () => void>();
    const running = new Set<string>();
    const finished: string[] = [];
    let mostAtOnce = 0;
    const said: string[] = [];
    const ended = stayConnected({
      api: coroid.api,
      session: fixedToken(),
      describe: async () => laptop,
      work: async turn => {
        if (turn.id === options.throwing)
          throw new Error('The agent could not be started');
        running.add(turn.id);
        mostAtOnce = Math.max(mostAtOnce, running.size);
        await new Promise<void>(resolve => release.set(turn.id, resolve));
        running.delete(turn.id);
        finished.push(turn.id);
      },
      say: line => said.push(line),
      signal: stop.signal,
      sleep: async () => {
        if (coroid.polls.length >= options.stopAfterPolls) stop.abort();
        await new Promise(resolve => setTimeout(resolve, 5));
      },
    });
    return {
      stop,
      release,
      running,
      finished,
      said,
      ended,
      mostAtOnce: () => mostAtOnce,
    };
  }
  const until = async (check: () => boolean) => {
    for (let waited = 0; !check(); waited += 10) {
      if (waited > 5_000) throw new Error('Waited too long');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  it('L11: a turn handed over while another runs runs beside it', async () => {
    coroid.pollAnswers.push(
      turnAnswer('developer'),
      turnAnswer('explorer'),
      ok
    );
    const held = heldTurns({ stopAfterPolls: 3 });
    await until(() => held.running.size === 2);
    expect([...held.running].sort()).toEqual(['developer', 'explorer']);
    held.release.get('explorer')?.();
    held.release.get('developer')?.();
    expect(await held.ended).toBe('stopped');
    expect(held.finished.sort()).toEqual(['developer', 'explorer']);
  });

  it('L12: four at once at most, and it asks for more as soon as one ends', async () => {
    coroid.pollAnswers.push(
      ...['t1', 't2', 't3', 't4', 't5'].map(turnAnswer),
      ok
    );
    const held = heldTurns({ stopAfterPolls: 6 });
    await until(() => held.running.size === 4);
    await new Promise(resolve => setTimeout(resolve, 100));
    // With four running it does not ask: the fifth turn is still CoRoid's.
    expect(coroid.polls).toHaveLength(4);
    held.release.get('t2')?.();
    await until(() => held.running.has('t5'));
    expect(held.mostAtOnce()).toBe(4);
    for (const id of ['t1', 't3', 't4', 't5']) held.release.get(id)?.();
    expect(await held.ended).toBe('stopped');
  });

  it('L13: stopping waits for the turns that still run', async () => {
    coroid.pollAnswers.push(turnAnswer('long'), ok);
    const held = heldTurns({ stopAfterPolls: 2 });
    await until(() => held.running.size === 1 && coroid.polls.length >= 2);
    held.stop.abort();
    let over = false;
    void held.ended.then(() => {
      over = true;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(over).toBe(false);
    held.release.get('long')?.();
    expect(await held.ended).toBe('stopped');
    expect(held.finished).toEqual(['long']);
  });

  it('L14: a turn that throws is said, and the connector and the other turns go on', async () => {
    coroid.pollAnswers.push(turnAnswer('steady'), turnAnswer('broken'), ok, ok);
    const held = heldTurns({ stopAfterPolls: 4, throwing: 'broken' });
    await until(() =>
      held.said.some(line => line.includes('The agent could not be started'))
    );
    expect(held.running.has('steady')).toBe(true);
    held.release.get('steady')?.();
    expect(await held.ended).toBe('stopped');
    expect(held.finished).toEqual(['steady']);
  });

  it('L15: reportTurn retries transient 5xx failures instead of dropping a long turn', async () => {
    coroid.turnAnswers.push(
      { status: 502, body: { error: 'bad_gateway' } },
      { status: 200, body: { action: 'continue' } }
    );
    const directive = await reportTurn(
      coroid.api,
      fixedToken(),
      'turn-retry',
      [{ type: 'message', text: 'still working' }],
      {
        retryDelayMs: 5,
      }
    );
    expect(directive).toEqual({ action: 'continue' });
    expect(coroid.turnReports).toHaveLength(2);
  });

  it('L16: stopping while all worker slots are full does not hang the poll loop', async () => {
    coroid.pollAnswers.push(...['t1', 't2', 't3', 't4'].map(turnAnswer));
    const held = heldTurns({ stopAfterPolls: 10 });
    await until(() => held.running.size === 4);
    held.stop.abort();
    // Release turns after abort; stayConnected must settle cleanly without extra polls.
    for (const id of ['t1', 't2', 't3', 't4']) held.release.get(id)?.();
    expect(await held.ended).toBe('stopped');
    expect(coroid.polls).toHaveLength(4);
  });

  it('L17: requesting a recheck forces a fresh machine description on the next poll', async () => {
    const stop = new AbortController();
    let describeCalls = 0;
    let triggerRecheck: (() => void) | null = null;
    coroid.pollAnswers.push(ok, ok, ok);
    const ended = await stayConnected({
      api: coroid.api,
      session: fixedToken(),
      describe: async () => {
        describeCalls += 1;
        return { ...laptop, name: `Lap-${describeCalls}` };
      },
      work: async () => undefined,
      say: () => undefined,
      signal: stop.signal,
      onControl: control => {
        triggerRecheck = control.requestRecheck;
      },
      sleep: async (_seconds, sleepSignal) => {
        if (coroid.polls.length === 1) {
          triggerRecheck?.();
          if (sleepSignal.aborted) return;
        }
        if (coroid.polls.length >= 2) stop.abort();
      },
    });
    expect(ended).toBe('stopped');
    expect(describeCalls).toBe(2);
    expect(coroid.polls[0].body).toEqual({
      description: { ...laptop, name: 'Lap-1' },
    });
    expect(coroid.polls[1].body).toEqual({
      description: { ...laptop, name: 'Lap-2' },
    });
  });
});
