import '../styles/chess.css';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useProfile } from '@shared/profile/useProfile';
import { useParty, type PartyValue } from '@shared/party/PartyContext';
import { usePartyDoor } from '@shared/party/usePartyDoor';
import { useChess, type StartTableOptions } from '@games/chess/state/useChess';
import { pointsForResult } from '@shared/profile/profile';
import { recordResultFor } from '@shared/profile/results';
import { generateCode, normalizeCode } from '@shared/net/peer';
import { PlayingAs } from '@shared/profile/PlayingAs';
import { SeatPlayerPicker, type PickedPlayer } from '@shared/profile/SeatPlayerPicker';
import { useSeats } from '@shared/profile/useSeats';
import { EMPTY_SEAT, seatName, type Seat } from '@shared/profile/seats';
import { ChessBoard } from './ChessBoard';
import { CountCards, LobbyRow, LobbyTop, PlayerTwoRow, WayCard, type PlayerCount } from './ChessLobby';
import { ChessResult } from './ChessResult';
import { ChessLogModal, CapturedTray } from './ChessLogModal';
import { FreePlay } from './FreePlay';
import { CHESS_THEME_KEY, CHESS_THEMES, ChessThemeContext, storedChessTheme, type ChessThemeId } from './chessTheme';

// three.js is heavy, so the 3D board loads on demand — picking Flat or Table
// never downloads it.
const Chess3D = lazy(() => import('./Chess3D'));

type BoardView = 'flat' | '3d';
import { ConnectionBadge } from '@shared/ui/ConnectionBadge';
import { FullscreenButton } from '@shared/ui/FullscreenButton';
import { useDismissOnEscape } from '@shared/ui/useDismissOnEscape';
import { CloseIcon, GridIcon, ListIcon, PartyIcon, TargetIcon } from '@shared/ui/icons';
import { loadLocalChessGame, loadResumableChessGame } from '../storage/chessPersistence';
import { customStart, winnerOf, status as statusOf } from '@games/chess/domain/rules';
import { analyzeGame, tallyCaptures } from '@games/chess/domain/analysis';
import type { FinishInfo } from '@games/chess/domain/session';
import type { Color, GameState, PieceType, Ply, Status } from '@games/chess/domain/types';

/**
 * The lobby's steps: the count screen ('pick'), the ways to play for 1 or 2
 * players, then the online lobby or the free-play sandbox. Same device has no
 * step of its own: its card starts the game.
 */
type Setup = 'pick' | 'one' | 'two' | 'online' | 'free';

/** The ways to play, as the cards name them. */
const WAYS = {
  local: { label: 'Same device', line: 'Pass the device after each move.', testId: 'mode-local' },
  online: { label: 'Play together', line: 'Share one code and play on two devices.', testId: 'mode-online' },
  free: { label: 'Free play', line: 'Move any piece anywhere and set up any board.', testId: 'mode-free' },
} as const;

const WAY_ICON = 120;

/** The registry id — the seats, the profile's history and the party's table all key on it. */
const GAME_ID = 'chess';

/** One line under each world in the ☰ menu, so picking isn't a guess. */
const THEME_BLURBS: Record<ChessThemeId, string> = {
  classic: 'The leather-and-brass War Room',
  unicorn: 'The Cloud Kingdom, high above the clouds',
  galaxy: 'Comet Guard starships against the Nebula Fleet',
};

interface ResultSummary {
  status: Status;
  pointsEarned: number;
}

/**
 * What the online panel shows. In a party the friend is already here, so the
 * code doors give way to one tap (host) or a quiet wait (guest); while a
 * remembered party is still dialling, neither is right yet.
 */
type Lobby = 'doors' | 'reconnecting' | 'party-host' | 'party-guest';

function lobbyFor(party: PartyValue): Lobby {
  if (party.reconnecting) return 'reconnecting';
  if (party.inParty && party.role === 'host') return 'party-host';
  if (party.inParty && party.role === 'guest') return 'party-guest';
  return 'doors';
}

/** A colour off the wire — the party carries the host's side as a plain string. */
function asColor(side: string | undefined): Color | undefined {
  return side === 'w' || side === 'b' ? side : undefined;
}

/**
 * Who sat across the board last time: the remembered lineup's other ticket,
 * whichever chair it was in, never the player holding the device.
 */
function rememberedOpponent(seats: Seat[], meId: string | null): string | null {
  const other = [seats[1], seats[0]].find((s) => s?.kind === 'ticket' && s.userId !== meId);
  return other?.kind === 'ticket' ? other.userId : null;
}

