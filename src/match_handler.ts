import {
    MatchState,
    PlayerState,
    OpCode,
    MatchPhase,
    GuessSubmitPayload,
    ChatPayload,
    PowerUpActivatePayload,
    PowerUpType,
} from "./types";
import {
    applyPowerUpEffects,
    resetRoundPowerUps,
    assignRandomPowerUp,
} from "./powerup_handler";

const TICK_RATE = 5;
const GUESS_TICKS = 30 * TICK_RATE;
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const REVEAL_TICKS = 5 * TICK_RATE;
const NEXT_ROUND_TICKS = 2 * TICK_RATE;
const ROUNDS_BEFORE_DOUBLE_DAMAGE = 5;
const MIN_PLAYERS_TO_START = 2;

function calculateAverage(players: Record<string, PlayerState>): number {
    const alive = Object.values(players).filter((p) => p.isAlive);
    if (alive.length === 0) return 0;
    const sum = alive.reduce((acc, p) => acc + p.guessValue, 0);
    return sum / alive.length;
}

function findWinners(
    players: Record<string, PlayerState>,
    target: number
): string[] {
    const alive = Object.values(players).filter((p) => p.isAlive);
    if (alive.length === 0) return [];

    let minDiff = Infinity;
    for (const p of alive) {
        const diff = Math.abs(p.guessValue - target);
        if (diff < minDiff) minDiff = diff;
    }

    const tied = alive.filter((p) => Math.abs(p.guessValue - target) === minDiff);
    if (tied.length === 1) return [tied[0].userId];

    tied.sort((a, b) => a.guessTime - b.guessTime);
    return [tied[0].userId];
}

function broadcastMessage(
    dispatcher: nkruntime.MatchDispatcher,
    players: Record<string, PlayerState>,
    opCode: number,
    payload: object
): void {
    const presences = Object.values(players)
        .filter((p) => p.presence !== null)
        .map((p) => p.presence as nkruntime.Presence);

    if (presences.length === 0) return;
    dispatcher.broadcastMessage(opCode, JSON.stringify(payload), presences, null, true);
}

function buildReconnectState(state: MatchState): object {
    return {
        phase: state.phase,
        roundNumber: state.roundNumber,
        players: Object.values(state.players).map((p) => ({
            userId: p.userId,
            username: p.username,
            lives: p.lives,
            isAlive: p.isAlive,
        })),
        maxLives: state.maxLives,
        isRanked: state.isRanked,
    };
}

function processRoundResult(
    state: MatchState,
    dispatcher: nkruntime.MatchDispatcher,
    logger: nkruntime.Logger
): void {
    const alivePlayers = Object.values(state.players).filter((p) => p.isAlive);
    if (alivePlayers.length === 0) return;

    let target: number;
    if (alivePlayers.length === 2) {
        target = Math.floor(Math.random() * 101);
    } else {
        target = calculateAverage(state.players);
    }

    const winnerIds = findWinners(state.players, target);
    const loserIds = alivePlayers
        .map((p) => p.userId)
        .filter((id) => !winnerIds.includes(id));

    const baseDamage = state.roundNumber > ROUNDS_BEFORE_DOUBLE_DAMAGE ? 2 : 1;
    const damageMap = applyPowerUpEffects(state, loserIds, baseDamage);

    const playerResults: Record<string, object> = {};

    for (const playerId in state.players) {
        const player = state.players[playerId];
        let livesLost = 0;

        if (damageMap[playerId] !== undefined) {
            livesLost = damageMap[playerId];
            player.lives = Math.max(0, player.lives - livesLost);
            if (player.lives <= 0) {
                player.isAlive = false;
            }
        }

        playerResults[playerId] = {
            userId: player.userId,
            username: player.username,
            guessValue: player.guessValue,
            lives: player.lives,
            livesLost: livesLost,
            isWinner: winnerIds.includes(playerId),
            isAlive: player.isAlive,
        };
    }

    const payload = {
        target: target,
        is2PlayerMode: alivePlayers.length === 2,
        playerResults: playerResults,
        roundNumber: state.roundNumber,
    };

    broadcastMessage(dispatcher, state.players, OpCode.ROUND_RESULT, payload);
    resetRoundPowerUps(state);

    logger.info("Round %d result: target=%f winners=%j", state.roundNumber, target, winnerIds);
}

