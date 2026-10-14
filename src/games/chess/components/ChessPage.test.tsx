import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getUsersSnapshot, resetUsersStore, setUsersState } from '@shared/profile/usersStore';
import { LINEUP_KEY, resetLineupStore, setLineup } from '@shared/profile/lineupStore';
import { addUser, emptyUsersState, setActiveUser } from '@shared/profile/users';
import { pointsForResult } from '@shared/profile/profile';
import { fakeParty, fakePartyWithKai } from '@shared/party/testing';
import { loadChessGame, type StoredLocalChess } from '@games/chess/storage/chessPersistence';
import { parseFen } from '@games/chess/domain/fen';
import type { Ply, Square } from '@games/chess/domain/types';

// A controllable useParty so each party state renders without a network.
const mockParty = vi.hoisted(() => ({ value: null as any }));
vi.mock('@shared/party/PartyContext', () => ({ useParty: () => mockParty.value }));

// The chess link, stubbed: remembers the handlers and which codes were
// hosted/dialled, so a test can push a status without WebRTC.
const net = vi.hoisted(() => ({ handlers: null as any, hosted: [] as string[], joined: [] as string[] }));
vi.mock('@shared/net/peer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/net/peer')>();
  class GameConnection {
    constructor(private handlers: { onStatus: (s: string, d?: string) => void }) {
      net.handlers = handlers;
    }
    host(code: string) {
      net.hosted.push(code);
      this.handlers.onStatus('hosting');
    }
    join(code: string) {
      net.joined.push(code);
      this.handlers.onStatus('connecting');
    }
    send() {
      return true;
    }
    destroy() {}
  }
  return { ...actual, GameConnection };
});

// The real hook, with startTable wrapped so a test can read exactly how the
// page sat down — role, code, ticket, colour — while the game still starts.
const sat = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@games/chess/state/useChess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@games/chess/state/useChess')>();
  return {
    ...actual,
    useChess: (o: Parameters<typeof actual.useChess>[0]) => {
      const cx = actual.useChess(o);
      return {
        ...cx,
        startTable: (opts: Parameters<typeof cx.startTable>[0]) => {
          sat.calls.push(opts);
          cx.startTable(opts);
        },
      };
    },
  };
});

import { ChessPage } from './ChessPage';

function renderPage(entry = '/chess') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <ChessPage />
    </MemoryRouter>,
  );
}

const rerenderPage = (r: ReturnType<typeof renderPage>) =>
  r.rerender(
    <MemoryRouter initialEntries={['/chess']}>
      <ChessPage />
    </MemoryRouter>,
  );

/** The lobby's two taps: the count, then a way to play for that count. */
function choose(count: 1 | 2, way: 'mode-local' | 'mode-online' | 'mode-free') {
  fireEvent.click(screen.getByTestId(`chess-count-${count}`));
  fireEvent.click(screen.getByTestId(way));
}
const goOnline = () => choose(2, 'mode-online');
const goFree = () => choose(1, 'mode-free');
/**
 * 2 players, Same device, and Flora for chair two when the picker asks (it
 * doesn't when the chair is remembered from last time): the game starts.
 */
function startLocal() {
  choose(2, 'mode-local');
  const flora = screen.queryByTestId('chess-p2-user-u2');
  if (flora) fireEvent.click(flora);
}

/** Only characters the real generateCode can emit (no look-alikes O/0, I/1, L). */
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

beforeEach(() => {
  localStorage.clear();
  // A game route always has somebody signed in (the PlayerGate sees to it),
  // so every case here plays as Rio's ticket — with Flora's ticket sitting
  // on the same browser, ready to take the other chair.
  resetUsersStore();
  resetLineupStore();
  setUsersState(
    setActiveUser(addUser(addUser(emptyUsersState(), 'u1', 'Rio'), 'u2', 'Flora'), 'u1'),
  );
  mockParty.value = fakeParty();
  net.handlers = null;
  net.hosted = [];
  net.joined = [];
  sat.calls = [];
});