/** Whether the player holding the device sat at Black last time. */
function rememberedBlack(seats: Seat[], meId: string | null): boolean {
  const black = seats[1];
  return meId !== null && black?.kind === 'ticket' && black.userId === meId;
}

/** The ticket in a chair, for the result — a bot or an empty chair credits nobody. */
function ticketOf(seat: Seat): string | null {
  return seat.kind === 'ticket' ? seat.userId : null;
}

export function ChessPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const profile = useProfile();
  const [setup, setSetup] = useState<Setup>('pick');
  // The count picked on the first screen, shown as a coin on the steps after.
  const [count, setCount] = useState<PlayerCount | null>(null);
  // The online lobby opened from Join with a code (or a shared link) shows
  // only the code field; from Play together it shows both doors.
  const [joinOnly, setJoinOnly] = useState(false);
  const [finish, setFinish] = useState<ResultSummary | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  useDismissOnEscape(shareOpen, () => setShareOpen(false));
  const [copied, setCopied] = useState(false);
  const [joinInput, setJoinInput] = useState(normalizeCode(params.get('g') ?? ''));
  // The two same-device chairs: whoever is playing, the signed-in ticket, and
  // Player 2, picked in the arcade's player picker opened for that chair. The
  // player holding the device plays White unless the sides are swapped. Both
  // start as they were last time. Seating someone never signs them in or
  // renames them.
  const table = useSeats(GAME_ID, 2);
  const meId = profile.userId;
  const [playerTwoId, setPlayerTwoId] = useState<string | null>(null);
  const playerTwo = playerTwoId && playerTwoId !== meId ? playerTwoId : rememberedOpponent(table.seats, meId);
  const [swapped, setSwapped] = useState<boolean | null>(null);
  const meBlack = swapped ?? rememberedBlack(table.seats, meId);
  /** White's chair first, then Black's. */
  const chairsWith = (two: string | null): Seat[] => {
    const me: Seat = meId ? { kind: 'ticket', userId: meId } : EMPTY_SEAT;
    const other: Seat = two ? { kind: 'ticket', userId: two } : EMPTY_SEAT;
    return meBlack ? [other, me] : [me, other];
  };
  // The picker for chair two, and whether picking someone also starts the
  // game (it does when Same device was tapped with the chair still empty).
  const [pickTwo, setPickTwo] = useState<null | 'choose' | 'start'>(null);
  const playerTwoRef = useRef<HTMLButtonElement>(null);
  const [logOpen, setLogOpen] = useState(false);
  // The ☰ options menu: board view, world, move log. Undo stays outside, in
  // the title bar — taking back a move shouldn't cost two taps.
  const [menuOpen, setMenuOpen] = useState(false);
  useDismissOnEscape(menuOpen, () => setMenuOpen(false));
  // Board view — flat or full 3D. Remembered per device.
  // The set's look — classic/unicorn/galaxy — shared with every view via context.
  const [theme, setThemeState] = useState<ChessThemeId>(storedChessTheme);
  const setTheme = (t: ChessThemeId) => {
    setThemeState(t);
    try { localStorage.setItem(CHESS_THEME_KEY, t); } catch { /* ignore */ }
  };

  const [view, setView] = useState<BoardView>(() => {
    try {
      // Older builds stored 'table' — that mode is gone; fold it into flat.
      return localStorage.getItem('chess-view-v1') === '3d' ? '3d' : 'flat';
    } catch { return 'flat'; }
  });
  const pickView = (v: BoardView) => {
    setView(v);
    try { localStorage.setItem('chess-view-v1', v); } catch { /* ignore */ }
  };

  // The 3D camera: a Reset view button appears in the title bar once the
  // player has orbited or cursor-zoomed away from the opening framing.
  const [camDirty, setCamDirty] = useState(false);
  const resetViewRef = useRef<(() => void) | null>(null);

  // The party you're in, if any — it decides which online lobby you see, and
  // its table closes with the game.
  const party = useParty();
  const lobby = lobbyFor(party);
  const { closeTable } = party;

  const onFinish = useCallback((info: FinishInfo) => {
    // Results land on the tickets the session captured when the game started
    // — never on the roster as it stands now, since a sign-in switch between
    // the first move and the mate must not move the row. Draws record
    // nothing; so does a chair with no ticket (a bot, or nobody).
    const finishedAt = Date.now();
    const row = (won: boolean, opponent: string) => ({
      won,
      survivingCells: 0,
      code: info.code || GAME_ID,
      game: GAME_ID,
      // The real name, not a placeholder — every chess row in the history
      // used to say "Opponent" even though the hello name was known.
      opponent: opponent || 'Opponent',
      finishedAt,
    });
    let pointsEarned = 0;
    if (info.iWon !== null) {
      // Online, decisive: my ticket's result against the friend's hello name.
      pointsEarned = pointsForResult(info.iWon, 0);
      recordResultFor(info.seatedUserId, row(info.iWon, info.opponent));
    } else if (info.winner !== null) {
      // Same device, decisive: a win for the winning chair, a loss for the
      // other. Points on the card are an online thing; here the ledger
      // credit is what each ticket gets.
      recordResultFor(info.whiteUserId, row(info.winner === 'w', info.blackName));
      recordResultFor(info.blackUserId, row(info.winner === 'b', info.whiteName));
    }
    // Online, the game closes the host's table with it, so a friend who
    // reloads after the result is never sat down at a finished game. (The
    // party ignores this unless we are the host and this is the open table.)
    if (info.code) closeTable(info.code);
    setFinish({ status: info.status, pointsEarned });
  }, [closeTable]);

  const cx = useChess({ name: profile.profile.name, onFinish });
  // Host in a party: the colour you'll play. Your friend gets the other one.
  // 'flip': the coin decides the moment you tap Play.
  const [hostSide, setHostSide] = useState<Color | 'flip'>('w');
  const inGame = cx.phase === 'play' || cx.phase === 'over';
  // The hook's actions are stable; `cx` itself is a fresh object every render.
  const { startTable, leave: hangUp } = cx;
  /** Sit down at an online table as the signed-in ticket. */
  const sitDown = useCallback(
    (opts: Omit<StartTableOptions, 'seatedUserId'>) => startTable({ ...opts, seatedUserId: profile.userId }),
    [startTable, profile.userId],
  );
  /**
   * Start a same-device game with the chairs as they stand — names to show,
   * tickets to credit — remembering the lineup for next time. Called from
   * click handlers only, so it needn't be memoised.
   */
  // Player 2's name travels with the pick: a profile made in the picker a
  // moment ago is not in this render's roster yet.
  const startHotseat = (
    start?: GameState,
    two: PickedPlayer | null = playerTwo
      ? { userId: playerTwo, name: seatName({ kind: 'ticket', userId: playerTwo }, table.users) }
      : null,
  ) => {
    const chairs = chairsWith(two?.userId ?? null);
    table.remember(chairs);
    const meChair = chairs[meBlack ? 1 : 0];
    const me = { name: seatName(meChair, table.users), userId: ticketOf(meChair) };
    const other = { name: two?.name ?? '', userId: two?.userId ?? null };
    const [white, black] = meBlack ? [other, me] : [me, other];
    cx.startLocal(
      { name: white.name || 'White', userId: white.userId },
      { name: black.name || 'Black', userId: black.userId },
      start,
    );
  };
  /** Same device: straight into the game when chair two is filled, else pick first. */
  const playSameDevice = () => {
    if (playerTwo) startHotseat();
    else setPickTwo('start');
  };
  const closePickTwo = () => {
    setPickTwo(null);
    playerTwoRef.current?.focus();
  };
  const onPickTwo = (two: PickedPlayer) => {
    const startNow = pickTwo === 'start';
    setPlayerTwoId(two.userId);
    setPickTwo(null);
    if (startNow) startHotseat(undefined, two);
    else playerTwoRef.current?.focus();
  };
  /** Back to the count screen, from any later step. */
  const toCount = () => {
    setSetup('pick');
    setCount(null);
    setJoinOnly(false);
  };
  const openOnline = (from: PlayerCount | null, onlyJoin: boolean) => {
    setCount(from);
    setJoinOnly(onlyJoin);
    setSetup('online');
  };
  // A guest in a party stands at the one door: it knocks while the online
  // lobby is up with no table open, and sits down the moment the host opens
  // one. A table that goes away while its dial is still ringing gets hung up;
  // a game that is actually connected is never torn down from here.
  const onTable = useCallback(
    (code: string, side?: string) => sitDown({ role: 'guest', code, hostSide: asColor(side) }),
    [sitDown],
  );
  const onClosed = useCallback(() => {
    if (cx.mode === 'online' && cx.side === 'guest' && !cx.oppConnected) hangUp();
  }, [cx.mode, cx.side, cx.oppConnected, hangUp]);
  const door = usePartyDoor(GAME_ID, !inGame && setup === 'online', onTable, onClosed);

  // Deep links: resume the saved hotseat game (?resume=local, used by the
  // arcade's saved-games list), resume a saved online game (?resume=CODE),
  // or pre-fill a join code from a shared link (?g=CODE).
  const bootRef = useRef(false);
  const resumeCode = params.get('resume');
  const joinCode = params.get('g');
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (resumeCode === 'local') {
      cx.resumeLocal();
    } else if (resumeCode) {
      setSetup('online');
      cx.resumeGame(resumeCode);
    } else if (joinCode) {
      setJoinOnly(true);
      setSetup('online');
    }
    return () => {
      bootRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeCode, joinCode]);

  useEffect(() => {
    if (cx.phase !== 'over') setFinish(null);
  }, [cx.phase]);

  // Host waits for the guest to connect: show the invite until the link opens.
  // In a party there is nobody to invite — the friend is already walking in.
  const hostWaiting =
    cx.mode === 'online' && cx.side === 'host' && !cx.oppConnected && cx.phase !== 'over' && !party.inParty;
  useEffect(() => {
    if (hostWaiting) setShareOpen(true);
    else if (cx.oppConnected) setShareOpen(false);
  }, [hostWaiting, cx.oppConnected]);

  const shareUrl = `${location.origin}${import.meta.env.BASE_URL}#/chess?g=${cx.code}`;
  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the code is shown regardless */
    }
  };

  // Both ways out close the host's table with the game, so the friend's
  // screen stops pointing at a board nobody is sitting at. (The party
  // ignores this unless we are the host and this is the open table.)
  // ‹ Menu keeps the save for the Save Station; Back to menu leaves for good.
  const goMenu = () => {
    if (cx.code) party.closeTable(cx.code);
    navigate('/');
  };
  const exitToMenu = () => {
    if (cx.code) party.closeTable(cx.code);
    cx.leave();
    navigate('/');
  };

  const onMove = (ply: Ply) => cx.move(ply);

  // The move log + captured pieces are pure views of the log.
  const moves = useMemo(() => analyzeGame(cx.log, cx.start ?? undefined), [cx.log, cx.start]);
  const caps = useMemo(() => tallyCaptures(moves), [moves]);
  // Stable identity: a fresh {from,to} literal per render would re-fire the
  // 3D board's mark effect (and its geometry rebuild) on every render.
  const lastMove = useMemo(() => lastMoveSquares(cx.log), [cx.log]);
  const boardOrientation: Color = cx.mode === 'online' && cx.myColor ? cx.myColor : 'w';
  const nameW = (cx.myColor === 'b' ? cx.oppName : cx.myName) || 'White';
  const nameB = (cx.myColor === 'b' ? cx.myName : cx.oppName) || 'Black';

  const showCodeChip = cx.mode === 'online' && cx.side === 'host' && !cx.oppConnected && cx.phase === 'play';
  // Unfinished games offered on the mode picker: the last online game, and
  // the same-device autosave slot.
  const resumableChess = !inGame && setup === 'pick' ? loadResumableChessGame() : null;
  const resumableLocal = !inGame && setup === 'pick' ? loadLocalChessGame() : null;

  // In 3D the scene owns the whole window — stars in every direction; the
  // title bar and the hint float over it.
  // The board owns the whole window in 3D play and in free play (flat or 3D):
  // the title bar, trays, hint and actions float over its edges.
  const immersive = (cx.phase === 'play' && view === '3d') || (!inGame && setup === 'free');
  // The lobby steps wear their own title bar: back, the count coin, the sign.
  const inLobby = !inGame && setup !== 'free';
  const playerTwoIndex = playerTwo ? table.users.findIndex((u) => u.id === playerTwo) : -1;
  const playerTwoName = playerTwoIndex >= 0 ? table.users[playerTwoIndex].profile.name : null;

  return (
    <ChessThemeContext.Provider value={{ theme, setTheme }}>
    <div className={`app chess-theme-${theme}${immersive ? ' chess-immersive' : ''}${inLobby ? ' chess-lobby' : ''}`}>
      {inLobby && (
        <LobbyTop
          count={setup === 'pick' ? null : count}
          backLabel={setup === 'pick' ? 'Back to the arcade' : 'Back to player count'}
          onBack={setup === 'pick' ? goMenu : toCount}
          badge={cx.side ? { status: cx.status, detail: cx.statusDetail } : undefined}
        />
      )}
      {!inLobby && (
      <div className="topbar">
        <button className="back-link" onClick={goMenu} data-testid="chess-back">‹ Menu</button>
        <h1>Chess</h1>
        {/* Whose move it is lives in the title bar now — the side panel that
            used to carry it gave its space back to the board. */}
        {cx.phase === 'play' && (
          <span className="turn-chip" data-testid="chess-turn">
            <span className={`pl-dot ${cx.turn === 'w' ? 'light' : 'dark'}`} aria-hidden="true" />
            <strong>{cx.turn === 'w' ? nameW : nameB}</strong>{' to move'}
            {statusOf(cx.board) === 'check' && <span className="pl-check">Check!</span>}
          </span>
        )}
        <span className="spacer" />
        {showCodeChip && (
          <button className="code-chip" onClick={() => setShareOpen(true)} data-testid="chess-share-chip">
            <span className="lbl">Code</span>
            <strong data-testid="chess-code">{cx.code}</strong>
          </button>
        )}
        {cx.side && <ConnectionBadge status={cx.status} detail={cx.statusDetail} />}
        {cx.phase === 'play' && view === '3d' && camDirty && (
          <button
            className="btn btn-ghost chess-reset-btn"
            onClick={() => resetViewRef.current?.()}
            data-testid="chess-reset-view"
          >
            ⤢ Reset view
          </button>
        )}
        {cx.phase === 'play' && cx.mode === 'local' && (
          <button
            className="btn btn-ghost chess-undo-btn"
            onClick={cx.undo}
            disabled={!cx.canUndo}
            data-testid="chess-undo"
          >
            ↶ Undo
          </button>
        )}
        {cx.phase === 'play' && (
          <button
            className="icon-btn chess-menu-btn"
            onClick={() => setMenuOpen(true)}
            aria-label="Options"
            aria-haspopup="dialog"
            data-testid="chess-menu"
          >
            ☰
          </button>
        )}
        <FullscreenButton />
      </div>
      )}

      {/* ── Invite modal (online host waiting) ── */}
      {shareOpen && (
        /* Backdrop click is a mouse convenience; Escape (above) and the
           Close button are the keyboard path. */
        /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShareOpen(false); }}>
          <div className="modal modal-lg" role="dialog" aria-label="Invite your opponent">
            <div className="modal-head">
              <span className="modal-title">Waiting for opponent to join</span>
              <button className="icon-btn" onClick={() => setShareOpen(false)} aria-label="Close">
                <CloseIcon size={18} />
              </button>
            </div>
            <div className="codebox">
              <div className="qr-radar">
                <span className="ping" />
                <span className="ping" />
                <span className="ping" />
                <div className="qr-frame">
                  <QRCodeSVG value={shareUrl} size={132} bgColor="#e2e8f0" fgColor="#0b1220" level="M" />
                </div>
              </div>
              <div className="lbl">Share this code</div>
              <div className="code">{cx.code}</div>
              <p className="subtle" style={{ margin: '8px 0 14px' }}>
                Open Chess on the other device and tap “Join with a code”. The game starts the moment they join.
              </p>
              <button className="btn btn-primary" onClick={copyShare}>
                {copied ? 'Link copied' : 'Copy invite link'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cx.side && cx.status === 'error' && (
        <div className="panel narrow-col">
          <p className="subtle" style={{ color: 'var(--bad)' }}>{cx.statusDetail ?? 'Connection error.'}</p>
          <button className="btn btn-block" onClick={exitToMenu}>← Back to menu</button>
        </div>
      )}

      {/* ── The lobby: who is playing, then the count, then the ways ── */}
      {inLobby && (
        <div className="chess-who">
          {/* Who is playing is already known: the arcade's own line, with
              its own picker behind Switch player. */}
          <PlayingAs />
        </div>
      )}

      {/* ── Count screen: 1 player or 2 players ── */}
      {!inGame && setup === 'pick' && (
        <div className="chess-lobby-body">
          <CountCards
            onPick={(n) => {
              setCount(n);
              setSetup(n === 1 ? 'one' : 'two');
            }}
          />
          <div className="chess-rows">
            {resumableLocal && (
              <LobbyRow
                kind="resume"
                title={`Resume ${resumableLocal.whiteName} vs ${resumableLocal.blackName}`}
                sub={`Same device · ${describeMoves(resumableLocal.log.length)}${resumableLocal.start ? ' · custom setup' : ''}`}
                testId="chess-resume-local"
                onClick={() => cx.resumeLocal()}
              />
            )}
            {resumableChess && (
              <LobbyRow
                kind="resume"
                title={`Resume game ${resumableChess.code}`}
                sub={`vs ${resumableChess.oppName || 'opponent'}`}
                testId="chess-resume"
                onClick={() => {
                  openOnline(null, false);
                  cx.resumeGame(resumableChess.code);
                }}
              />
            )}
            <LobbyRow kind="join" title="Join with a code" testId="chess-join-row" onClick={() => openOnline(null, true)} />
          </div>
        </div>
      )}

      {/* ── 1 player: Play together, Free play (a third card fits here) ── */}
      {!inGame && setup === 'one' && (
        <div className="chess-lobby-body">
          <div className="chess-ways" data-cards="2">
            <WayCard {...WAYS.online} icon={<PartyIcon size={WAY_ICON} />} onClick={() => openOnline(1, false)} />
            <WayCard {...WAYS.free} icon={<GridIcon size={WAY_ICON} />} onClick={() => setSetup('free')} />
          </div>
        </div>
      )}

      {/* ── 2 players: Same device (with its second chair), Play together ── */}
      {!inGame && setup === 'two' && (
        <div className="chess-lobby-body">
          <div className="chess-ways" data-cards="2">
            <div className="chess-way-col">
              <WayCard {...WAYS.local} icon={<TargetIcon size={WAY_ICON} />} onClick={playSameDevice} />
              <PlayerTwoRow
                name={playerTwoName}
                rosterIndex={playerTwoIndex}
                side={meBlack ? 'w' : 'b'}
                buttonRef={playerTwoRef}
                onOpen={() => setPickTwo('choose')}
                onSwap={() => setSwapped(!meBlack)}
              />
            </div>
            <div className="chess-way-col">
              <WayCard {...WAYS.online} icon={<PartyIcon size={WAY_ICON} />} onClick={() => openOnline(2, false)} />
            </div>
          </div>
        </div>
      )}

      {pickTwo && (
        <SeatPlayerPicker
          title="Player 2"
          hideIds={meId ? [meId] : undefined}
          testIdPrefix="chess-p2"
          onPick={onPickTwo}
          onClose={closePickTwo}
        />
      )}

      {/* ── Free play sandbox — can promote its setup into a real game ── */}
      {!inGame && setup === 'free' && (
        <FreePlay
          onExit={() => setSetup('one')}
          // A promoted free-play board is a game starting like any other.
          onStartGame={(board) => startHotseat(customStart(board))}
        />
      )}

      {/* ── Setup: online lobby — the party is the table ── */}
      {!inGame && setup === 'online' && (
        <div className="narrow-col stack">
          {/* Your ticket is your name online (the Playing-as line above);
              your opponent sees it. */}
          <div className="panel stack">
            {lobby === 'reconnecting' && (
              <p className="subtle center" data-testid="chess-party-reconnecting">
                Reconnecting to your party…
              </p>
            )}

            {lobby === 'party-host' && (
              <>
                {/* The friend's name arrives with their hello — a beat after the link. */}
                <h2>Play with {party.theirName ?? 'your friend'}</h2>
                <div className="row-actions chess-sides" role="group" aria-label="Your colour">
                  <button
                    className={`btn${hostSide === 'w' ? ' btn-primary' : ''}`}
                    aria-pressed={hostSide === 'w'}
                    onClick={() => setHostSide('w')}
                    data-testid="chess-side-w"
                  >
                    I play White
                  </button>
                  <button
                    className={`btn${hostSide === 'b' ? ' btn-primary' : ''}`}
                    aria-pressed={hostSide === 'b'}
                    onClick={() => setHostSide('b')}
                    data-testid="chess-side-b"
                  >
                    I play Black
                  </button>
                  <button
                    className={`btn${hostSide === 'flip' ? ' btn-primary' : ''}`}
                    aria-pressed={hostSide === 'flip'}
                    onClick={() => setHostSide('flip')}
                    data-testid="chess-side-flip"
                  >
                    Flip for it
                  </button>
                </div>
                <button
                  className="btn btn-primary btn-lg btn-block"
                  onClick={() => {
                    const side: Color = hostSide === 'flip' ? (Math.random() < 0.5 ? 'w' : 'b') : hostSide;
                    sitDown({ role: 'host', code: party.openTable(GAME_ID, side), hostSide: side });
                  }}
                  data-testid="chess-party-play"
                >
                  Play Chess with {party.theirName ?? 'your friend'}
                </button>
              </>
            )}

            {lobby === 'party-guest' && (
              <p className="subtle center" data-testid="chess-party-waiting">
                {door.waiting
                  ? `Waiting for ${door.friend ?? 'your friend'} to open Chess…`
                  : `${door.friend ?? 'Your friend'} opened Chess — sitting down…`}
              </p>
            )}

            {lobby === 'doors' && (
              <>
                {joinOnly ? (
                  <h2>Join with a code</h2>
                ) : (
                  <>
                    <h2>Start a game</h2>
                    <button
                      className="btn btn-primary btn-lg btn-block"
                      onClick={() => sitDown({ role: 'host', code: generateCode() })}
                      data-testid="chess-create"
                    >
                      Create a game
                    </button>
                    <p className="subtle center">You’ll get a code to share. You play White.</p>
                  </>
                )}
                <div className="field">
                  <label htmlFor="jcode">{joinOnly ? '4-character code' : '…or join with a 4-character code'}</label>
                  <input
                    id="jcode"
                    className="code-input"
                    value={joinInput}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={4}
                    placeholder="ABCD"
                    onChange={(e) => setJoinInput(normalizeCode(e.target.value))}
                    data-testid="chess-join-code"
                  />
                </div>
                <button
                  className="btn btn-violet btn-lg btn-block"
                  disabled={joinInput.length !== 4}
                  onClick={() => sitDown({ role: 'guest', code: joinInput })}
                  data-testid="chess-join"
                >
                  Join game →
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-block" onClick={toCount}>← Back</button>
          </div>
        </div>
      )}

      {/* ── The board ── owns the whole screen now; everything that used to sit
          beside it lives in the title bar or behind the ☰ menu. */}
      {cx.phase === 'play' && (
        <div className="chess-play">
          <div className="chess-board-area">
            {view === '3d' ? (
              <Suspense fallback={<p className="subtle center">Setting up the 3D set…</p>}>
                <Chess3D
                  board={cx.board}
                  orientation={boardOrientation}
                  interactive={cx.canMove}
                  movableColor={cx.mode === 'online' && cx.myColor ? cx.myColor : cx.turn}
                  lastMove={lastMove}
                  onMove={onMove}
                  onViewDirty={setCamDirty}
                  onApi={(api) => { resetViewRef.current = api ? api.resetView : null; }}
                />
              </Suspense>
            ) : (
              <ChessBoard
                board={cx.board}
                orientation={boardOrientation}
                interactive={cx.canMove}
                movableColor={cx.mode === 'online' && cx.myColor ? cx.myColor : cx.turn}
                lastMove={lastMove}
                onMove={onMove}
              />
            )}
          </div>
        </div>
      )}

      {/* ── The ☰ options menu — players & captures, then every option spelled
          out as its own labelled row (kid-sized targets, no cryptic segments). */}
      {menuOpen && (
        /* Backdrop click is a mouse convenience; Escape (above) and the Close
           button are the keyboard path. */
        /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setMenuOpen(false); }}>
          <div className="modal chess-menu" role="dialog" aria-label="Chess options" aria-modal="true">
            <div className="modal-head">
              <span className="modal-title">Options</span>
              <button className="icon-btn" onClick={() => setMenuOpen(false)} aria-label="Close options" data-testid="chess-menu-close">
                <CloseIcon size={18} />
              </button>
            </div>
            <div className="chess-menu-body">
              <div className="chess-players">
                {/* Black then White, mirroring the board; each card names the
                    player and shows the pieces they've captured. */}
                <PlayerCard
                  name={nameB}
                  color="b"
                  active={cx.turn === 'b'}
                  inCheck={statusOf(cx.board) === 'check' && cx.turn === 'b'}
                  captured={caps.byBlack}
                  capColor="w"
                  lead={-caps.whiteLead}
                />
                <PlayerCard
                  name={nameW}
                  color="w"
                  active={cx.turn === 'w'}
                  inCheck={statusOf(cx.board) === 'check' && cx.turn === 'w'}
                  captured={caps.byWhite}
                  capColor="b"
                  lead={caps.whiteLead}
                />
              </div>

              <div className="menu-group" role="group" aria-label="Board view">
                <div className="menu-group-title">Board view</div>
                <button
                  className="menu-opt"
                  data-selected={view === 'flat'}
                  aria-pressed={view === 'flat'}
                  onClick={() => { pickView('flat'); setMenuOpen(false); }}
                  data-testid="view-flat"
                >
                  <strong>Flat</strong>
                  <span>The classic top-down board</span>
                </button>
                <button
                  className="menu-opt"
                  data-selected={view === '3d'}
                  aria-pressed={view === '3d'}
                  onClick={() => { pickView('3d'); setMenuOpen(false); }}
                  data-testid="view-3d"
                >
                  <strong>3D</strong>
                  <span>Orbit the set, zoom right in, and drag the pieces themselves</span>
                </button>
              </div>

              <div className="menu-group" role="group" aria-label="World">
                <div className="menu-group-title">World</div>
                {CHESS_THEMES.map((t) => (
                  <button
                    key={t.id}
                    className="menu-opt"
                    data-selected={theme === t.id}
                    aria-pressed={theme === t.id}
                    onClick={() => { setTheme(t.id); setMenuOpen(false); }}
                    data-testid={`theme-${t.id}`}
                  >
                    <strong>{t.label}</strong>
                    <span>{THEME_BLURBS[t.id]}</span>
                  </button>
                ))}
              </div>

              <button
                className="btn btn-block"
                onClick={() => { setMenuOpen(false); setLogOpen(true); }}
                data-testid="chess-log-open"
              >
                <ListIcon size={18} /> Move log
              </button>
            </div>
          </div>
        </div>
      )}

      {logOpen && (
        <ChessLogModal
          moves={moves}
          start={cx.start ?? undefined}
          orientation={boardOrientation}
          canReturn={cx.mode === 'local'}
          onReturn={(n) => { cx.goToPly(n); setLogOpen(false); }}
          onClose={() => setLogOpen(false)}
        />
      )}

      {/* ── Result ── */}
      {cx.phase === 'over' && finish && (
        <div className="narrow-col">
          <ChessResult
            status={finish.status}
            winner={winnerOf(cx.board)}
            mode={cx.mode ?? 'local'}
            iWon={cx.mode === 'online' ? winnerOf(cx.board) === cx.myColor : null}
            myName={cx.myName}
            oppName={cx.oppName}
            whiteName={nameW}
            blackName={nameB}
            pointsEarned={finish.pointsEarned}
            // "You now have…" is only true of the ticket the result credited;
            // if somebody else signed in since, their total is not the news.
            totalPoints={cx.seatedUserId === profile.userId ? profile.profile.points : undefined}
            iWantRematch={cx.iWantRematch}
            oppWantsRematch={cx.oppWantsRematch}
            onRematch={cx.requestRematch}
            onExit={exitToMenu}
          />
        </div>
      )}

      <div className="footer">
        <Link to="/">Family game console</Link>
      </div>
    </div>
    </ChessThemeContext.Provider>
  );
}