function checkGameOver(
    state: MatchState,
    dispatcher: nkruntime.MatchDispatcher
): boolean {
    const alive = Object.values(state.players).filter((p) => p.isAlive);
    if (alive.length <= 1) {
        const winner = alive.length === 1 ? alive[0] : null;
        broadcastMessage(dispatcher, state.players, OpCode.GAME_OVER, {
            winnerId: winner?.userId ?? null,
            winnerUsername: winner?.username ?? null,
        });
        return true;
    }
    return false;
}

function startNewRound(
    state: MatchState,
    dispatcher: nkruntime.MatchDispatcher
): void {
    state.roundNumber += 1;
    state.roundTick = 0;
    state.phase = MatchPhase.COUNTDOWN;

    for (const playerId in state.players) {
        const player = state.players[playerId];
        player.guessValue = -1;
        player.guessTime = 0;
        player.isAfk = false;
        if (player.isAlive) {
            player.activePowerUp = assignRandomPowerUp();
        }
    }

    const powerUpData: Record<string, string> = {};
    for (const playerId in state.players) {
        powerUpData[playerId] = state.players[playerId].activePowerUp;
    }

    broadcastMessage(dispatcher, state.players, OpCode.ROUND_START, {
        roundNumber: state.roundNumber,
        powerUps: powerUpData,
    });
}

export function matchInit(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    params: { [key: string]: string }
): { state: MatchState; tickRate: number; label: string } {
    const maxPlayers = parseInt(params["max_players"] ?? "10", 10);
    const maxLives = parseInt(params["max_lives"] ?? "10", 10);
    const isRanked = (params["is_ranked"] ?? "false") === "true";
    const roomCode = params["room_code"] ?? "";

    const state: MatchState = {
        phase: MatchPhase.WAITING,
        players: {},
        roundNumber: 0,
        roundTick: 0,
        maxLives,
        maxPlayers,
        isRanked,
        roomCode,
        tickRate: TICK_RATE,
    };

    logger.info("Match initialized: maxPlayers=%d maxLives=%d isRanked=%s", maxPlayers, maxLives, isRanked);
    return { state, tickRate: TICK_RATE, label: JSON.stringify({ roomCode, isRanked, maxPlayers }) };
}

export function matchJoinAttempt(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    presence: nkruntime.Presence,
    metadata: { [key: string]: any }
): { state: MatchState; accept: boolean; rejectMessage?: string } {
    const aliveCount = Object.values(state.players).filter((p) => p.isAlive).length;
    const isReconnect = state.players[presence.userId] !== undefined;

    if (!isReconnect && state.phase !== MatchPhase.WAITING) {
        return { state, accept: false, rejectMessage: "Match already in progress" };
    }

    if (!isReconnect && aliveCount >= state.maxPlayers) {
        return { state, accept: false, rejectMessage: "Match is full" };
    }

    return { state, accept: true };
}

export function matchJoin(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    presences: nkruntime.Presence[]
): { state: MatchState } | null {
    for (const presence of presences) {
        const isReconnect = state.players[presence.userId] !== undefined;

        if (isReconnect) {
            state.players[presence.userId].presence = presence;
            const reconnectPayload = buildReconnectState(state);
            dispatcher.broadcastMessage(
                OpCode.RECONNECT_STATE,
                JSON.stringify(reconnectPayload),
                [presence],
                null,
                true
            );
        } else {
            state.players[presence.userId] = {
                userId: presence.userId,
                username: presence.username,
                lives: state.maxLives,
                presence,
                guessValue: -1,
                guessTime: 0,
                isAfk: false,
                activePowerUp: PowerUpType.NONE,
                isAlive: true,
            };

            broadcastMessage(dispatcher, state.players, OpCode.PLAYER_JOINED, {
                userId: presence.userId,
                username: presence.username,
                lives: state.maxLives,
            });
        }

        logger.info("Player joined: %s (reconnect: %s)", presence.userId, isReconnect);
    }

    return { state: state };
}

export function matchLeave(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    presences: nkruntime.Presence[]
): { state: MatchState } | null {
    for (const presence of presences) {
        if (state.players[presence.userId]) {
            state.players[presence.userId].presence = null;
            broadcastMessage(dispatcher, state.players, OpCode.PLAYER_LEFT, {
                userId: presence.userId,
                username: presence.username,
            });
            logger.info("Player disconnected: %s (kept in state for reconnect)", presence.userId);
        }
    }
    return { state: state };
}

