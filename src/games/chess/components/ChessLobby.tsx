/**
 * The Chess lobby, count first: one screen asks 1 player or 2 players, the
 * next offers only the ways to play that fit. Presentational pieces only;
 * ChessPage owns the steps, the chairs and what each way starts. Every look
 * comes from the theme scope (`.chess-theme-<id>` in chess.css), so the same
 * markup is the War Room, the Cloud Kingdom or the Galaxy Fleet.
 */

import type { ReactNode } from 'react';
import { Medal } from '@shared/profile/Medal';
import { ConnectionBadge } from '@shared/ui/ConnectionBadge';
import { FullscreenButton } from '@shared/ui/FullscreenButton';
import { ChevronLeftIcon, PeopleIcon, PersonIcon, ResumeIcon, StarIcon } from '@shared/ui/icons';

export type PlayerCount = 1 | 2;

/** The 1P / 2P coin: on the count cards, and beside the back button after. */
function Coin({ count, small = false }: { count: PlayerCount; small?: boolean }) {
  return (
    <span className={small ? 'chess-coin sm' : 'chess-coin'} aria-hidden="true">
      {count}P
    </span>
  );
}

/** The lobby's title bar: back, the chosen count, the centred sign, full screen. */
export function LobbyTop({
  count,
  backLabel,
  onBack,
  badge,
}: {
  count: PlayerCount | null;
  backLabel: string;
  onBack: () => void;
  badge?: Parameters<typeof ConnectionBadge>[0];
}) {
  return (
    <div className="chess-lobby-top">
      <div className="chess-lobby-nav">
        <button
          type="button"
          className="chess-corner"
          onClick={onBack}
          aria-label={backLabel}
          data-testid="chess-lobby-back"
        >
          <ChevronLeftIcon size={26} />
        </button>
        {count && (
          <span className="chess-lobby-count" data-testid="chess-lobby-count">
            <Coin count={count} small />
            <span className="sr-only">{count === 1 ? '1 player' : '2 players'}</span>
          </span>
        )}
      </div>
      <h1 className="chess-sign">
        <span className="chess-sign-rule" aria-hidden="true" />
        <StarIcon size={22} />
        <span translate="no">Chess</span>
        <StarIcon size={22} />
        <span className="chess-sign-rule" aria-hidden="true" />
      </h1>
      <div className="chess-lobby-end">
        {badge && <ConnectionBadge {...badge} />}
        <FullscreenButton />
      </div>
    </div>
  );
}

/** The count screen's two tall cards. */
export function CountCards({ onPick }: { onPick: (count: PlayerCount) => void }) {
  return (
    <div className="chess-counts">
      {([1, 2] as const).map((n) => (
        <button
          key={n}
          type="button"
          className="chess-count"
          onClick={() => onPick(n)}
          data-testid={`chess-count-${n}`}
        >
          <Coin count={n} />
          <span className="chess-count-pic">
            {n === 1 ? <PersonIcon size={150} /> : <PeopleIcon size={150} />}
          </span>
          <span className="chess-count-label">{n === 1 ? '1 player' : '2 players'}</span>
        </button>
      ))}
    </div>
  );
}

/** One way to play, as a tall card. */
export function WayCard({
  icon,
  label,
  line,
  testId,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  line: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="chess-way" onClick={onClick} data-testid={testId}>
      <span className="chess-way-pic">{icon}</span>
      <span className="chess-way-label">{label}</span>
      <span className="chess-way-line">{line}</span>
    </button>
  );
}

/**
 * The second chair under Same device: "Player 2" with the medal once chosen.
 * It opens the arcade's player picker; it never lists people itself.
 */
export function PlayerTwoRow({
  name,
  rosterIndex,
  buttonRef,
  onOpen,
}: {
  name: string | null;
  rosterIndex: number;
  buttonRef: React.Ref<HTMLButtonElement>;
  onOpen: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="chess-p2"
      onClick={onOpen}
      data-testid="chess-player2"
    >
      <span className="chess-p2-label">Player 2</span>
      <span className={name ? 'chess-p2-who' : 'chess-p2-who empty'}>
        {name ? (
          <Medal name={name} index={rosterIndex} small />
        ) : (
          <span className="chess-p2-blank" aria-hidden="true">
            <PersonIcon size={18} />
          </span>
        )}
        <span className="chess-p2-name">{name ?? 'Choose'}</span>
      </span>
      <span className="chess-p2-chev" aria-hidden="true">›</span>
    </button>
  );
}

/** A quiet row under the count cards: a saved game, or Join with a code. */
export function LobbyRow({
  kind,
  title,
  sub,
  testId,
  onClick,
}: {
  kind: 'resume' | 'join';
  title: string;
  sub?: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`chess-row chess-row-${kind}`} onClick={onClick} data-testid={testId}>
      {kind === 'join' ? (
        <span className="chess-tiles" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : (
        <ResumeIcon size={20} />
      )}
      <span className="chess-row-title">{title}</span>
      {sub && <span className="chess-row-sub">{sub}</span>}
      <span className="chess-row-chev" aria-hidden="true">›</span>
    </button>
  );
}
