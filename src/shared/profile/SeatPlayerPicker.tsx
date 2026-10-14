/**
 * The player picker opened for one chair at a same-device table: the deck
 * PlayingAs opens, titled for the chair ("Player 2") and without the players
 * already seated. Picking a ticket, or making a profile for a new name, seats
 * that ticket; nobody is signed in or renamed. A game owns the chair and the
 * row that opens this; the people come from here, so there is one picker.
 */

import { PlayerPicker } from './PlayerPicker';
import { useIdentity } from './useIdentity';

/** The ticket picked for the chair, with its name: a profile made a moment ago
 * is not in the caller's roster until its next render. */
export interface PickedPlayer {
  userId: string;
  name: string;
}

export function SeatPlayerPicker({
  title,
  hideIds,
  testIdPrefix,
  onPick,
  onClose,
}: {
  title: string;
  /** Tickets already at the table. */
  hideIds?: readonly string[];
  testIdPrefix?: string;
  onPick: (player: PickedPlayer) => void;
  onClose: () => void;
}) {
  const { users, addPlayer } = useIdentity();
  return (
    <PlayerPicker
      users={users}
      title={title}
      hideIds={hideIds}
      testIdPrefix={testIdPrefix}
      onPick={(userId) => onPick({ userId, name: users.find((u) => u.id === userId)?.profile.name ?? '' })}
      onCreate={(name) => onPick({ userId: addPlayer(name), name })}
      onClose={onClose}
    />
  );
}