export function matchLoop(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    messages: nkruntime.MatchMessage[]
): { state: MatchState } | null {
    for (const message of messages) {
        const opCode = message.opCode as number;

        if (opCode === OpCode.GUESS_SUBMIT && state.phase === MatchPhase.GUESSING) {
            const payload = JSON.parse(nk.binaryToString(message.data)) as GuessSubmitPayload;
            const player = state.players[message.sender.userId];
            if (player && player.isAlive && player.guessValue === -1) {
                const value = Math.max(0, Math.min(100, Math.floor(payload.value)));
                player.guessValue = value;
                player.guessTime = tick;
                logger.info("Guess received from %s: %d", message.sender.userId, value);
            }
        }

        if (opCode === OpCode.CHAT_MESSAGE) {
            const payload = JSON.parse(nk.binaryToString(message.data)) as ChatPayload;
            const player = state.players[message.sender.userId];
            if (player && payload.message.length > 0 && payload.message.length <= 200) {
                broadcastMessage(dispatcher, state.players, OpCode.CHAT_MESSAGE, {
                    userId: message.sender.userId,
                    username: player.username,
                    message: payload.message.trim(),
                    timestamp: Date.now(),
                });
            }
        }

        if (opCode === OpCode.POWERUP_ACTIVATE && state.phase === MatchPhase.GUESSING) {
            const payload = JSON.parse(nk.binaryToString(message.data)) as PowerUpActivatePayload;
            const player = state.players[message.sender.userId];
            if (player && player.isAlive && player.activePowerUp === payload.powerUpType) {
                player.activePowerUp = payload.powerUpType;
                broadcastMessage(dispatcher, state.players, OpCode.POWERUP_ACTIVATE, {
                    userId: message.sender.userId,
                    powerUpType: payload.powerUpType,
                });
            }
        }
    }

    state.roundTick += 1;

    if (state.phase === MatchPhase.WAITING) {
        const readyCount = Object.values(state.players).filter((p) => p.isAlive).length;
        if (readyCount >= MIN_PLAYERS_TO_START) {
            startNewRound(state, dispatcher);
        }
        return { state: state };
    }

    if (state.phase === MatchPhase.COUNTDOWN) {
        if (state.roundTick >= COUNTDOWN_TICKS) {
            state.phase = MatchPhase.GUESSING;
            state.roundTick = 0;
        }
        return { state: state };
    }

    if (state.phase === MatchPhase.GUESSING) {
        const alivePlayers = Object.values(state.players).filter((p) => p.isAlive);
        const allGuessed = alivePlayers.every((p) => p.guessValue !== -1);

        const isTimeUp = state.roundTick >= GUESS_TICKS;
        if (isTimeUp) {
            for (const player of alivePlayers) {
                if (player.guessValue === -1) {
                    player.guessValue = Math.floor(Math.random() * 101);
                    player.guessTime = tick;
                    player.isAfk = true;
                }
            }
        }

        if (allGuessed || isTimeUp) {
            state.phase = MatchPhase.REVEALING;
            state.roundTick = 0;
            processRoundResult(state, dispatcher, logger);
        }

        return { state: state };
    }

    if (state.phase === MatchPhase.REVEALING) {
        if (state.roundTick >= REVEAL_TICKS) {
            if (checkGameOver(state, dispatcher)) {
                state.phase = MatchPhase.GAME_OVER;
                return { state: state };
            }
            state.phase = MatchPhase.NEXT_ROUND;
            state.roundTick = 0;
        }
        return { state: state };
    }

    if (state.phase === MatchPhase.NEXT_ROUND) {
        if (state.roundTick >= NEXT_ROUND_TICKS) {
            startNewRound(state, dispatcher);
        }
        return { state: state };
    }

    if (state.phase === MatchPhase.GAME_OVER) {
        return null;
    }

    return { state: state };
}

export function matchTerminate(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    graceSeconds: number
): { state: MatchState } | null {
    logger.info("Match terminated");
    broadcastMessage(dispatcher, state.players, OpCode.GAME_OVER, {
        winnerId: null,
        winnerUsername: null,
        terminated: true,
    });
    return { state: state };
}

export function matchSignal(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    tick: number,
    state: MatchState,
    data: string
): { state: MatchState; data?: string } | null {
    return { state: state };
}
