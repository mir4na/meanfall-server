export const OpCode = {
    ROUND_START: 1,
    GUESS_SUBMIT: 2,
    ROUND_RESULT: 3,
    GAME_OVER: 4,
    CHAT_MESSAGE: 5,
    PLAYER_JOINED: 6,
    PLAYER_LEFT: 7,
    POWERUP_ACTIVATE: 8,
    RECONNECT_STATE: 9,
} as const;

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode];

export const PowerUpType = {
    TRIPLE_DAMAGE: "triple_damage",
    NONE: "none",
} as const;

export type PowerUpTypeValue = (typeof PowerUpType)[keyof typeof PowerUpType];

export const MatchPhase = {
    WAITING: "waiting",
    COUNTDOWN: "countdown",
    GUESSING: "guessing",
    REVEALING: "revealing",
    NEXT_ROUND: "next_round",
    GAME_OVER: "game_over",
} as const;

export type MatchPhaseValue = (typeof MatchPhase)[keyof typeof MatchPhase];

export interface PlayerState {
    userId: string;
    username: string;
    lives: number;
    presence: nkruntime.Presence | null;
    guessValue: number;
    guessTime: number;
    isAfk: boolean;
    activePowerUp: PowerUpTypeValue;
    isAlive: boolean;
}

export interface MatchState {
    phase: MatchPhaseValue;
    players: Record<string, PlayerState>;
    roundNumber: number;
    roundTick: number;
    maxLives: number;
    maxPlayers: number;
    isRanked: boolean;
    roomCode: string;
    tickRate: number;
}

export interface GuessSubmitPayload {
    value: number;
}

export interface ChatPayload {
    message: string;
}

export interface PowerUpActivatePayload {
    powerUpType: PowerUpTypeValue;
}
