const LEAGUE_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const BASE_POINTS = 1000;
const LEADERBOARD_ID = "meanfall_ranked";

function getLeague(points: number): string {
    if (points < 1500) return LEAGUE_TIERS[0];
    if (points < 3000) return LEAGUE_TIERS[1];
    if (points < 6000) return LEAGUE_TIERS[2];
    if (points < 10000) return LEAGUE_TIERS[3];
    return LEAGUE_TIERS[4];
}

export function updateMatchResults(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    rankedPlayers: { userId: string; username: string; rank: number }[],
    durationSeconds: number
): void {
    const timestamp = Date.now();
    const matchId = Math.random().toString(36).substring(2, 15);

    for (const p of rankedPlayers) {
        const pointsGained = Math.max(0, 110 - p.rank * 10);

        const record = nk.storageRead([{ collection: "rankings", key: "stats", userId: p.userId }]);
        const currentStats = record.length > 0 ? (record[0].value as any) : {
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

export function rpcGetPlayerStats(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
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
    const stats = record[0].value as any;
    stats.league = getLeague(stats.totalPoints);
    return JSON.stringify(stats);
}

export function rpcGetMatchHistory(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const userId = ctx.userId || "";
    const records = nk.storageList(userId, "match_history", 10);
    return JSON.stringify({ matches: (records.objects || []).map(o => o.value) });
}

export function rpcGetLeaderboard(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const params = JSON.parse(payload || "{}");
    const limit = Math.min(params.limit ?? 20, 100);

    const records = nk.leaderboardRecordsList(LEADERBOARD_ID, [], limit, undefined, 0);

    const result = (records.records ?? []).map((r, i) => ({
        rank: i + 1,
        userId: r.ownerId,
        username: r.username,
        points: r.score,
        league: getLeague(r.score as number),
    }));

    return JSON.stringify({ records: result });
}

export function initLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
    try {
        nk.leaderboardCreate(LEADERBOARD_ID, false, nkruntime.SortOrder.DESCENDING, nkruntime.Operator.SET, undefined, {});
        logger.info("Leaderboard '%s' initialized", LEADERBOARD_ID);
    } catch {
        logger.info("Leaderboard '%s' already exists", LEADERBOARD_ID);
    }
}
