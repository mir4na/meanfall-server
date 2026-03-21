import {
    MatchState,
    PlayerState,
    OpCode,
    MatchPhase,
    GuessSubmitPayload,
    ChatPayload,
    RoundEventType,
    RoundEventTypeValue,
} from "./types";
import {
    updateMatchResults,
} from "./rank_handler";

const TICK_RATE = 5;
const GUESS_TICKS = 30 * TICK_RATE;
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const REVEAL_TICKS = 5 * TICK_RATE;
const NEXT_ROUND_TICKS = 2 * TICK_RATE;
const CHAOS_ROLL_TICKS = 5 * TICK_RATE;
const ROUNDS_BEFORE_DOUBLE_DAMAGE = 5;
const MIN_PLAYERS_TO_START = 3;

function calculateAverage(players: Record<string, PlayerState>): number {
    const alive = Object.values(players).filter((p) => p.isAlive && p.guessValue !== -1);
    if (alive.length === 0) return 0;

    let sum = 0;
    let count = 0;
    for (const p of alive) {
        if (Array.isArray(p.guessValue)) {
            for (const v of p.guessValue) {
                sum += v;
                count++;
            }
        } else {
            sum += p.guessValue;
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}

function getBestGuess(guess: number | number[], target: number): number {
    if (Array.isArray(guess)) {
        if (guess.length === 0) return -1;
        if (guess.length === 1) return guess[0];
        const diff0 = Math.abs(guess[0] - target);
        const diff1 = Math.abs(guess[1] - target);
        return diff0 < diff1 ? guess[0] : guess[1];
    }
    return guess as number;
}

function findWinners(
    players: Record<string, PlayerState>,
    target: number,
    isReverse: boolean
): string[] {
    const alive = Object.values(players).filter((p) => p.isAlive && p.guessValue !== -1);
    if (alive.length === 0) return [];

    let bestLimit = isReverse ? -Infinity : Infinity;

    for (const p of alive) {
        const bestG = getBestGuess(p.guessValue, target);
        const diff = Math.abs(bestG - target);
        if (isReverse) {
            if (diff > bestLimit) bestLimit = diff;
        } else {
            if (diff < bestLimit) bestLimit = diff;
        }
    }

    const tied = alive.filter((p) => {
        const bestG = getBestGuess(p.guessValue, target);
        return Math.abs(bestG - target) === bestLimit;
    });

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
        activeEvent: state.activeEvent,
        players: Object.values(state.players).map((p) => ({
            userId: p.userId,
            username: p.username,
            lives: p.lives,
            isAlive: p.isAlive,
            guessValue: p.guessValue,
        })),
        maxLives: state.maxLives,
        isRanked: state.isRanked,
    };
}

function assignRandomEvent(): RoundEventTypeValue {
    const types = Object.values(RoundEventType).filter(
        (t) => t !== RoundEventType.NONE
    );
    return types[Math.floor(Math.random() * types.length)] as RoundEventTypeValue;
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

    const isReverse = state.activeEvent === RoundEventType.REVERSE_OUTCOME;
    const winnerIds = findWinners(state.players, target, isReverse);
    const loserIds = alivePlayers
        .map((p) => p.userId)
        .filter((id) => !winnerIds.includes(id));

    let baseDamage = state.activeEvent === RoundEventType.DOUBLE_DAMAGE ? 2 : 1;
    if (state.roundNumber > ROUNDS_BEFORE_DOUBLE_DAMAGE) {
        baseDamage = 2;
    }

    const playerResults: Record<string, object> = {};

    for (const playerId in state.players) {
        const player = state.players[playerId];
        let livesLost = 0;

        if (player.isAlive) {
            if (winnerIds.includes(playerId)) {
                if (state.activeEvent === RoundEventType.LIFE_STEAL) {
                    player.lives = Math.min(state.maxLives, player.lives + 1);
                }
            } else if (loserIds.includes(playerId)) {
                livesLost = baseDamage;
                player.lives = Math.max(0, player.lives - livesLost);
                if (player.lives <= 0) {
                    player.isAlive = false;
                    player.rank = state.playersRemaining;
                    state.playersRemaining--;
                }
            }
        }

        const gVal = Array.isArray(player.guessValue) ? player.guessValue : [player.guessValue];

        playerResults[playerId] = {
            userId: player.userId,
            username: player.username,
            guessValue: gVal,
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
    logger.info("Round %d result: target=%f winners=%j", state.roundNumber, target, winnerIds);
}

function checkGameOver(
    state: MatchState,
    dispatcher: nkruntime.MatchDispatcher,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger
): boolean {
    const alive = Object.values(state.players).filter((p) => p.isAlive);
    if (alive.length <= 1) {
        const winner = alive.length === 1 ? alive[0] : null;
        if (winner) {
            winner.rank = 1;
        }

        if (state.isRanked) {
            const durationSeconds = Math.floor((Date.now() - state.matchStartTime) / 1000);
            const rankedResults = Object.values(state.players).map((p) => ({
                userId: p.userId,
                username: p.username,
                rank: p.rank || 1,
            }));
            updateMatchResults(nk, logger, rankedResults, durationSeconds);
        }

        broadcastMessage(dispatcher, state.players, OpCode.GAME_OVER, {
            winnerId: winner?.userId ?? null,
            winnerUsername: winner?.username ?? null,
        });

        const deletes = Object.values(state.players).map((p) => ({
            collection: "active_match",
            key: "current",
            userId: p.userId,
        }));
        if (deletes.length > 0) {
            nk.storageDelete(deletes);
        }

        return true;
    }
    return false;
}

function startNewRound(
    state: MatchState,
    dispatcher: nkruntime.MatchDispatcher
): void {
    if (state.roundNumber === 0) {
        state.matchStartTime = Date.now();
        state.playersRemaining = Object.values(state.players).filter((p) => p.isAlive).length;
    }
    state.roundNumber += 1;
    state.roundTick = 0;
    state.phase = MatchPhase.COUNTDOWN;
    state.activeEvent = assignRandomEvent();

    for (const playerId in state.players) {
        const player = state.players[playerId];
        player.guessValue = -1;
        player.guessTime = 0;
        player.isAfk = false;
    }

    broadcastMessage(dispatcher, state.players, OpCode.ROUND_START, {
        roundNumber: state.roundNumber,
        activeEvent: state.activeEvent,
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
        playersRemaining: 0,
        matchStartTime: 0,
        isRanked,
        roomCode,
        tickRate: TICK_RATE,
        activeEvent: RoundEventType.NONE,
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

        nk.storageWrite([{
            collection: "active_match",
            key: "current",
            userId: presence.userId,
            value: { matchId: ctx.matchId, timestamp: Date.now() },
            permissionRead: 1,
            permissionWrite: 0,
        }]);

        if (isReconnect) {
            state.players[presence.userId].presence = presence;
            state.players[presence.userId].isAfk = false;

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
                presence: presence,
                guessValue: -1,
                guessTime: 0,
                isAfk: false,
                isAlive: true,
            };

            const reconnectPayload = buildReconnectState(state);
            dispatcher.broadcastMessage(
                OpCode.RECONNECT_STATE,
                JSON.stringify(reconnectPayload),
                [presence],
                null,
                true
            );

            broadcastMessage(dispatcher, state.players, OpCode.PLAYER_JOINED, {
                userId: presence.userId,
                username: presence.username,
                lives: state.maxLives,
            });
        }
    }
    return { state };
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
): { state: MatchState; label?: string } | null {
    for (const message of messages) {
        const opCode = message.opCode as number;

        if (opCode === OpCode.GUESS_SUBMIT && state.phase === MatchPhase.GUESSING && state.activeEvent !== RoundEventType.CHAOS_ROLL) {
            const payload = JSON.parse(nk.binaryToString(message.data)) as GuessSubmitPayload;
            const player = state.players[message.sender.userId];
            if (player && player.isAlive && player.guessValue === -1) {
                let formattedValue: number | number[];
                if (Array.isArray(payload.value)) {
                    formattedValue = payload.value.map(v => Math.max(0, Math.min(100, Math.floor(v))));
                } else {
                    formattedValue = Math.max(0, Math.min(100, Math.floor(payload.value)));
                }
                player.guessValue = formattedValue;
                player.guessTime = tick;
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
    }

    state.roundTick += 1;

    if (state.phase === MatchPhase.WAITING) {
        const readyCount = Object.values(state.players).filter((p) => p.isAlive).length;
        if (readyCount >= MIN_PLAYERS_TO_START) {
            if (state.roundTick >= 5) {
                startNewRound(state, dispatcher);
            }
        } else {
            state.roundTick = 0;
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
        const isChaosReady = state.activeEvent === RoundEventType.CHAOS_ROLL && state.roundTick >= CHAOS_ROLL_TICKS;

        if (isTimeUp || isChaosReady) {
            for (const player of alivePlayers) {
                if (player.guessValue === -1) {
                    const isDouble = state.activeEvent === RoundEventType.DOUBLE_GUESS;
                    player.guessValue = isDouble ? [Math.floor(Math.random() * 101), Math.floor(Math.random() * 101)] : Math.floor(Math.random() * 101);
                    player.guessTime = tick;
                    player.isAfk = state.activeEvent !== RoundEventType.CHAOS_ROLL;
                }
            }
            state.phase = MatchPhase.REVEALING;
            state.roundTick = 0;
            processRoundResult(state, dispatcher, logger);
        }

        return { state: state };
    }

    if (state.phase === MatchPhase.REVEALING) {
        if (state.roundTick >= REVEAL_TICKS) {
            if (checkGameOver(state, dispatcher, nk, logger)) {
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
