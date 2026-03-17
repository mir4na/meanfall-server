const LEAGUE_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const ELO_K_FACTOR = 32;
const BASE_ELO = 1000;
const LEADERBOARD_ID = "meanfall_ranked";

function getLeague(elo: number): string {
    if (elo < 1100) return LEAGUE_TIERS[0];
    if (elo < 1300) return LEAGUE_TIERS[1];
    if (elo < 1600) return LEAGUE_TIERS[2];
    if (elo < 2000) return LEAGUE_TIERS[3];
    return LEAGUE_TIERS[4];
}

function expectedScore(ratingA: number, ratingB: number): number {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function newElo(current: number, expected: number, actual: number): number {
    return Math.max(0, Math.round(current + ELO_K_FACTOR * (actual - expected)));
}

export function updateRankings(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    winnerIds: string[],
    allPlayerIds: string[]
): void {
    const loserIds = allPlayerIds.filter((id) => !winnerIds.includes(id));

    for (const winnerId of winnerIds) {
        for (const loserId of loserIds) {
            const winnerRecord = nk.storageRead([
                { collection: "rankings", key: "elo", userId: winnerId },
            ]);
            const loserRecord = nk.storageRead([
                { collection: "rankings", key: "elo", userId: loserId },
            ]);

            const winnerElo: number =
                winnerRecord.length > 0
                    ? (winnerRecord[0].value as any).elo ?? BASE_ELO
                    : BASE_ELO;
            const loserElo: number =
                loserRecord.length > 0
                    ? (loserRecord[0].value as any).elo ?? BASE_ELO
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

            nk.leaderboardRecordWrite(
                LEADERBOARD_ID,
                winnerId,
                undefined,
                newWinnerElo,
                undefined,
                {}
            );
            nk.leaderboardRecordWrite(
                LEADERBOARD_ID,
                loserId,
                undefined,
                newLoserElo,
                undefined,
                {}
            );

            logger.info(
                "ELO updated: %s %d->%d | %s %d->%d",
                winnerId, winnerElo, newWinnerElo,
                loserId, loserElo, newLoserElo
            );
        }
    }
}

export function rpcGetPlayerRank(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const record = nk.storageRead([
        { collection: "rankings", key: "elo", userId: ctx.userId || "" },
    ]);

    const elo = record.length > 0 ? (record[0].value as any).elo ?? BASE_ELO : BASE_ELO;
    const league = getLeague(elo);

    return JSON.stringify({ elo, league });
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
        elo: r.score,
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
