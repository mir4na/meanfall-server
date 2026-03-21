'use strict';

const OpCode = {
    ROUND_START: 1,
    GUESS_SUBMIT: 2,
    ROUND_RESULT: 3,
    GAME_OVER: 4,
    CHAT_MESSAGE: 5,
    PLAYER_JOINED: 6,
    PLAYER_LEFT: 7,
    RECONNECT_STATE: 9,
};
const RoundEventType = {
    DOUBLE_DAMAGE: "double_damage",
    LIFE_STEAL: "life_steal",
    CHAOS_ROLL: "chaos_roll",
    REVERSE_OUTCOME: "reverse_outcome",
    DOUBLE_GUESS: "double_guess",
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

const LEAGUE_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const BASE_POINTS = 1000;
const LEADERBOARD_ID = "meanfall_ranked";
function getLeague(points) {
    if (points < 1500)
        return LEAGUE_TIERS[0];
    if (points < 3000)
        return LEAGUE_TIERS[1];
    if (points < 6000)
        return LEAGUE_TIERS[2];
    if (points < 10000)
        return LEAGUE_TIERS[3];
    return LEAGUE_TIERS[4];
}
function updateMatchResults(nk, logger, rankedPlayers, durationSeconds) {
    const timestamp = Date.now();
    const matchId = Math.random().toString(36).substring(2, 15);
    for (const p of rankedPlayers) {
        const pointsGained = Math.max(0, 110 - p.rank * 10);
        const record = nk.storageRead([{ collection: "rankings", key: "stats", userId: p.userId }]);
        const currentStats = record.length > 0 ? record[0].value : {
            totalPoints: BASE_POINTS,
            totalMatches: 0,
            wins: 0,
            totalPlaytimeSec: 0,
        };
        const newPoints = currentStats.totalPoints + pointsGained;
        const isWin = p.rank === 1;
        const updatedStats = {
            totalPoints: newPoints,
            totalMatches: currentStats.totalMatches + 1,
            wins: currentStats.wins + (isWin ? 1 : 0),
            totalPlaytimeSec: (currentStats.totalPlaytimeSec || 0) + durationSeconds,
            lastPlayed: timestamp,
            winrate: ((currentStats.wins + (isWin ? 1 : 0)) / (currentStats.totalMatches + 1)).toFixed(2),
        };
        nk.storageWrite([
            {
                collection: "rankings",
                key: "stats",
                userId: p.userId,
                value: updatedStats,
                permissionRead: 2,
                permissionWrite: 0,
            },
        ]);
        nk.leaderboardRecordWrite(LEADERBOARD_ID, p.userId, p.username, newPoints, undefined, {});
        const historyKey = `${timestamp}_${matchId}`;
        nk.storageWrite([
            {
                collection: "match_history",
                key: historyKey,
                userId: p.userId,
                value: {
                    matchId: matchId,
                    timestamp: timestamp,
                    rank: p.rank,
                    pointsGained: pointsGained,
                    durationSeconds: durationSeconds,
                },
                permissionRead: 2,
                permissionWrite: 0,
            },
        ]);
        logger.info("Player %s updated: Rank %d, +%d points, New Total: %d", p.userId, p.rank, pointsGained, newPoints);
    }
}
function rpcGetPlayerStats(ctx, logger, nk, payload) {
    const record = nk.storageRead([{ collection: "rankings", key: "stats", userId: ctx.userId || "" }]);
    if (record.length === 0) {
        return JSON.stringify({
            totalPoints: BASE_POINTS,
            totalMatches: 0,
            wins: 0,
            winrate: "0.00",
            league: LEAGUE_TIERS[0],
            totalPlaytimeSec: 0,
        });
    }
    const stats = record[0].value;
    stats.league = getLeague(stats.totalPoints);
    return JSON.stringify(stats);
}
function rpcGetMatchHistory(ctx, logger, nk, payload) {
    const userId = ctx.userId || "";
    const records = nk.storageList(userId, "match_history", 10);
    return JSON.stringify({ matches: (records.objects || []).map(o => o.value) });
}
function rpcGetLeaderboard(ctx, logger, nk, payload) {
    const params = JSON.parse(payload || "{}");
    const limit = Math.min(params.limit ?? 20, 100);
    const records = nk.leaderboardRecordsList(LEADERBOARD_ID, [], limit, undefined, 0);
    const result = (records.records ?? []).map((r, i) => ({
        rank: i + 1,
        userId: r.ownerId,
        username: r.username,
        points: r.score,
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

const TICK_RATE = 5;
const GUESS_TICKS = 30 * TICK_RATE;
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const REVEAL_TICKS = 5 * TICK_RATE;
const NEXT_ROUND_TICKS = 2 * TICK_RATE;
const CHAOS_ROLL_TICKS = 5 * TICK_RATE;
const ROUNDS_BEFORE_DOUBLE_DAMAGE = 5;
const MIN_PLAYERS_TO_START = 3;
function calculateAverage(players) {
    const alive = Object.values(players).filter((p) => p.isAlive && p.guessValue !== -1);
    if (alive.length === 0)
        return 0;
    let sum = 0;
    let count = 0;
    for (const p of alive) {
        if (Array.isArray(p.guessValue)) {
            for (const v of p.guessValue) {
                sum += v;
                count++;
            }
        }
        else {
            sum += p.guessValue;
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}
function getBestGuess(guess, target) {
    if (Array.isArray(guess)) {
        if (guess.length === 0)
            return -1;
        if (guess.length === 1)
            return guess[0];
        const diff0 = Math.abs(guess[0] - target);
        const diff1 = Math.abs(guess[1] - target);
        return diff0 < diff1 ? guess[0] : guess[1];
    }
    return guess;
}
function findWinners(players, target, isReverse) {
    const alive = Object.values(players).filter((p) => p.isAlive && p.guessValue !== -1);
    if (alive.length === 0)
        return [];
    let bestLimit = isReverse ? -Infinity : Infinity;
    for (const p of alive) {
        const bestG = getBestGuess(p.guessValue, target);
        const diff = Math.abs(bestG - target);
        if (isReverse) {
            if (diff > bestLimit)
                bestLimit = diff;
        }
        else {
            if (diff < bestLimit)
                bestLimit = diff;
        }
    }
    const tied = alive.filter((p) => {
        const bestG = getBestGuess(p.guessValue, target);
        return Math.abs(bestG - target) === bestLimit;
    });
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
function assignRandomEvent() {
    const types = Object.values(RoundEventType).filter((t) => t !== RoundEventType.NONE);
    return types[Math.floor(Math.random() * types.length)];
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
    const isReverse = state.activeEvent === RoundEventType.REVERSE_OUTCOME;
    const winnerIds = findWinners(state.players, target, isReverse);
    const loserIds = alivePlayers
        .map((p) => p.userId)
        .filter((id) => !winnerIds.includes(id));
    let baseDamage = state.activeEvent === RoundEventType.DOUBLE_DAMAGE ? 2 : 1;
    if (state.roundNumber > ROUNDS_BEFORE_DOUBLE_DAMAGE) {
        baseDamage = 2;
    }
    const playerResults = {};
    for (const playerId in state.players) {
        const player = state.players[playerId];
        let livesLost = 0;
        if (player.isAlive) {
            if (winnerIds.includes(playerId)) {
                if (state.activeEvent === RoundEventType.LIFE_STEAL) {
                    player.lives = Math.min(state.maxLives, player.lives + 1);
                }
            }
            else if (loserIds.includes(playerId)) {
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
function checkGameOver(state, dispatcher, nk, logger) {
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
        return true;
    }
    return false;
}
function startNewRound(state, dispatcher) {
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
            state.players[presence.userId].isAfk = false;
            const reconnectPayload = buildReconnectState(state);
            dispatcher.broadcastMessage(OpCode.RECONNECT_STATE, JSON.stringify(reconnectPayload), [presence], null, true);
        }
        else {
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
            dispatcher.broadcastMessage(OpCode.RECONNECT_STATE, JSON.stringify(reconnectPayload), [presence], null, true);
            broadcastMessage(dispatcher, state.players, OpCode.PLAYER_JOINED, {
                userId: presence.userId,
                username: presence.username,
                lives: state.maxLives,
            });
        }
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
        }
    }
    return { state: state };
}
function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
    for (const message of messages) {
        const opCode = message.opCode;
        if (opCode === OpCode.GUESS_SUBMIT && state.phase === MatchPhase.GUESSING && state.activeEvent !== RoundEventType.CHAOS_ROLL) {
            const payload = JSON.parse(nk.binaryToString(message.data));
            const player = state.players[message.sender.userId];
            if (player && player.isAlive && player.guessValue === -1) {
                let formattedValue;
                if (Array.isArray(payload.value)) {
                    formattedValue = payload.value.map(v => Math.max(0, Math.min(100, Math.floor(v))));
                }
                else {
                    formattedValue = Math.max(0, Math.min(100, Math.floor(payload.value)));
                }
                player.guessValue = formattedValue;
                player.guessTime = tick;
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
    }
    state.roundTick += 1;
    if (state.phase === MatchPhase.WAITING) {
        const readyCount = Object.values(state.players).filter((p) => p.isAlive).length;
        if (readyCount >= MIN_PLAYERS_TO_START) {
            if (state.roundTick >= 5) {
                startNewRound(state, dispatcher);
            }
        }
        else {
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
        }
        if (allGuessed || isTimeUp || isChaosReady) {
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
function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
    broadcastMessage(dispatcher, state.players, OpCode.GAME_OVER, {
        winnerId: null,
        winnerUsername: null,
        terminated: true,
    });
    return { state: state };
}
function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
    return { state: state };
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
                matchId: matchId,
                creatorId: ctx.userId,
                maxPlayers: maxPlayers,
                maxLives: maxLives,
                botCount: botCount,
                createdAt: Date.now(),
            },
            permissionRead: 2,
            permissionWrite: 0,
        },
    ]);
    logger.info("Custom room created: code=%s matchId=%s", roomCode, matchId);
    return JSON.stringify({ roomCode: roomCode, matchId: matchId });
}
function rpcJoinCustomRoom(ctx, logger, nk, payload) {
    const params = JSON.parse(payload || "{}");
    const roomCode = String(params.room_code ?? "").toUpperCase().trim();
    if (!roomCode) {
        return JSON.stringify({ error: "room_code is required" });
    }
    const records = nk.storageRead([
        { collection: ROOM_COLLECTION, key: roomCode, userId: "" },
    ]);
    if (records.length === 0) {
        return JSON.stringify({ error: "Room not found: " + roomCode });
    }
    const room = records[0].value;
    logger.info("Player %s joining room %s (matchId=%s)", ctx.userId, roomCode, room.matchId);
    return JSON.stringify({ matchId: room.matchId, roomCode: roomCode });
}
function rpcFindOrCreateRankedMatch(ctx, logger, nk, payload) {
    const limit = 100;
    const authoritative = true;
    const matches = nk.matchList(limit, authoritative, null, 0, 9);
    for (const match of matches) {
        try {
            const labelData = JSON.parse(match.label || "{}");
            if (labelData.isRanked === true) {
                return JSON.stringify({ matchId: match.matchId });
            }
        }
        catch (e) {
        }
    }
    const matchId = nk.matchCreate("meanfall_match", {
        max_players: "10",
        max_lives: "10",
        is_ranked: "true",
        room_code: "",
    });
    return JSON.stringify({ matchId: matchId });
}

const OTP_EXPIRY_MS = 300000;
function rpcSendOtp(ctx, logger, nk, payload) {
    const input = JSON.parse(payload);
    const email = input.email;
    if (!email) {
        return JSON.stringify({ error: "Email is required" });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + OTP_EXPIRY_MS;
    const storageWrite = {
        collection: "otps",
        key: email,
        userId: "00000000-0000-0000-0000-000000000000",
        value: { otp: otp, expiry: expiry },
        permissionRead: 0,
        permissionWrite: 0,
    };
    nk.storageWrite([storageWrite]);
    logger.info("OTP for %s: %s", email, otp);
    const mailerUrl = "http://mailer:3000/send";
    const mailerHeaders = { "Content-Type": "application/json" };
    const mailerBody = JSON.stringify({ to: email, otp: otp });
    try {
        nk.httpRequest(mailerUrl, "post", mailerHeaders, mailerBody);
    }
    catch (e) {
        // We log the error but don't block the client from proceeding,
        // in case the mail service is down but they can read the OTP from logs.
        logger.error("Failed to contact mailer service: %s", e.message);
    }
    return JSON.stringify({ success: true });
}
function rpcVerifyOtp(ctx, logger, nk, payload) {
    const input = JSON.parse(payload);
    const email = input.email;
    const otp = input.otp;
    if (!email || !otp) {
        return JSON.stringify({ error: "Email and OTP are required" });
    }
    const storageRead = {
        collection: "otps",
        key: email,
        userId: "00000000-0000-0000-0000-000000000000",
    };
    const results = nk.storageRead([storageRead]);
    if (results.length === 0) {
        return JSON.stringify({ error: "OTP expired or not found" });
    }
    const data = results[0].value;
    if (Date.now() > data.expiry) {
        return JSON.stringify({ error: "OTP expired" });
    }
    if (data.otp !== otp) {
        return JSON.stringify({ error: "Invalid OTP" });
    }
    return JSON.stringify({ success: true });
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
    initializer.registerRpc("get_player_stats", rpcGetPlayerStats);
    initializer.registerRpc("get_match_history", rpcGetMatchHistory);
    initializer.registerRpc("get_leaderboard", rpcGetLeaderboard);
    initializer.registerRpc("create_custom_room", rpcCreateCustomRoom);
    initializer.registerRpc("join_custom_room", rpcJoinCustomRoom);
    initializer.registerRpc("find_or_create_ranked_match", rpcFindOrCreateRankedMatch);
    initializer.registerRpc("send_otp", rpcSendOtp);
    initializer.registerRpc("verify_otp", rpcVerifyOtp);
}
;
