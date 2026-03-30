const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_COLLECTION = "custom_rooms";
const RANKED_QUEUE_COLLECTION = "ranked_queue";
const RANKED_QUEUE_KEY = "current";
const RANKED_MAX_PLAYERS = 3;
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

function generateRoomCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
}

function ensureUniqueCode(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger
): string {
    let code = generateRoomCode();
    let attempts = 0;
    while (attempts < 10) {
        const existing = nk.storageRead([
            { collection: ROOM_COLLECTION, key: code, userId: "" },
        ]);
        if (existing.length === 0) return code;
        code = generateRoomCode();
        attempts++;
    }
    logger.warn("Room code collision after %d attempts", attempts);
    return code;
}

export function rpcCreateCustomRoom(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
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

export function rpcJoinCustomRoom(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
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

    const room = records[0].value as any;
    const matchId = String(room.matchId ?? "");
    if (matchId === "") {
        nk.storageDelete([
            { collection: ROOM_COLLECTION, key: roomCode, userId: "" },
        ]);
        return JSON.stringify({ error: "Room not found: " + roomCode });
    }
    try {
        const match = nk.matchGet(matchId);
        if (!match) {
            nk.storageDelete([
                { collection: ROOM_COLLECTION, key: roomCode, userId: "" },
            ]);
            return JSON.stringify({ error: "Room not found: " + roomCode });
        }
    } catch (e) {
        nk.storageDelete([
            { collection: ROOM_COLLECTION, key: roomCode, userId: "" },
        ]);
        return JSON.stringify({ error: "Room not found: " + roomCode });
    }
    logger.info("Player %s joining room %s (matchId=%s)", ctx.userId, roomCode, matchId);

    return JSON.stringify({ matchId: matchId, roomCode: roomCode });
}

export function rpcFindOrCreateRankedMatch(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const records = nk.storageRead([
        { collection: RANKED_QUEUE_COLLECTION, key: RANKED_QUEUE_KEY, userId: SYSTEM_USER_ID },
    ]);
    if (records.length > 0) {
        try {
            const queue = records[0].value as any;
            const matchId = String(queue.matchId ?? "");
            if (matchId !== "") {
                const match = nk.matchGet(matchId);
                if (match) {
                    const labelData = JSON.parse(match.label || "{}");
                    if (
                        labelData.isRanked === true &&
                        labelData.phase === "waiting" &&
                        Number(labelData.playerCount ?? 0) < Number(labelData.maxPlayers ?? RANKED_MAX_PLAYERS)
                    ) {
                        return JSON.stringify({ matchId: matchId });
                    }
                }
            }
        } catch (e) {
        }
        nk.storageDelete([
            { collection: RANKED_QUEUE_COLLECTION, key: RANKED_QUEUE_KEY, userId: SYSTEM_USER_ID },
        ]);
    }

    const matchId = nk.matchCreate("meanfall_match", {
        max_players: String(RANKED_MAX_PLAYERS),
        max_lives: "10",
        is_ranked: "true",
        room_code: "",
    });

    nk.storageWrite([
        {
            collection: RANKED_QUEUE_COLLECTION,
            key: RANKED_QUEUE_KEY,
            userId: SYSTEM_USER_ID,
            value: {
                matchId: matchId,
                createdAt: Date.now(),
            },
            permissionRead: 0,
            permissionWrite: 0,
        },
    ]);

    return JSON.stringify({ matchId: matchId });
}

export function rpcCheckActiveMatch(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const records = nk.storageRead([{
        collection: "active_match",
        key: "current",
        userId: ctx.userId || "",
    }]);

    if (records.length === 0) {
        return JSON.stringify({});
    }

    const data = records[0].value as any;
    const matchId: string = data.matchId;

    try {
        const match = nk.matchGet(matchId);
        if (match && match.size !== undefined) {
            return JSON.stringify({ matchId: matchId });
        }
    } catch (e) {
    }

    nk.storageDelete([{
        collection: "active_match",
        key: "current",
        userId: ctx.userId || "",
    }]);

    return JSON.stringify({});
}
