import {
    MatchState,
    PlayerState,
    PowerUpType,
    OpCode,
    PowerUpTypeValue,
} from "./types";

export function applyPowerUpEffects(
    state: MatchState,
    loserIds: string[],
    baseDamage: number
): Record<string, number> {
    const damageMap: Record<string, number> = {};

    for (const loserId of loserIds) {
        let damage = baseDamage;
        const loser = state.players[loserId];

        for (const playerId in state.players) {
            const player = state.players[playerId];
            if (player.activePowerUp === PowerUpType.TRIPLE_DAMAGE && loser.isAlive) {
                damage = baseDamage * 3;
                break;
            }
        }

        damageMap[loserId] = damage;
    }

    return damageMap;
}

export function resetRoundPowerUps(state: MatchState): void {
    for (const playerId in state.players) {
        state.players[playerId].activePowerUp = PowerUpType.NONE;
    }
}

export function buildPowerUpActivateMessage(
    playerId: string,
    powerUpType: PowerUpTypeValue
): string {
    return JSON.stringify({ playerId, powerUpType });
}

export function assignRandomPowerUp(): PowerUpTypeValue {
    const types = Object.values(PowerUpType).filter(
        (t) => t !== PowerUpType.NONE
    );
    const roll = Math.random();
    if (roll < 0.3 && types.length > 0) {
        return types[Math.floor(Math.random() * types.length)] as PowerUpTypeValue;
    }
    return PowerUpType.NONE;
}