/** A player's plaque beside the board: name (with a "to move" cue on the active
 *  side) and the pieces they've captured. */
function PlayerCard({
  name,
  color,
  active,
  inCheck,
  captured,
  capColor,
  lead,
}: {
  name: string;
  color: Color;
  active: boolean;
  inCheck: boolean;
  captured: PieceType[];
  capColor: Color;
  lead: number;
}) {
  return (
    <div className={`chess-player ${active ? 'active' : ''}`}>
      <span className={`pl-dot ${color === 'w' ? 'light' : 'dark'}`} aria-hidden="true" />
      <div className="pl-main">
        <div className="pl-name" data-testid={active ? 'chess-turn' : undefined}>
          <strong>{name}</strong>
          {active && <span className="pl-turn"> to move</span>}
          {inCheck && <span className="pl-check">Check!</span>}
        </div>
        <CapturedTray pieces={captured} color={capColor} lead={lead} />
      </div>
    </div>
  );
}

/** The from/to of the most recent ply, for highlighting on the board. */
function lastMoveSquares(log: Ply[]) {
  const last = log[log.length - 1];
  return last ? { from: last.from, to: last.to } : null;
}

/** "3 moves in" / "fresh setup" — the resume card's progress line. */
function describeMoves(plies: number): string {
  if (plies === 0) return 'fresh setup';
  const moves = Math.ceil(plies / 2);
  return `${moves} move${moves === 1 ? '' : 's'} in`;
}
