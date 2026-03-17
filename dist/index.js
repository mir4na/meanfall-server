'use strict';

const OpCode = {
    ROUND_START: 1,
    GUESS_SUBMIT: 2,
    ROUND_RESULT: 3,
    GAME_OVER: 4,
    CHAT_MESSAGE: 5,
    PLAYER_JOINED: 6,
    PLAYER_LEFT: 7,
    POWERUP_ACTIVATE: 8,
    RECONNECT_STATE: 9,
};
const PowerUpType = {
    TRIPLE_DAMAGE: "triple_damage",
    NONE: "none",
};
const MatchPhase = {
    WAITING: "waiting",
    COUNTDOWN: "countdown",
    GUESSING: "guessing",
    REVEALING: "revealing",
    NEXT_ROUND: "next_round",
    GAME_OVER: "game_over",
};

function applyPowerUpEffects(state, loserIds, baseDamage) {
    const damageMap = {};
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
function resetRoundPowerUps(state) {
    for (const playerId in state.players) {
        state.players[playerId].activePowerUp = PowerUpType.NONE;
    }
}
function buildPowerUpActivateMessage(playerId, powerUpType) {
    return JSON.stringify({ playerId, powerUpType });
}
function assignRandomPowerUp() {
    const types = Object.values(PowerUpType).filter((t) => t !== PowerUpType.NONE);
    const roll = Math.random();
    if (roll < 0.3 && types.length > 0) {
        return types[Math.floor(Math.random() * types.length)];
    }
    return PowerUpType.NONE;
}

const TICK_RATE = 5;
const GUESS_TICKS = 30 * TICK_RATE;
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const REVEAL_TICKS = 5 * TICK_RATE;
const NEXT_ROUND_TICKS = 2 * TICK_RATE;
const ROUNDS_BEFORE_DOUBLE_DAMAGE = 5;
const MIN_PLAYERS_TO_START = 2;
function calculateAverage(players) {
    const alive = Object.values(players).filter((p) => p.isAlive);
    if (alive.length === 0)
        return 0;
    const sum = alive.reduce((acc, p) => acc + p.guessValue, 0);
    return sum / alive.length;
}
function findWinners(players, target) {
    const alive = Object.values(players).filter((p) => p.isAlive);
    if (alive.length === 0)
        return [];
    let minDiff = Infinity;
    for (const p of alive) {
        const diff = Math.abs(p.guessValue - target);
        if (diff < minDiff)
            minDiff = diff;
    }
    const tied = alive.filter((p) => Math.abs(p.guessValue - target) === minDiff);
    if (tied.length === 1)
        return [tied[0].userId];
    tied.sort((a, b) => a.guessTime - b.guessTime);
    return [tied[0].userId];
}
function broadcastMessage(dispatcher, players, opCode, payload) {
    const presences = Object.values(players)
        .filter((p) => p.presence !== null)
        .map((p) => p.presence);
    if (presences.length === 0)
        return;
    dispatcher.broadcastMessage(opCode, JSON.stringify(payload), presences, null, true);
}
function buildReconnectState(state) {
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
function processRoundResult(state, dispatcher, logger) {
    const alivePlayers = Object.values(state.players).filter((p) => p.isAlive);
    if (alivePlayers.length === 0)
        return;
    let target;
    if (alivePlayers.length === 2) {
        target = Math.floor(Math.random() * 101);
    }
    else {
        target = calculateAverage(state.players);
    }
    const winnerIds = findWinners(state.players, target);
    const loserIds = alivePlayers
        .map((p) => p.userId)
        .filter((id) => !winnerIds.includes(id));
    const baseDamage = state.roundNumber > ROUNDS_BEFORE_DOUBLE_DAMAGE ? 2 : 1;
    const damageMap = applyPowerUpEffects(state, loserIds, baseDamage);
    const playerResults = {};
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
            livesLost,
            isWinner: winnerIds.includes(playerId),
            isAlive: player.isAlive,
        };
    }
    const payload = {
        target,
        is2PlayerMode: alivePlayers.length === 2,
        playerResults,
        roundNumber: state.roundNumber,
    };
    broadcastMessage(dispatcher, state.players, OpCode.ROUND_RESULT, payload);
    resetRoundPowerUps(state);
    logger.info("Round %d result: target=%f winners=%j", state.roundNumber, target, winnerIds);
}
function checkGameOver(state, dispatcher) {
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
function startNewRound(state, dispatcher) {
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
    const powerUpData = {};
    for (const playerId in state.players) {
        powerUpData[playerId] = state.players[playerId].activePowerUp;
    }
    broadcastMessage(dispatcher, state.players, OpCode.ROUND_START, {
        roundNumber: state.roundNumber,
        powerUps: powerUpData,
    });
}
function matchInit(ctx, logger, nk, params) {
    const maxPlayers = parseInt(params["max_players"] ?? "10", 10);
    const maxLives = parseInt(params["max_lives"] ?? "10", 10);
    const isRanked = (params["is_ranked"] ?? "false") === "true";
    const roomCode = params["room_code"] ?? "";
    const state = {
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
function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
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
function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
    for (const presence of presences) {
        const isReconnect = state.players[presence.userId] !== undefined;
        if (isReconnect) {
            state.players[presence.userId].presence = presence;
            const reconnectPayload = buildReconnectState(state);
            dispatcher.broadcastMessage(OpCode.RECONNECT_STATE, JSON.stringify(reconnectPayload), [presence], null, true);
        }
        else {
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
    return { state };
}
function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
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
    return { state };
}
function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
    for (const message of messages) {
        const opCode = message.opCode;
        if (opCode === OpCode.GUESS_SUBMIT && state.phase === MatchPhase.GUESSING) {
            const payload = JSON.parse(nk.binaryToString(message.data));
            const player = state.players[message.sender.userId];
            if (player && player.isAlive && player.guessValue === -1) {
                const value = Math.max(0, Math.min(100, Math.floor(payload.value)));
                player.guessValue = value;
                player.guessTime = tick;
                logger.info("Guess received from %s: %d", message.sender.userId, value);
            }
        }
        if (opCode === OpCode.CHAT_MESSAGE) {
            const payload = JSON.parse(nk.binaryToString(message.data));
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
            const payload = JSON.parse(nk.binaryToString(message.data));
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
        return { state };
    }
    if (state.phase === MatchPhase.COUNTDOWN) {
        if (state.roundTick >= COUNTDOWN_TICKS) {
            state.phase = MatchPhase.GUESSING;
            state.roundTick = 0;
        }
        return { state };
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
        return { state };
    }
    if (state.phase === MatchPhase.REVEALING) {
        if (state.roundTick >= REVEAL_TICKS) {
            if (checkGameOver(state, dispatcher)) {
                state.phase = MatchPhase.GAME_OVER;
                return { state };
            }
            state.phase = MatchPhase.NEXT_ROUND;
            state.roundTick = 0;
        }
        return { state };
    }
    if (state.phase === MatchPhase.NEXT_ROUND) {
        if (state.roundTick >= NEXT_ROUND_TICKS) {
            startNewRound(state, dispatcher);
        }
        return { state };
    }
    if (state.phase === MatchPhase.GAME_OVER) {
        return null;
    }
    return { state };
}
function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    logger.info("Match terminated");
    broadcastMessage(dispatcher, state.players, OpCode.GAME_OVER, {
        winnerId: null,
        winnerUsername: null,
        terminated: true,
    });
    return { state };
}
function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
    return { state };
}

const LEAGUE_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const ELO_K_FACTOR = 32;
const BASE_ELO = 1000;
const LEADERBOARD_ID = "meanfall_ranked";
function getLeague(elo) {
    if (elo < 1100)
        return LEAGUE_TIERS[0];
    if (elo < 1300)
        return LEAGUE_TIERS[1];
    if (elo < 1600)
        return LEAGUE_TIERS[2];
    if (elo < 2000)
        return LEAGUE_TIERS[3];
    return LEAGUE_TIERS[4];
}
function expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}
function newElo(current, expected, actual) {
    return Math.max(0, Math.round(current + ELO_K_FACTOR * (actual - expected)));
}
function updateRankings(nk, logger, winnerIds, allPlayerIds) {
    const loserIds = allPlayerIds.filter((id) => !winnerIds.includes(id));
    for (const winnerId of winnerIds) {
        for (const loserId of loserIds) {
            const winnerRecord = nk.storageRead([
                { collection: "rankings", key: "elo", userId: winnerId },
            ]);
            const loserRecord = nk.storageRead([
                { collection: "rankings", key: "elo", userId: loserId },
            ]);
            const winnerElo = winnerRecord.length > 0
                ? winnerRecord[0].value.elo ?? BASE_ELO
                : BASE_ELO;
            const loserElo = loserRecord.length > 0
                ? loserRecord[0].value.elo ?? BASE_ELO
                : BASE_ELO;
            const expectedWinner = expectedScore(winnerElo, loserElo);
            const expectedLoser = expectedScore(loserElo, winnerElo);
            const newWinnerElo = newElo(winnerElo, expectedWinner, 1);
            const newLoserElo = newElo(loserElo, expectedLoser, 0);
            nk.storageWrite([
                {
                    collection: "rankings",
                    key: "elo",
                    userId: winnerId,
                    value: { elo: newWinnerElo, league: getLeague(newWinnerElo) },
                    permissionRead: 2,
                    permissionWrite: 0,
                },
                {
                    collection: "rankings",
                    key: "elo",
                    userId: loserId,
                    value: { elo: newLoserElo, league: getLeague(newLoserElo) },
                    permissionRead: 2,
                    permissionWrite: 0,
                },
            ]);
            nk.leaderboardRecordWrite(LEADERBOARD_ID, winnerId, undefined, newWinnerElo, undefined, {});
            nk.leaderboardRecordWrite(LEADERBOARD_ID, loserId, undefined, newLoserElo, undefined, {});
            logger.info("ELO updated: %s %d->%d | %s %d->%d", winnerId, winnerElo, newWinnerElo, loserId, loserElo, newLoserElo);
        }
    }
}
function rpcGetPlayerRank(ctx, logger, nk, payload) {
    const record = nk.storageRead([
        { collection: "rankings", key: "elo", userId: ctx.userId || "" },
    ]);
    const elo = record.length > 0 ? record[0].value.elo ?? BASE_ELO : BASE_ELO;
    const league = getLeague(elo);
    return JSON.stringify({ elo, league });
}
function rpcGetLeaderboard(ctx, logger, nk, payload) {
    const params = JSON.parse(payload || "{}");
    const limit = Math.min(params.limit ?? 20, 100);
    const records = nk.leaderboardRecordsList(LEADERBOARD_ID, [], limit, undefined, 0);
    const result = (records.records ?? []).map((r, i) => ({
        rank: i + 1,
        userId: r.ownerId,
        username: r.username,
        elo: r.score,
        league: getLeague(r.score),
    }));
    return JSON.stringify({ records: result });
}
function initLeaderboard(nk, logger) {
    try {
        nk.leaderboardCreate(LEADERBOARD_ID, false, "descending" /* nkruntime.SortOrder.DESCENDING */, "set" /* nkruntime.Operator.SET */, undefined, {});
        logger.info("Leaderboard '%s' initialized", LEADERBOARD_ID);
    }
    catch {
        logger.info("Leaderboard '%s' already exists", LEADERBOARD_ID);
    }
}

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_COLLECTION = "custom_rooms";
function generateRoomCode() {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
}
function ensureUniqueCode(nk, logger) {
    let code = generateRoomCode();
    let attempts = 0;
    while (attempts < 10) {
        const existing = nk.storageRead([
            { collection: ROOM_COLLECTION, key: code, userId: "" },
        ]);
        if (existing.length === 0)
            return code;
        code = generateRoomCode();
        attempts++;
    }
    logger.warn("Room code collision after %d attempts", attempts);
    return code;
}
function rpcCreateCustomRoom(ctx, logger, nk, payload) {
    const params = JSON.parse(payload || "{}");
    const maxPlayers = Math.min(Math.max(parseInt(params.max_players ?? "4", 10), 2), 10);
    const maxLives = Math.min(Math.max(parseInt(params.max_lives ?? "10", 10), 1), 10);
    const botCount = Math.min(Math.max(parseInt(params.bot_count ?? "0", 10), 0), maxPlayers - 1);
    const roomCode = ensureUniqueCode(nk, logger);
    const matchId = nk.matchCreate("meanfall_match", {
        max_players: String(maxPlayers),
        max_lives: String(maxLives),
        is_ranked: "false",
        room_code: roomCode,
        bot_count: String(botCount),
    });
    nk.storageWrite([
        {
            collection: ROOM_COLLECTION,
            key: roomCode,
            userId: "",
            value: {
                matchId,
                creatorId: ctx.userId,
                maxPlayers,
                maxLives,
                botCount,
                createdAt: Date.now(),
            },
            permissionRead: 2,
            permissionWrite: 0,
        },
    ]);
    logger.info("Custom room created: code=%s matchId=%s", roomCode, matchId);
    return JSON.stringify({ roomCode, matchId });
}
function rpcJoinCustomRoom(ctx, logger, nk, payload) {
    const params = JSON.parse(payload || "{}");
    const roomCode = String(params.room_code ?? "").toUpperCase().trim();
    if (!roomCode) {
        throw new Error("room_code is required");
    }
    const records = nk.storageRead([
        { collection: ROOM_COLLECTION, key: roomCode, userId: "" },
    ]);
    if (records.length === 0) {
        throw new Error("Room not found: " + roomCode);
    }
    const room = records[0].value;
    logger.info("Player %s joining room %s (matchId=%s)", ctx.userId, roomCode, room.matchId);
    return JSON.stringify({ matchId: room.matchId, roomCode });
}
function rpcFindOrCreateRankedMatch(ctx, logger, nk, payload) {
    const matchId = nk.matchCreate("meanfall_match", {
        max_players: "10",
        max_lives: "10",
        is_ranked: "true",
        room_code: "",
    });
    logger.info("Ranked match created: %s", matchId);
    return JSON.stringify({ matchId });
}

function InitModule(ctx, logger, nk, initializer) {
    logger.info("MEANFALL module initializing...");
    initLeaderboard(nk, logger);
    initializer.registerMatch("meanfall_match", {
        matchInit: matchInit,
        matchJoinAttempt: matchJoinAttempt,
        matchJoin: matchJoin,
        matchLeave: matchLeave,
        matchLoop: matchLoop,
        matchTerminate: matchTerminate,
        matchSignal: matchSignal,
    });
    initializer.registerRpc("get_player_rank", rpcGetPlayerRank);
    initializer.registerRpc("get_leaderboard", rpcGetLeaderboard);
    initializer.registerRpc("create_custom_room", rpcCreateCustomRoom);
    initializer.registerRpc("join_custom_room", rpcJoinCustomRoom);
    initializer.registerRpc("find_or_create_ranked_match", rpcFindOrCreateRankedMatch);
}
;