describe('<ChessPage> — the party is the table', () => {
  it('not in a party: both code doors, and creating sits you down as host on a fresh code', () => {
    renderPage();
    goOnline();
    expect(screen.getByTestId('chess-create')).toBeInTheDocument();
    expect(screen.getByTestId('chess-join')).toBeInTheDocument();
    expect(screen.queryByTestId('chess-party-play')).toBeNull();
    expect(screen.queryByTestId('chess-party-waiting')).toBeNull();

    fireEvent.click(screen.getByTestId('chess-create'));
    expect(sat.calls).toHaveLength(1);
    expect(sat.calls[0]).toEqual({ role: 'host', code: expect.stringMatching(CODE_RE), seatedUserId: 'u1' });
    // The page minted the code; the hook listens on that very code.
    const { code } = sat.calls[0] as { code: string };
    expect(net.hosted).toEqual([code]);
    expect(screen.getByTestId('chess-code')).toHaveTextContent(code);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
  });

  it('not in a party: joining with a code sits you down as guest on it, as your ticket', () => {
    renderPage();
    goOnline();
    fireEvent.change(screen.getByTestId('chess-join-code'), { target: { value: 'qrst' } });
    fireEvent.click(screen.getByTestId('chess-join'));
    expect(sat.calls).toEqual([{ role: 'guest', code: 'QRST', seatedUserId: 'u1' }]);
    expect(net.joined).toEqual(['QRST']);
  });

  it('host in a party: Flip for it lets the coin pick the colour', () => {
    mockParty.value = fakePartyWithKai('host');
    const coin = vi.spyOn(Math, 'random').mockReturnValue(0.9); // tails: Black
    renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-side-flip'));
    expect(screen.getByTestId('chess-side-flip')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chess-side-w')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('chess-party-play'));
    expect(mockParty.value.openTable).toHaveBeenCalledWith('chess', 'b');
    expect(sat.calls).toEqual([{ role: 'host', code: 'WXYZ', seatedUserId: 'u1', hostSide: 'b' }]);
    coin.mockRestore();
  });

  it('host in a party: pick a colour, one tap opens the table and starts as host with that colour', () => {
    mockParty.value = fakePartyWithKai('host');
    renderPage();
    goOnline();

    // No code doors — the friend is already here.
    expect(screen.queryByTestId('chess-create')).toBeNull();
    expect(screen.queryByTestId('chess-join-code')).toBeNull();
    const play = screen.getByTestId('chess-party-play');
    expect(play).toHaveTextContent('Play Chess with Kai');

    // White is the default; Black is one tap.
    expect(screen.getByTestId('chess-side-w')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chess-side-b')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('chess-side-b'));
    expect(screen.getByTestId('chess-side-b')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chess-side-w')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(play);
    expect(mockParty.value.openTable).toHaveBeenCalledWith('chess', 'b');
    expect(sat.calls).toEqual([{ role: 'host', code: 'WXYZ', seatedUserId: 'u1', hostSide: 'b' }]);
    expect(net.hosted).toEqual(['WXYZ']);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    // The friend is already here: no QR invite flashes up while they walk in.
    expect(screen.queryByRole('dialog', { name: 'Invite your opponent' })).toBeNull();
  });

  it("host in a party before the friend's hello lands: the play button still reads sensibly", () => {
    mockParty.value = fakePartyWithKai('host', { theirName: null });
    renderPage();
    goOnline();
    expect(screen.getByTestId('chess-party-play')).toHaveTextContent('Play Chess with your friend');
  });

  it("host in a party: ‹ Menu closes the table too, so the friend's screen never points at a hostless board", () => {
    mockParty.value = fakePartyWithKai('host');
    renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-party-play'));
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chess-back'));
    expect(mockParty.value.closeTable).toHaveBeenCalledWith('WXYZ');
  });

  it('guest in a party: knocks on Chess once, then sits down when the host opens the table', () => {
    mockParty.value = fakePartyWithKai('guest');
    const r = renderPage();
    goOnline();

    expect(screen.getByTestId('chess-party-waiting')).toHaveTextContent('Waiting for Kai to open Chess');
    expect(screen.queryByTestId('chess-create')).toBeNull();
    expect(screen.queryByTestId('chess-join-code')).toBeNull();
    expect(mockParty.value.knockOn).toHaveBeenCalledTimes(1);
    expect(mockParty.value.knockOn).toHaveBeenCalledWith('chess');
    expect(sat.calls).toEqual([]);

    // A re-render with no table yet doesn't knock again.
    rerenderPage(r);
    expect(mockParty.value.knockOn).toHaveBeenCalledTimes(1);

    // The host opens Chess as Black: the guest sits down as White on that code.
    const knockOn = mockParty.value.knockOn;
    mockParty.value = fakePartyWithKai('guest', { knockOn, table: { game: 'chess', code: 'QRST', hostSide: 'b' } });
    rerenderPage(r);
    expect(sat.calls).toEqual([{ role: 'guest', code: 'QRST', seatedUserId: 'u1', hostSide: 'b' }]);
    expect(net.joined).toEqual(['QRST']);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(knockOn).toHaveBeenCalledTimes(1);
  });

  it('guest in a party: a Chess table already open means no knock — just sit down', () => {
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'chess', code: 'QRST' } });
    renderPage();
    goOnline();
    expect(mockParty.value.knockOn).not.toHaveBeenCalled();
    expect(sat.calls).toEqual([{ role: 'guest', code: 'QRST', seatedUserId: 'u1', hostSide: undefined }]);
  });

  it("guest in a party: a host side that isn't a colour is ignored — the guest sits down as Black", () => {
    // Junk off the wire ('white' instead of 'w') must not become an error or
    // a wrong chair: the default holds, host White, guest Black.
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'chess', code: 'QRST', hostSide: 'white' } });
    renderPage();
    goOnline();
    expect(sat.calls).toEqual([{ role: 'guest', code: 'QRST', seatedUserId: 'u1', hostSide: undefined }]);
    expect(loadChessGame('QRST')).toMatchObject({ side: 'guest', myColor: 'b' });
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
  });

  it('guest in a party: a table for another game still means knocking on Chess', () => {
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'racer', code: 'RACE' } });
    renderPage();
    goOnline();
    expect(mockParty.value.knockOn).toHaveBeenCalledWith('chess');
    expect(sat.calls).toEqual([]);
    expect(screen.getByTestId('chess-party-waiting')).toBeInTheDocument();
  });

  it('guest in a party: the table closing mid-dial hangs up and puts the guest back at the door', () => {
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'chess', code: 'QRST' } });
    const r = renderPage();
    goOnline();
    expect(net.joined).toEqual(['QRST']);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(loadChessGame('QRST')).not.toBeNull();

    // The host walks away before the link opens: the dial at that dead code
    // is hung up, the save goes with it, and the guest is waiting — and
    // knocking — again.
    const { knockOn } = mockParty.value;
    mockParty.value = fakePartyWithKai('guest', { knockOn, table: null });
    rerenderPage(r);
    expect(screen.queryByTestId('chess-board')).toBeNull();
    expect(screen.getByTestId('chess-party-waiting')).toHaveTextContent('Waiting for Kai to open Chess');
    expect(loadChessGame('QRST')).toBeNull();
    expect(knockOn).toHaveBeenCalledTimes(1);

    // The host opens a fresh table: the guest sits straight down at it.
    mockParty.value = fakePartyWithKai('guest', { knockOn, table: { game: 'chess', code: 'EF67' } });
    rerenderPage(r);
    expect(net.joined).toEqual(['QRST', 'EF67']);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
  });

  it('guest in a party: a game that is actually connected is never torn down by the table closing', () => {
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'chess', code: 'QRST' } });
    const r = renderPage();
    goOnline();
    act(() => net.handlers.onStatus('connected'));

    const { knockOn } = mockParty.value;
    mockParty.value = fakePartyWithKai('guest', { knockOn, table: null });
    rerenderPage(r);
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(loadChessGame('QRST')).not.toBeNull();
    expect(knockOn).not.toHaveBeenCalled();
  });

  it('rejoining a remembered party: a quiet line, no doors, no play button', () => {
    mockParty.value = fakeParty({ reconnecting: true });
    renderPage();
    goOnline();
    expect(screen.getByTestId('chess-party-reconnecting')).toHaveTextContent('Reconnecting to your party');
    expect(screen.queryByTestId('chess-create')).toBeNull();
    expect(screen.queryByTestId('chess-join-code')).toBeNull();
    expect(screen.queryByTestId('chess-party-play')).toBeNull();
    expect(screen.queryByTestId('chess-party-waiting')).toBeNull();
  });

  it('leaving an online game tells the party which table it is leaving — the party decides whether that closes anything', () => {
    mockParty.value = fakePartyWithKai('host');
    const r = renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-party-play'));

    // The link fails; the error panel's way out is the exit-to-menu path.
    act(() => net.handlers.onStatus('error', 'Lost the link.'));
    fireEvent.click(screen.getByRole('button', { name: /Back to menu/ }));
    expect(mockParty.value.closeTable).toHaveBeenCalledWith('WXYZ');
    r.unmount();

    // A guest says so too; the party ignores it (only the host closes a table).
    mockParty.value = fakePartyWithKai('guest', { table: { game: 'chess', code: 'QRST' } });
    renderPage();
    goOnline();
    act(() => net.handlers.onStatus('error', 'Lost the link.'));
    fireEvent.click(screen.getByRole('button', { name: /Back to menu/ }));
    expect(mockParty.value.closeTable).toHaveBeenCalledWith('QRST');
  });
});

