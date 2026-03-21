export const OpCode = {
    ROUND_START: 1,
    GUESS_SUBMIT: 2,
    ROUND_RESULT: 3,
    GAME_OVER: 4,
    CHAT_MESSAGE: 5,
    PLAYER_JOINED: 6,
    PLAYER_LEFT: 7,
    RECONNECT_STATE: 9,
} as const;

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode];

export const RoundEventType = {
    DOUBLE_DAMAGE: "double_damage",
    LIFE_STEAL: "life_steal",
    CHAOS_ROLL: "chaos_roll",
    REVERSE_OUTCOME: "reverse_outcome",
    DOUBLE_GUESS: "double_guess",
    NONE: "none",
} as const;

export type RoundEventTypeValue = (typeof RoundEventType)[keyof typeof RoundEventType];

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
    guessValue: number | number[];
    guessTime: number;
    isAfk: boolean;
    isAlive: boolean;
    rank?: number;
}

export interface MatchState {
    phase: MatchPhaseValue;
    players: Record<string, PlayerState>;
    roundNumber: number;
    roundTick: number;
    maxLives: number;
    maxPlayers: number;
    playersRemaining: number;
    matchStartTime: number;
    isRanked: boolean;
    roomCode: string;
    tickRate: number;
    activeEvent: RoundEventTypeValue;
}

export interface GuessSubmitPayload {
    value: number | number[];
}

export interface ChatPayload {
    message: string;
}