describe('<ChessPage> — local flow', () => {

  it('asks the count first, then offers only the ways to play that fit it', () => {
    renderPage();
    // The first screen: two counts and the quiet code row, nothing else to pick.
    expect(screen.getByTestId('chess-count-1')).toHaveTextContent('1 player');
    expect(screen.getByTestId('chess-count-2')).toHaveTextContent('2 players');
    expect(screen.getByTestId('chess-join-row')).toHaveTextContent('Join with a code');
    expect(screen.queryByTestId('mode-local')).toBeNull();
    expect(screen.queryByTestId('mode-online')).toBeNull();
    // Who is playing is already known, as in every other game.
    expect(screen.getByTestId('playing-as')).toHaveTextContent('Rio');

    // 1 player: Play together and Free play. No computer opponent yet.
    fireEvent.click(screen.getByTestId('chess-count-1'));
    expect(screen.getByTestId('chess-lobby-count')).toHaveTextContent('1 player');
    expect(screen.getByTestId('mode-online')).toHaveTextContent('Play together');
    expect(screen.getByTestId('mode-free')).toHaveTextContent('Free play');
    expect(screen.queryByTestId('mode-local')).toBeNull();

    // Back is the count screen; 2 players: Same device and Play together.
    fireEvent.click(screen.getByTestId('chess-lobby-back'));
    fireEvent.click(screen.getByTestId('chess-count-2'));
    expect(screen.getByTestId('mode-local')).toHaveTextContent('Same device');
    expect(screen.getByTestId('mode-local')).toHaveTextContent('Pass the device after each move.');
    expect(screen.getByTestId('mode-online')).toBeInTheDocument();
    expect(screen.queryByTestId('mode-free')).toBeNull();
    expect(screen.getByTestId('chess-player2')).toHaveTextContent(/Player 2\s*Choose/);
  });

  it('Join with a code opens the code field alone, and joins as your ticket', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('chess-join-row'));
    expect(screen.queryByTestId('chess-create')).toBeNull();
    fireEvent.change(screen.getByTestId('chess-join-code'), { target: { value: 'efgh' } });
    fireEvent.click(screen.getByTestId('chess-join'));
    expect(sat.calls).toEqual([{ role: 'guest', code: 'EFGH', seatedUserId: 'u1' }]);
  });

  it('starts a same-device game and shows the board', () => {
    renderPage();
    startLocal();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    // White's chair starts on the signed-in player's ticket name.
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
  });

  it('plays a move and hands the turn to Black', () => {
    renderPage();
    startLocal();

    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));

    // The pawn has moved (a piece SVG now sits on e4) and it's Black's turn:
    // Flora, picked for chair two.
    expect(screen.getByTestId('sq-e4').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
  });

  it('names the player whose move it is, and takes moves back', () => {
    renderPage();
    // White is the signed-in ticket; Flora takes Black in the picker.
    startLocal();

    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);

    // Nothing to undo before the first move.
    expect(screen.getByTestId('chess-undo')).toBeDisabled();

    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
    expect(screen.getByTestId('sq-e4').querySelector('svg')).toBeTruthy();

    // Undo restores the pawn and hands the turn back to Rio.
    fireEvent.click(screen.getByTestId('chess-undo'));
    expect(screen.getByTestId('sq-e4').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('sq-e2').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    expect(screen.getByTestId('chess-undo')).toBeDisabled();
  });

  it('shows the move log and can return to an earlier move', () => {
    renderPage();
    startLocal();

    // Play 1.e4 e5 2.Nf3.
    for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]) {
      fireEvent.click(screen.getByTestId(`sq-${from}`));
      fireEvent.click(screen.getByTestId(`sq-${to}`));
    }
    expect(screen.getByTestId('sq-f3').querySelector('svg')).toBeTruthy();

    // Open the log (it lives in the ☰ menu now) — three plies are listed.
    fireEvent.click(screen.getByTestId('chess-menu'));
    fireEvent.click(screen.getByTestId('chess-log-open'));
    expect(screen.getByRole('dialog', { name: /move log/i })).toBeInTheDocument();
    expect(screen.getByTestId('log-ply-0')).toHaveTextContent('e4');
    expect(screen.getByTestId('log-ply-2')).toHaveTextContent(/Nf3/);

    // Pick the position after 1.e4 and rewind to it.
    fireEvent.click(screen.getByTestId('log-ply-0'));
    fireEvent.click(screen.getByTestId('chess-log-return'));

    // The knight move is undone, the board is back to Black-to-move after 1.e4.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('sq-f3').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('sq-e4').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
  });

  it('offers exactly two views — flat (the default) and 3D — behind the ☰ menu', () => {
    renderPage();
    startLocal();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();

    // The view options live in the ☰ menu now, as labelled rows.
    fireEvent.click(screen.getByTestId('chess-menu'));
    expect(screen.getByTestId('view-flat')).toBeInTheDocument();
    expect(screen.getByTestId('view-3d')).toBeInTheDocument();
    expect(screen.queryByTestId('view-table')).toBeNull();
    expect(screen.getByTestId('view-flat')).toHaveAttribute('data-selected', 'true');

    // Re-picking Flat persists the choice and closes the menu.
    fireEvent.click(screen.getByTestId('view-flat'));
    expect(localStorage.getItem('chess-view-v1')).toBe('flat');
    expect(screen.queryByTestId('view-flat')).toBeNull();
  });

  it('free play: place, move, clear, and end the sandbox', () => {
    renderPage();
    goFree();

    // Tap a white queen in the tray — it becomes a stamp: every square tapped
    // gets a queen, without re-picking from the tray.
    fireEvent.click(screen.getByTestId('fp-tray-w-q'));
    fireEvent.click(screen.getByTestId('fp-sq-e5'));
    fireEvent.click(screen.getByTestId('fp-sq-a1'));
    fireEvent.click(screen.getByTestId('fp-sq-h8'));
    expect(screen.getByTestId('fp-sq-e5').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('fp-sq-a1').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('fp-sq-h8').querySelector('svg')).toBeTruthy();

    // Tapping the tray piece again puts the stamp down.
    fireEvent.click(screen.getByTestId('fp-tray-w-q'));

    // Now board pieces can be picked up and moved — a one-shot, not a stamp.
    fireEvent.click(screen.getByTestId('fp-sq-e5'));
    fireEvent.click(screen.getByTestId('fp-sq-b2'));
    expect(screen.getByTestId('fp-sq-e5').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('fp-sq-b2').querySelector('svg')).toBeTruthy();

    // The eraser deletes specific pieces: toggle it on, tap pieces, they're
    // gone; it stays on until toggled off, and empty squares are no-ops.
    fireEvent.click(screen.getByTestId('fp-eraser-w'));
    fireEvent.click(screen.getByTestId('fp-sq-a1'));
    expect(screen.getByTestId('fp-sq-a1').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByTestId('fp-sq-h8'));
    expect(screen.getByTestId('fp-sq-h8').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByTestId('fp-sq-b2'));
    expect(screen.getByTestId('fp-sq-b2').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByTestId('fp-eraser-w')); // off again

    // Views, resets, and exit live in the ☰ menu.
    fireEvent.click(screen.getByTestId('fp-menu'));
    expect(screen.getByTestId('fp-view-3d')).toBeInTheDocument();

    // Starting lineup asks first (it replaces the whole board), then fills 32.
    fireEvent.click(screen.getByTestId('fp-lineup'));
    expect(screen.getByTestId('fp-confirm-lineup')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fp-confirm-lineup'));
    expect(screen.getByTestId('fp-board').querySelectorAll('svg').length).toBe(32);

    // Clear also confirms — and cancelling leaves the board alone.
    fireEvent.click(screen.getByTestId('fp-menu'));
    fireEvent.click(screen.getByTestId('fp-clear'));
    fireEvent.click(screen.getByTestId('fp-confirm-cancel'));
    expect(screen.getByTestId('fp-board').querySelectorAll('svg').length).toBe(32);
    fireEvent.click(screen.getByTestId('fp-clear'));
    fireEvent.click(screen.getByTestId('fp-confirm-clear'));
    expect(screen.getByTestId('fp-board').querySelectorAll('svg').length).toBe(0);

    // Exit (in the menu) returns to the 1-player ways it came from.
    fireEvent.click(screen.getByTestId('fp-menu'));
    fireEvent.click(screen.getByTestId('fp-end'));
    expect(screen.getByTestId('mode-free')).toBeInTheDocument();
  });

  it('switches the whole set to the unicorn theme and remembers it', () => {
    const { container } = renderPage();
    startLocal();

    // Classic by default.
    expect(container.querySelector('.chess-theme-classic')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')?.getAttribute('data-piece-theme')).toBeNull();

    // Via the ☰ menu: pink board class + unicorn piece art everywhere,
    // persisted; picking a world closes the menu so the change is visible.
    fireEvent.click(screen.getByTestId('chess-menu'));
    fireEvent.click(screen.getByTestId('theme-unicorn'));
    expect(container.querySelector('.chess-theme-unicorn')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')?.getAttribute('data-piece-theme')).toBe('unicorn');
    expect(localStorage.getItem('chess-theme-v1')).toBe('unicorn');

    // And the Galaxy Fleet is two more taps away.
    fireEvent.click(screen.getByTestId('chess-menu'));
    fireEvent.click(screen.getByTestId('theme-galaxy'));
    expect(container.querySelector('.chess-theme-galaxy')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')?.getAttribute('data-piece-theme')).toBe('galaxy');
    expect(localStorage.getItem('chess-theme-v1')).toBe('galaxy');
  });

  it('autosaves a hotseat game and resumes it later — names, moves and all', () => {
    const first = renderPage();
    startLocal();
    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));
    first.unmount(); // dinner time — everyone walks away

    // Back at the count screen, the saved game is offered…
    renderPage();
    const card = screen.getByTestId('chess-resume-local');
    expect(card).toHaveTextContent('Rio vs Flora');
    expect(card).toHaveTextContent(/1 move in/);

    // …and resuming restores the position and the turn.
    fireEvent.click(card);
    expect(screen.getByTestId('sq-e4').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
  });

  it('deep-links straight into the saved hotseat game (?resume=local)', () => {
    const first = renderPage();
    startLocal();
    fireEvent.click(screen.getByTestId('sq-d2'));
    fireEvent.click(screen.getByTestId('sq-d4'));
    first.unmount();

    renderPage('/chess?resume=local');
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(screen.getByTestId('sq-d4').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
  });

  it('restores a stored galaxy theme on load', () => {
    localStorage.setItem('chess-theme-v1', 'galaxy');
    const { container } = renderPage();
    startLocal();
    expect(container.querySelector('.chess-theme-galaxy')).toBeTruthy();
    expect(screen.getByTestId('sq-e2').querySelector('svg')?.getAttribute('data-piece-theme')).toBe('galaxy');
  });

  it('free play can promote its setup into a real rules-bound game', () => {
    renderPage();
    goFree();

    // No kings on the board yet — starting is refused with a friendly reason.
    fireEvent.click(screen.getByTestId('fp-start-game'));
    expect(screen.getByTestId('fp-start-issue')).toHaveTextContent(/king/i);

    // Place the two kings and a white queen (tray pieces stamp, so tap the
    // tray again to stop before switching pieces).
    fireEvent.click(screen.getByTestId('fp-tray-w-k'));
    fireEvent.click(screen.getByTestId('fp-sq-e1'));
    fireEvent.click(screen.getByTestId('fp-tray-w-k'));
    fireEvent.click(screen.getByTestId('fp-tray-b-k'));
    fireEvent.click(screen.getByTestId('fp-sq-e8'));
    fireEvent.click(screen.getByTestId('fp-tray-b-k'));
    fireEvent.click(screen.getByTestId('fp-tray-w-q'));
    fireEvent.click(screen.getByTestId('fp-sq-d4'));
    fireEvent.click(screen.getByTestId('fp-start-game'));

    // A real game now: the rules board is up, White (Rio) to move, position live.
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    expect(screen.getByTestId('sq-d4').querySelector('svg')).toBeTruthy();

    // And it IS rules-bound: the queen may not hop like a knight.
    fireEvent.click(screen.getByTestId('sq-d4'));
    fireEvent.click(screen.getByTestId('sq-e6'));
    expect(screen.getByTestId('sq-e6').querySelector('svg')).toBeNull();
    // …but slides legally, handing the turn to Black.
    fireEvent.click(screen.getByTestId('sq-d4'));
    fireEvent.click(screen.getByTestId('sq-d6'));
    expect(screen.getByTestId('sq-d6').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Black to move/);
  });

  it('refuses to start a free-play game that is already checkmate', () => {
    renderPage();
    goFree();

    // Ka1 trapped by Qb2 guarded by Kb3 — mate before move one.
    fireEvent.click(screen.getByTestId('fp-tray-w-k'));
    fireEvent.click(screen.getByTestId('fp-sq-a1'));
    fireEvent.click(screen.getByTestId('fp-tray-w-k'));
    fireEvent.click(screen.getByTestId('fp-tray-b-q'));
    fireEvent.click(screen.getByTestId('fp-sq-b2'));
    fireEvent.click(screen.getByTestId('fp-tray-b-q'));
    fireEvent.click(screen.getByTestId('fp-tray-b-k'));
    fireEvent.click(screen.getByTestId('fp-sq-b3'));
    fireEvent.click(screen.getByTestId('fp-tray-b-k'));

    fireEvent.click(screen.getByTestId('fp-start-game'));
    expect(screen.getByTestId('fp-start-issue')).toHaveTextContent(/checkmated/);
    // Still in the sandbox, not a game.
    expect(screen.queryByTestId('chess-board')).toBeNull();
  });

  it('free play offers the theme picker too (in the menu)', () => {
    localStorage.setItem('chess-theme-v1', 'unicorn');
    const { container } = renderPage();
    goFree();

    // The stored choice applies, and the sandbox can switch back.
    expect(container.querySelector('.chess-theme-unicorn')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fp-tray-w-q'));
    fireEvent.click(screen.getByTestId('fp-sq-e5'));
    expect(screen.getByTestId('fp-sq-e5').querySelector('svg')?.getAttribute('data-piece-theme')).toBe('unicorn');

    fireEvent.click(screen.getByTestId('fp-menu'));
    fireEvent.click(screen.getByTestId('fp-theme-galaxy'));
    expect(container.querySelector('.chess-theme-galaxy')).toBeTruthy();

    fireEvent.click(screen.getByTestId('fp-theme-classic'));
    expect(container.querySelector('.chess-theme-classic')).toBeTruthy();
  });

  it('the online lobby plays as your ticket — no name box in sight', () => {
    renderPage();
    goOnline();
    // Who you are is the ticket you signed in with; nothing asks again.
    expect(screen.getByTestId('playing-as')).toHaveTextContent('Rio');
    expect(screen.getByTestId('playing-as-change')).toHaveTextContent('Switch player ›');
    expect(screen.queryByTestId('chess-name')).toBeNull();
    expect(screen.getByTestId('chess-create')).toBeInTheDocument();
    expect(screen.getByTestId('chess-join-code')).toBeInTheDocument();
  });

  it('Same device with chair two empty opens the arcade picker for Player 2; a pick starts the game and signs nobody in', () => {
    renderPage();
    choose(2, 'mode-local');

    // The arcade's own picker, opened for the second chair, without the
    // player already holding the device.
    expect(screen.getByRole('dialog', { name: 'Choose Player 2' })).toBeInTheDocument();
    expect(screen.queryByTestId('chess-p2-user-u1')).toBeNull();
    expect(screen.queryByTestId('chess-board')).toBeNull();

    fireEvent.click(screen.getByTestId('chess-p2-user-u2'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);

    // Sitting down at a chair is not signing in: Rio still holds the device,
    // and nobody was renamed.
    const roster = JSON.parse(localStorage.getItem('arcade.users.v1') ?? '{}');
    expect(roster.activeId).toBe('u1');
    expect(roster.users.map((u: { profile: { name: string } }) => u.profile.name)).toEqual(['Rio', 'Flora']);
  });

  it('the Player 2 row picks without starting, then Same device plays', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    fireEvent.click(screen.getByTestId('chess-player2'));
    fireEvent.click(screen.getByTestId('chess-p2-user-u2'));

    // Still the 2-player screen, with the medal and the name in the row, and
    // the keyboard back on it.
    expect(screen.queryByTestId('chess-board')).toBeNull();
    expect(screen.getByTestId('chess-player2')).toHaveTextContent(/Player 2\s*F\s*Flora/);
    expect(screen.getByTestId('chess-player2')).toHaveFocus();

    fireEvent.click(screen.getByTestId('mode-local'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
  });

  it('a new name in the picker makes a profile for chair two without signing it in', () => {
    renderPage();
    choose(2, 'mode-local');
    fireEvent.change(screen.getByTestId('chess-p2-name'), { target: { value: 'Kai' } });
    fireEvent.click(screen.getByTestId('chess-p2-create'));

    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Kai to move/);
    const roster = getUsersSnapshot();
    expect(roster.activeId).toBe('u1');
    expect(roster.users.map((u) => u.profile.name)).toEqual(['Rio', 'Flora', 'Kai']);
  });

  it('the Player 2 picker closes on Escape, and nothing starts', () => {
    renderPage();
    choose(2, 'mode-local');
    expect(screen.getByTestId('chess-p2-picker')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('chess-p2-picker')).toBeNull();
    expect(screen.queryByTestId('chess-board')).toBeNull();
    expect(screen.getByTestId('chess-player2')).toHaveFocus();
  });

  it('next visit opens with the same Player 2, and Same device plays straight away', () => {
    const first = renderPage();
    startLocal();
    first.unmount();

    // Same browser, next visit: the lineup the game started with is remembered.
    renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    expect(screen.getByTestId('chess-player2')).toHaveTextContent('Flora');
    fireEvent.click(screen.getByTestId('mode-local'));
    expect(screen.queryByTestId('chess-p2-picker')).toBeNull();
    expect(screen.getByTestId('chess-board')).toBeInTheDocument();
  });

  it('free play owns the whole window, and gives it back on exit', () => {
    renderPage();
    expect(document.querySelector('.chess-immersive')).toBeNull();
    goFree();
    expect(document.querySelector('.chess-immersive')).not.toBeNull();
    fireEvent.click(screen.getByTestId('fp-menu'));
    fireEvent.click(screen.getByTestId('fp-end'));
    expect(document.querySelector('.chess-immersive')).toBeNull();
  });

  it('a Player 2 picked and abandoned changes nothing for next time', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    fireEvent.click(screen.getByTestId('chess-player2'));
    fireEvent.click(screen.getByTestId('chess-p2-user-u2'));
    expect(screen.getByTestId('chess-player2')).toHaveTextContent('Flora');

    // Back to the count screen without starting: nothing was played, so
    // nothing is remembered.
    fireEvent.click(screen.getByTestId('chess-lobby-back'));
    expect(screen.getByTestId('chess-count-2')).toBeInTheDocument();
    expect(localStorage.getItem(LINEUP_KEY)).toBeNull();
  });

  it('Swap gives Player 2 White, one tap away, and the next visit remembers it', () => {
    const first = renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    fireEvent.click(screen.getByTestId('chess-player2'));
    fireEvent.click(screen.getByTestId('chess-p2-user-u2'));
    expect(screen.getByTestId('chess-player2')).toHaveAccessibleName(/Flora\s*, plays Black/);

    const swap = screen.getByRole('button', { name: 'Swap sides' });
    expect(swap).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(swap);
    expect(swap).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chess-player2')).toHaveAccessibleName(/Flora\s*, plays White/);

    // Flora moves first; Rio answers as Black.
    fireEvent.click(screen.getByTestId('mode-local'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
    fireEvent.click(screen.getByTestId('sq-e2'));
    fireEvent.click(screen.getByTestId('sq-e4'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    expect(JSON.parse(localStorage.getItem(LINEUP_KEY) ?? '{}').chess).toEqual([{ userId: 'u2' }, { userId: 'u1' }]);
    first.unmount();

    // Next visit: still swapped, and Swap puts Rio back on White.
    renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    expect(screen.getByTestId('chess-swap')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('chess-swap'));
    fireEvent.click(screen.getByTestId('mode-local'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    expect(JSON.parse(localStorage.getItem(LINEUP_KEY) ?? '{}').chess).toEqual([{ userId: 'u1' }, { userId: 'u2' }]);
  });

  it('a lineup with someone else at Black still seats Rio as White', () => {
    // Last time Flora played White against Kai; Rio holds the device now.
    setLineup('chess', [{ userId: 'u2' }, { userId: 'u3' }]);
    renderPage();
    fireEvent.click(screen.getByTestId('chess-count-2'));
    expect(screen.getByTestId('chess-swap')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('mode-local'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
  });
});

describe('<ChessPage> — results land on the tickets that sat down', () => {
  const sq = (name: string): Square => ({ row: 8 - Number(name[1]), col: 'abcdefgh'.indexOf(name[0]) });
  const ply = (from: string, to: string): Ply => ({ from: sq(from), to: sq(to) });
  /** Fool's mate as square pairs: 1.f3 e5 2.g4 Qh4# — Black wins. */
  const FOOLS_MATE: Array<[string, string]> = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];

  const tap = (from: string, to: string) => {
    fireEvent.click(screen.getByTestId(`sq-${from}`));
    fireEvent.click(screen.getByTestId(`sq-${to}`));
  };
  const profileOf = (id: string) => getUsersSnapshot().users.find((u) => u.id === id)!.profile;
  /** Drop a hotseat autosave in the slot, the way the game writes it. */
  const saveHotseat = (over: Partial<StoredLocalChess>) => {
    const save: StoredLocalChess = { v: 1, whiteName: 'Rio', blackName: 'Flora', log: [], updatedAt: 1, ...over };
    localStorage.setItem('chess:local:v1', JSON.stringify(save));
  };

  it("same device: checkmate is a win for the winner's ticket and a loss for the other — nobody else's", () => {
    // Rio holds the device and picks Flora for Player 2; Kai is on the roster
    // but not at the board.
    setUsersState(
      setActiveUser(
        addUser(addUser(addUser(emptyUsersState(), 'u1', 'Rio'), 'u2', 'Flora'), 'u3', 'Kai'),
        'u1',
      ),
    );
    renderPage();
    startLocal();

    for (const [from, to] of FOOLS_MATE) tap(from, to);
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Flora wins!');

    const flora = profileOf('u2');
    expect(flora.wins).toBe(1);
    expect(flora.history).toHaveLength(1);
    expect(flora.history[0]).toMatchObject({ game: 'chess', code: 'chess', opponent: 'Rio', result: 'win' });
    expect(flora.points).toBe(pointsForResult(true, 0));

    const rio = profileOf('u1');
    expect(rio.losses).toBe(1);
    expect(rio.history).toHaveLength(1);
    expect(rio.history[0]).toMatchObject({ game: 'chess', opponent: 'Flora', result: 'loss' });

    // Kai was never at the board: no row, no points.
    expect(profileOf('u3').history).toHaveLength(0);
    expect(profileOf('u3').points).toBe(0);
  });

  it('same device: a draw records nothing for anybody', () => {
    // Kb6 + Qh7 against a lone Ka8, White to move: Qc7 is stalemate.
    saveHotseat({ whiteUserId: 'u1', blackUserId: 'u2', start: parseFen('k7/7Q/1K6/8/8/8/8/8 w - - 0 1') });
    const before = getUsersSnapshot();
    renderPage('/chess?resume=local');
    tap('h7', 'c7');
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('A Draw');
    expect(getUsersSnapshot()).toBe(before);
  });

  it('same device: an empty chair records nothing — the ticket across the board still gets its row', () => {
    // Free play promotes its board with whoever is at the table; with no
    // Player 2 picked yet, Black's chair is empty.
    renderPage();
    goFree();
    for (const [piece, square] of [['w-k', 'b6'], ['b-k', 'a8'], ['w-q', 'h7']]) {
      fireEvent.click(screen.getByTestId(`fp-tray-${piece}`));
      fireEvent.click(screen.getByTestId(`fp-sq-${square}`));
      fireEvent.click(screen.getByTestId(`fp-tray-${piece}`));
    }
    fireEvent.click(screen.getByTestId('fp-start-game'));
    tap('h7', 'b7'); // Qb7#
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Rio wins!');

    const rio = profileOf('u1');
    expect(rio.wins).toBe(1);
    expect(rio.history[0]).toMatchObject({ opponent: 'Black', result: 'win' });
    // Flora was never at the table.
    expect(profileOf('u2').history).toHaveLength(0);
    expect(getUsersSnapshot().users.reduce((n, u) => n + u.profile.losses, 0)).toBe(0);
  });

  it('online: the result lands on the ticket that sat down, even after someone else signs in mid-game', () => {
    renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-create'));
    const { code } = sat.calls[0] as { code: string };
    act(() => net.handlers.onMessage({ t: 'hello', v: 1, side: 'guest', name: 'Kai' }));

    // Rio (host, White) walks into fool's mate; Kai's moves arrive off the wire.
    tap('f2', 'f3');
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('e7', 'e5') }));
    tap('g2', 'g4');
    // Flora picks up the device and signs in before the mate lands.
    act(() => setUsersState(setActiveUser(getUsersSnapshot(), 'u2')));
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('d8', 'h4') }));

    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Kai wins!');
    expect(screen.getByText(new RegExp(`\\+${pointsForResult(false, 0)} points`))).toBeInTheDocument();
    // "You now have…" would read Flora's total — the bystander's — so the line stays off.
    expect(screen.queryByText(/You now have/)).toBeNull();

    const rio = profileOf('u1');
    expect(rio.losses).toBe(1);
    expect(rio.history).toHaveLength(1);
    expect(rio.history[0]).toMatchObject({ code, game: 'chess', opponent: 'Kai', result: 'loss' });
    // Flora is signed in now — and untouched.
    expect(profileOf('u2').history).toHaveLength(0);
    expect(profileOf('u2').losses).toBe(0);
  });

  it('a same-device save from before tickets rode along finishes without recording', () => {
    saveHotseat({ log: FOOLS_MATE.slice(0, 3).map(([f, t]) => ply(f, t)) });
    const before = getUsersSnapshot();
    renderPage('/chess?resume=local');
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Flora to move/);
    tap('d8', 'h4');
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Flora wins!');
    expect(getUsersSnapshot()).toBe(before);
  });

  it('online: the mate is recorded once — the reopened link replaying the finished log adds no second row', () => {
    renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-create'));
    act(() => net.handlers.onMessage({ t: 'hello', v: 1, side: 'guest', name: 'Kai' }));
    tap('f2', 'f3');
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('e7', 'e5') }));
    tap('g2', 'g4');
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('d8', 'h4') }));
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Kai wins!');

    const points = pointsForResult(false, 0);
    expect(profileOf('u1').history).toHaveLength(1);
    expect(profileOf('u1').points).toBe(points);
    // Rio sat down AND is signed in: the card's running total is Rio's.
    expect(screen.getByText(`You now have ${points} points.`)).toBeInTheDocument();

    // The iPad slept; the link reopens and Kai's handshake replays the very
    // same finished log. Nothing new happened — nothing new is recorded.
    act(() =>
      net.handlers.onMessage({ t: 'sync', log: FOOLS_MATE.map(([f, t]) => ply(f, t)), wantRematch: false, epoch: 0 }),
    );
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Kai wins!');
    expect(profileOf('u1').history).toHaveLength(1);
    expect(profileOf('u1').losses).toBe(1);
    expect(profileOf('u1').points).toBe(points);
  });

  it('host in a party: the mate closes the table, so a friend who reloads is never sat down at a finished game', () => {
    mockParty.value = fakePartyWithKai('host');
    renderPage();
    goOnline();
    fireEvent.click(screen.getByTestId('chess-party-play'));
    act(() => net.handlers.onMessage({ t: 'hello', v: 1, side: 'guest', name: 'Kai' }));
    expect(mockParty.value.closeTable).not.toHaveBeenCalled();

    tap('f2', 'f3');
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('e7', 'e5') }));
    tap('g2', 'g4');
    act(() => net.handlers.onMessage({ t: 'move', ply: ply('d8', 'h4') }));
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Kai wins!');
    expect(mockParty.value.closeTable).toHaveBeenCalledWith('WXYZ');
  });

  it('a game promoted from free play ends like any other — both chairs get their rows', () => {
    setLineup('chess', [{ userId: 'u1' }, { userId: 'u2' }]);
    renderPage();
    goFree();
    // Kb6 + Qh7 against a lone Ka8, one move from mate. Tray pieces stamp,
    // so each is tapped again to put the stamp down before the next.
    for (const [piece, square] of [['w-k', 'b6'], ['b-k', 'a8'], ['w-q', 'h7']]) {
      fireEvent.click(screen.getByTestId(`fp-tray-${piece}`));
      fireEvent.click(screen.getByTestId(`fp-sq-${square}`));
      fireEvent.click(screen.getByTestId(`fp-tray-${piece}`));
    }
    fireEvent.click(screen.getByTestId('fp-start-game'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);

    tap('h7', 'b7'); // Qb7#
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Rio wins!');
    const rio = profileOf('u1');
    expect(rio.wins).toBe(1);
    expect(rio.history[0]).toMatchObject({ game: 'chess', code: 'chess', opponent: 'Flora', result: 'win' });
    const flora = profileOf('u2');
    expect(flora.losses).toBe(1);
    expect(flora.history[0]).toMatchObject({ game: 'chess', opponent: 'Rio', result: 'loss' });
  });

  it('same device: playing again after the mate records a second pair of rows — the chairs keep their tickets', () => {
    setLineup('chess', [{ userId: 'u1' }, { userId: 'u2' }]);
    renderPage();
    startLocal();
    for (const [from, to] of FOOLS_MATE) tap(from, to);
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Flora wins!');

    fireEvent.click(screen.getByTestId('chess-rematch'));
    expect(screen.getByTestId('chess-turn')).toHaveTextContent(/Rio to move/);
    for (const [from, to] of FOOLS_MATE) tap(from, to);
    expect(screen.getByTestId('chess-result-headline')).toHaveTextContent('Flora wins!');

    expect(profileOf('u2').wins).toBe(2);
    expect(profileOf('u2').history).toHaveLength(2);
    expect(profileOf('u1').losses).toBe(2);
    expect(profileOf('u1').history).toHaveLength(2);
  });
});
